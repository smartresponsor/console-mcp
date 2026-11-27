#!/usr/bin/env python3
"""ENG-16 multi-target ACL transaction.

ACL-only changes; no chown/chmod and no recursive path-based traversal.
All target entries are opened descriptor-relative with O_NOFOLLOW and same-device
checks. A single fsynced journal covers every target before the first mutation.
"""
import argparse
import fcntl
import json
import os
import pathlib
import resource
import stat
import subprocess
import sys

MAX_ENTRIES = 10000
ACL_PRINCIPALS = ("alex", "console-mcp")
ALLOWED_TARGETS = ["/home/alex/smartresponse/workspaces", "/home/alex/smartresponse/mcp/console-mcp/dist"]
ALLOWED_JOURNAL = "/var/lib/console-mcp-ownership/transaction.json"

class Denied(Exception):
    pass

def open_abs_dir(path):
    # Resolve absolute components without symlink traversal. Mount points in the
    # prefix are allowed; scan_target_v2 rejects mount boundaries inside targets.
    if not os.path.isabs(path):
        raise Denied("absolute path required")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        for component in path.split("/"):
            if not component:
                continue
            if component in (".", ".."):
                raise Denied("relative path component")
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise

def identity(st):
    return {"dev": st.st_dev, "ino": st.st_ino, "uid": st.st_uid, "gid": st.st_gid, "nlink": st.st_nlink}

def run_acl(binary, fd, *args, input=None):
    proc = subprocess.run([binary, *args, f"/proc/self/fd/{fd}"], input=input, text=True,
                          capture_output=True, pass_fds=(fd,), check=False)
    if proc.returncode:
        raise Denied(f"{binary} failed ({proc.returncode}): {proc.stderr.strip()}")
    return proc.stdout

def read_acl(fd):
    return run_acl("getfacl", fd, "-cp")

def mutate_acl(fd, is_dir):
    first, second = ACL_PRINCIPALS
    run_acl("setfacl", fd, "-m", f"u:{first}:rwX,u:{second}:rwX,m:rwX")
    if is_dir:
        run_acl("setfacl", fd, "-m", f"d:u:{first}:rwx,d:u:{second}:rwx,d:m:rwx")
    os.fsync(fd)
    current = read_acl(fd).splitlines()
    if not any(line.startswith(f"user:{first}:") for line in current) or not any(line.startswith(f"user:{second}:") for line in current) or not any(line.startswith("mask::") for line in current):
        raise Denied("requested access ACL entries not observed")
    if is_dir and not all(expected in current for expected in (
        f"default:user:{first}:rwx", f"default:user:{second}:rwx", "default:mask::rwx"
    )):
        raise Denied("requested default ACL entries not observed")

def restore_acl(fd, text):
    # setfacl --set-file does not remove pre-existing default ACL entries
    # when the snapshot had none; remove them explicitly before restoring.
    if not any(line.startswith("default:") for line in text.splitlines()):
        run_acl("setfacl", fd, "-k")
    run_acl("setfacl", fd, "--set-file=-", input=text)
    os.fsync(fd)

def sync_fd(fd):
    os.fsync(fd)

def entry_stat(parent_fd, name):
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None

def open_child(parent_fd, name, expected, device):
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    if stat.S_ISDIR(expected.st_mode):
        flags |= os.O_DIRECTORY
    fd = os.open(name, flags, dir_fd=parent_fd)
    current = os.fstat(fd)
    if (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino):
        os.close(fd)
        raise Denied("TOCTOU inode changed")
    if current.st_dev != device:
        os.close(fd)
        raise Denied("mount boundary")
    if not (stat.S_ISDIR(current.st_mode) or stat.S_ISREG(current.st_mode)):
        os.close(fd)
        raise Denied("special file")
    return fd

def scan_target_v2(root_path, root_fd, fd_budget):
    """Descriptor-relative DFS; each directory fd remains live until scan completes."""
    device = os.fstat(root_fd).st_dev
    nodes, fds = [], []
    stack = [(os.dup(root_fd), "")]
    fds.append(stack[0][0])
    count = 0
    try:
        while stack:
            fd, rel = stack.pop()
            st = os.fstat(fd)
            if st.st_dev != device or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                raise Denied("mount boundary or unsupported node")
            nodes.append({"rel": rel, "fd": fd, "identity": identity(st), "mode": stat.S_IMODE(st.st_mode), "mtime_ns": st.st_mtime_ns, "size": st.st_size, "acl": read_acl(fd), "is_dir": stat.S_ISDIR(st.st_mode)})
            if stat.S_ISDIR(st.st_mode):
                for name in sorted(os.listdir(fd), reverse=True):
                    count += 1
                    if count > MAX_ENTRIES:
                        raise Denied("entry limit")
                    child_st = entry_stat(fd, name)
                    if child_st is None or child_st.st_dev != device or not (stat.S_ISDIR(child_st.st_mode) or stat.S_ISREG(child_st.st_mode)):
                        raise Denied("symlink, special file, mount boundary or race")
                    if stat.S_ISREG(child_st.st_mode) and child_st.st_nlink != 1:
                        raise Denied("hard-linked regular file would escape target boundary")
                    if len(fds) >= fd_budget:
                        raise Denied("descriptor budget exceeded; reduce target tree size or raise RLIMIT_NOFILE")
                    child_fd = open_child(fd, name, child_st, device)
                    fds.append(child_fd)
                    child_rel = name if not rel else rel + "/" + name
                    stack.append((child_fd, child_rel))
        return nodes, [node["fd"] for node in nodes]
    except BaseException:
        for child_fd in reversed(fds):
            try: os.close(child_fd)
            except OSError: pass
        raise

def journal_parent(path):
    p = pathlib.Path(path)
    if not p.is_absolute() or p.name in ("", ".", ".."):
        raise Denied("absolute journal path required")
    parent_fd = open_abs_dir(str(p.parent))
    st = os.fstat(parent_fd)
    if st.st_uid != os.geteuid() or st.st_mode & 0o022:
        os.close(parent_fd)
        raise Denied("journal parent must be executor-owned and not group/world writable")
    return p.name, parent_fd

def save_at(parent_fd, name, record, create_only=False, expected_inode=None):
    temp = name + ".new"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent_fd)
    os.fchmod(fd, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            json.dump(record, stream, sort_keys=True, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
            fd = -1
    finally:
        if fd >= 0: os.close(fd)
    if create_only:
        os.link(temp, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
        os.unlink(temp, dir_fd=parent_fd)
    else:
        current = entry_stat(parent_fd, name)
        if current is None or expected_inode is None or (current.st_dev, current.st_ino) != expected_inode:
            raise Denied("journal changed before atomic update")
        os.rename(temp, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    sync_fd(parent_fd)

def load_at(parent_fd, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o600:
            raise Denied("unsafe journal metadata")
        current = entry_stat(parent_fd, name)
        if current is None or (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino):
            raise Denied("journal entry changed")
        with os.fdopen(fd, "r", encoding="utf8") as stream:
            fd = -1
            return json.load(stream), (st.st_dev, st.st_ino)
    finally:
        if fd >= 0: os.close(fd)

def clean_temp_at(parent_fd, name, journal_inode=None):
    temp_name = name + ".new"
    st = entry_stat(parent_fd, temp_name)
    if st is None:
        return
    same_as_journal = journal_inode is not None and (st.st_dev, st.st_ino) == journal_inode
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o600:
        raise Denied("unsafe journal temporary; manual review required")
    if st.st_nlink != 1 and not (same_as_journal and st.st_nlink == 2):
        raise Denied("unexpected journal temporary link count")
    fd = os.open(temp_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    try:
        current = os.fstat(fd)
        if (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino):
            raise Denied("journal temporary changed during cleanup")
    finally:
        os.close(fd)
    os.unlink(temp_name, dir_fd=parent_fd)
    sync_fd(parent_fd)

def unlink_verified(parent_fd, name, inode):
    current = entry_stat(parent_fd, name)
    if current is None or (current.st_dev, current.st_ino) != inode:
        raise Denied("journal replaced before unlink")
    os.unlink(name, dir_fd=parent_fd)
    sync_fd(parent_fd)

def open_rel(root_fd, rel, expected, device, expected_entries):
    if not rel:
        fd = os.dup(root_fd)
    else:
        fd = os.dup(root_fd)
        try:
            parts = rel.split("/")
            prefix = ""
            for i, part in enumerate(parts):
                prefix = part if not prefix else prefix + "/" + part
                st = entry_stat(fd, part)
                if st is None:
                    raise Denied("recovery entry missing")
                expected_parent = expected_entries.get(prefix)
                if expected_parent is None or (st.st_dev, st.st_ino, st.st_uid, st.st_gid, st.st_nlink) != (expected_parent["dev"], expected_parent["ino"], expected_parent["uid"], expected_parent["gid"], expected_parent["nlink"]):
                    raise Denied("recovery ancestor identity mismatch")
                child = open_child(fd, part, st, device)
                os.close(fd)
                fd = child
        except BaseException:
            os.close(fd)
            raise
    st = os.fstat(fd)
    if identity(st) != expected:
        os.close(fd)
        raise Denied("recovery inode/metadata identity mismatch")
    return fd

def collect_targets(targets):
    result, all_fds = [], []
    if len(targets) != 2 or len(set(targets)) != 2:
        raise Denied("exactly two distinct targets required")
    try:
        soft_limit = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
        fd_budget = MAX_ENTRIES if soft_limit == resource.RLIM_INFINITY else min(MAX_ENTRIES, max(16, (soft_limit - 64) // 2))
        for path in targets:
            root_fd = open_abs_dir(path)
            all_fds.append(root_fd)
            nodes, node_fds = scan_target_v2(path, root_fd, fd_budget)
            all_fds.extend(node_fds)
            result.append({"path": os.path.abspath(path), "identity": identity(os.fstat(root_fd)),
                           "nodes": [{"rel": n["rel"], "identity": n["identity"], "mode": n["mode"], "mtime_ns": n["mtime_ns"], "size": n["size"], "acl": n["acl"], "is_dir": n["is_dir"]} for n in nodes]})
        return result, all_fds
    except BaseException:
        for fd in reversed(all_fds):
            try: os.close(fd)
            except OSError: pass
        raise

def target_fd_slice(snapshot, fds, index):
    offset = sum(len(item["nodes"]) + 1 for item in snapshot[:index])
    root_fd = fds[offset]
    node_fds = fds[offset + 1:offset + 1 + len(snapshot[index]["nodes"])]
    return root_fd, node_fds

def verify_tree_shape(root_fd, target, strict_metadata=True):
    if strict_metadata:
        expected = {node["rel"]: (node["identity"], node["mtime_ns"], node["size"]) for node in target["nodes"]}
    else:
        expected = {node["rel"]: node["identity"] for node in target["nodes"]}
    observed = {}
    stack = [(os.dup(root_fd), "")]
    try:
        while stack:
            fd, rel = stack.pop()
            try:
                st = os.fstat(fd)
                if st.st_dev != target["identity"]["dev"] or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                    raise Denied("target tree mount/special-file change")
                observed[rel] = (identity(st), st.st_mtime_ns, st.st_size) if strict_metadata else identity(st)
                if stat.S_ISDIR(st.st_mode):
                    for name in sorted(os.listdir(fd), reverse=True):
                        child_st = entry_stat(fd, name)
                        if child_st is None or child_st.st_dev != target["identity"]["dev"] or not (stat.S_ISDIR(child_st.st_mode) or stat.S_ISREG(child_st.st_mode)):
                            raise Denied("target tree symlink/special/mount change")
                        if stat.S_ISREG(child_st.st_mode) and child_st.st_nlink != 1:
                            raise Denied("target tree hardlink change")
                        child_fd = open_child(fd, name, child_st, target["identity"]["dev"])
                        child_rel = name if not rel else rel + "/" + name
                        child_now = os.fstat(child_fd)
                        if stat.S_ISDIR(child_now.st_mode):
                            stack.append((child_fd, child_rel))
                        else:
                            observed[child_rel] = (identity(child_now), child_now.st_mtime_ns, child_now.st_size) if strict_metadata else identity(child_now)
                            os.close(child_fd)
            finally:
                os.close(fd)
        if observed != expected:
            raise Denied("target tree entries/metadata changed during transaction")
    except BaseException:
        for fd, _ in stack:
            try: os.close(fd)
            except OSError: pass
        raise

def verify_path_binding(snapshot, fds, strict_metadata=True):
    for index, target in enumerate(snapshot):
        root_fd, _ = target_fd_slice(snapshot, fds, index)
        current_root = open_abs_dir(target["path"])
        try:
            if identity(os.fstat(current_root)) != target["identity"]:
                raise Denied("target root path no longer names snapshotted inode")
        finally:
            os.close(current_root)
        verify_tree_shape(root_fd, target, strict_metadata=strict_metadata)

def snapshot_entries(snapshot, fds):
    for index, target in enumerate(snapshot):
        _, node_fds = target_fd_slice(snapshot, fds, index)
        yield from zip(target["nodes"], node_fds)

def verify_original_acl(node, fd):
    current = os.fstat(fd)
    if identity(current) != node["identity"] or stat.S_IMODE(current.st_mode) != node["mode"] or read_acl(fd) != node["acl"]:
        raise Denied("untouched or restored ACL/identity changed; journal preserved")

def restore_open_snapshot(snapshot, fds, attempted_count):
    entries = list(snapshot_entries(snapshot, fds))
    if type(attempted_count) is not int or not 0 <= attempted_count <= len(entries):
        raise Denied("invalid attempted entry count")
    # An intent is persisted before the first possible mutation of each entry.
    # Never restore an entry outside that exact attempted prefix.
    for node, fd in reversed(entries[:attempted_count]):
        if identity(os.fstat(fd)) != node["identity"]:
            raise Denied("attempted entry identity changed; journal preserved")
        if read_acl(fd) != node["acl"] or stat.S_IMODE(os.fstat(fd).st_mode) != node["mode"]:
            restore_acl(fd, node["acl"])
        verify_original_acl(node, fd)
    for node, fd in entries[attempted_count:]:
        verify_original_acl(node, fd)

def journal_inode_at(parent_fd, name):
    st = entry_stat(parent_fd, name)
    if st is None or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o600:
        raise Denied("journal metadata invalid; recovery required")
    return (st.st_dev, st.st_ino)

def apply_targets(targets, journal_path, inject_after=None):
    name, parent_fd = journal_parent(journal_path)
    lock_name = name + ".lock"
    lock = os.open(lock_name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent_fd)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        lst = os.fstat(lock); ent = entry_stat(parent_fd, lock_name)
        if not stat.S_ISREG(lst.st_mode) or lst.st_nlink != 1 or lst.st_uid != os.geteuid() or stat.S_IMODE(lst.st_mode) != 0o600 or ent is None or (ent.st_dev, ent.st_ino) != (lst.st_dev, lst.st_ino):
            raise Denied("unsafe or replaced lock")
        if entry_stat(parent_fd, name) is not None or entry_stat(parent_fd, name + ".new") is not None:
            raise Denied("pending journal or stale temporary; recover/manual review required")
        snapshot, fds = collect_targets(targets)
        try:
            record = {"version": 2, "state": "prepared", "attemptedCount": 0, "targets": snapshot}
            save_at(parent_fd, name, record, create_only=True)
            prepared_inode = journal_inode_at(parent_fd, name)
            mutated = 0
            attempted = 0
            journal_update_in_progress = False
            try:
                verify_path_binding(snapshot, fds)
                for target_index, target in enumerate(snapshot):
                    root_fd, target_node_fds = target_fd_slice(snapshot, fds, target_index)
                    expected_entries = {node["rel"]: node["identity"] for node in target["nodes"]}
                    for node, fd in zip(target["nodes"], target_node_fds):
                        path_fd = open_rel(root_fd, node["rel"], node["identity"], target["identity"]["dev"], expected_entries)
                        os.close(path_fd)
                        current = os.fstat(fd)
                        if identity(current) != node["identity"] or stat.S_IMODE(current.st_mode) != node["mode"] or current.st_mtime_ns != node["mtime_ns"] or current.st_size != node["size"] or read_acl(fd) != node["acl"]:
                            raise Denied("target metadata/ACL changed after snapshot")
                        # Durable write-ahead intent, including partial setfacl failure.
                        # If publication is ambiguous, leave the journal for recovery.
                        journal_update_in_progress = True
                        record["attemptedCount"] = attempted + 1
                        save_at(parent_fd, name, record, expected_inode=prepared_inode)
                        prepared_inode = journal_inode_at(parent_fd, name)
                        attempted += 1
                        journal_update_in_progress = False
                        mutate_acl(fd, node["is_dir"])
                        mutated += 1
                        # Detect path/ancestor replacement immediately after descriptor-bound mutation.
                        path_fd = open_rel(root_fd, node["rel"], node["identity"], target["identity"]["dev"], expected_entries)
                        os.close(path_fd)
                        if inject_after is not None and mutated == inject_after:
                            raise Denied("injected multi-target failure")
                verify_path_binding(snapshot, fds)
                # Record committed ACL state for deterministic crash resolution.
                for ti, target in enumerate(snapshot):
                    offset = sum(len(t["nodes"]) + 1 for t in snapshot[:ti]) + 1
                    target_fds = fds[offset:offset + len(target["nodes"])]
                    for node, fd in zip(target["nodes"], target_fds):
                        node["committed_acl"] = read_acl(fd)
                record["state"] = "committed"
                journal_update_in_progress = True
                save_at(parent_fd, name, record, expected_inode=prepared_inode)
                prepared_inode = journal_inode_at(parent_fd, name)
                journal_update_in_progress = False
                verify_path_binding(snapshot, fds)
                unlink_verified(parent_fd, name, prepared_inode)
            except BaseException:
                if journal_update_in_progress or entry_stat(parent_fd, name) is None:
                    # Atomic publication/unlink may have completed before an fsync
                    # failure. Never guess which durable intent is authoritative.
                    raise
                restore_open_snapshot(snapshot, fds, attempted)
                verify_path_binding(snapshot, fds)
                unlink_verified(parent_fd, name, prepared_inode)
                raise
            print("MULTI_TARGET_APPLY_PASS")
        finally:
            for fd in reversed(fds):
                try: os.close(fd)
                except OSError: pass
    finally:
        os.close(lock); os.close(parent_fd)

def restore_record(snapshot, targets, attempted_count):
    # Validate the complete target shape and every untouched ACL before any
    # recovery writes. Keep the original journal if independent changes remain.
    observed, fds = collect_targets(targets)
    try:
        if len(observed) != len(snapshot):
            raise Denied("recovery target count mismatch")
        for before, current in zip(snapshot, observed):
            if before["path"] != current["path"] or before["identity"] != current["identity"] or [(n["rel"], n["identity"]) for n in before["nodes"]] != [(n["rel"], n["identity"]) for n in current["nodes"]]:
                raise Denied("recovery target tree/identity changed; journal preserved")
        entries = list(snapshot_entries(snapshot, fds))
        if type(attempted_count) is not int or not 0 <= attempted_count <= len(entries):
            raise Denied("invalid attempted entry count")
        for node, fd in entries[attempted_count:]:
            verify_original_acl(node, fd)
        verify_path_binding(snapshot, fds, strict_metadata=False)
        restore_open_snapshot(snapshot, fds, attempted_count)
        verify_path_binding(snapshot, fds, strict_metadata=False)
    finally:
        for fd in reversed(fds):
            try: os.close(fd)
            except OSError: pass

def recover_targets(targets, journal_path):
    name, parent_fd = journal_parent(journal_path)
    lock_name = name + ".lock"
    lock = os.open(lock_name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent_fd)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        lst = os.fstat(lock); ent = entry_stat(parent_fd, lock_name)
        if not stat.S_ISREG(lst.st_mode) or lst.st_nlink != 1 or lst.st_uid != os.geteuid() or stat.S_IMODE(lst.st_mode) != 0o600 or ent is None or (ent.st_dev, ent.st_ino) != (lst.st_dev, lst.st_ino):
            raise Denied("unsafe or replaced lock")
        journal_entry = entry_stat(parent_fd, name)
        journal_inode = None if journal_entry is None else (journal_entry.st_dev, journal_entry.st_ino)
        clean_temp_at(parent_fd, name, journal_inode)
        if journal_entry is None:
            print("MULTI_TARGET_RECOVERY_NOT_NEEDED"); return
        record, inode = load_at(parent_fd, name)
        if record.get("version") != 2 or record.get("state") not in ("prepared", "committed"):
            raise Denied("legacy or invalid journal lacks durable attempted-entry evidence; manual review required")
        if [t["path"] for t in record["targets"]] != [os.path.abspath(t) for t in targets]:
            raise Denied("target set/order differs from journal")
        count = record.get("attemptedCount")
        total = sum(len(t["nodes"]) for t in record["targets"])
        if type(count) is not int or not 0 <= count <= total or (record["state"] == "committed" and count != total):
            raise Denied("invalid durable attempted-entry evidence")
        restore_record(record["targets"], targets, count)
        unlink_verified(parent_fd, name, inode)
        print("MULTI_TARGET_RECOVERY_PASS")
    finally:
        os.close(lock); os.close(parent_fd)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["apply", "recover"])
    parser.add_argument("--target", action="append", required=True)
    parser.add_argument("--journal", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        print("ROOT_REQUIRED", file=sys.stderr); return 77
    if [os.path.abspath(p) for p in args.target] != ALLOWED_TARGETS:
        print("MULTI_TARGET_DENIED: target allowlist mismatch", file=sys.stderr); return 78
    if os.path.abspath(args.journal) != ALLOWED_JOURNAL:
        print("MULTI_TARGET_DENIED: journal path mismatch", file=sys.stderr); return 78
    try:
        if args.action == "apply": apply_targets(args.target, args.journal)
        else: recover_targets(args.target, args.journal)
        return 0
    except Exception as exc:
        print("MULTI_TARGET_DENIED:", exc, file=sys.stderr); return 78

if __name__ == "__main__":
    sys.exit(main())
