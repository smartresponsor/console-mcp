#!/usr/bin/python3
"""Confined atomic replacement. The directory chain is held by no-follow dirfds."""
import hashlib
import json
import os
import stat
import sys
import uuid

O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

def replace(request):
    target = request["path"]
    if not isinstance(target, str) or not target.startswith("/") or "\\x00" in target:
        raise ValueError("absolute target required")
    parts = target.split("/")[1:]
    if not parts or any(p in ("", ".", "..") for p in parts):
        raise ValueError("noncanonical target")
    before = request["before_sha256"]
    updated = request["updated"]
    if not isinstance(before, str) or len(before) != 64 or not isinstance(updated, str):
        raise ValueError("invalid content")
    fd = os.open("/", O_DIR)
    temp = None
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, O_DIR, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        name = parts[-1]
        original_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        try:
            st = os.fstat(original_fd)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                raise ValueError("regular single-link file required")
            with os.fdopen(os.dup(original_fd), "rb") as stream:
                original = stream.read(16 * 1024 * 1024 + 1)
            if len(original) > 16 * 1024 * 1024 or hashlib.sha256(original).hexdigest() != before:
                raise ValueError("file content changed")
            current = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns):
                raise ValueError("file identity changed")
            temp = ".console-write-" + uuid.uuid4().hex
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
            out_fd = os.open(temp, flags, stat.S_IMODE(st.st_mode), dir_fd=fd)
            try:
                data = updated.encode("utf-8")
                with os.fdopen(out_fd, "wb", closefd=False) as out:
                    out.write(data)
                    out.flush()
                    os.fsync(out_fd)
                os.fchmod(out_fd, stat.S_IMODE(st.st_mode))
            finally:
                os.close(out_fd)
            current = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns):
                raise ValueError("file changed before commit")
            os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
            temp = None
            os.fsync(fd)
            return {"ok": True, "after_sha256": hashlib.sha256(data).hexdigest()}
        finally:
            os.close(original_fd)
    finally:
        if temp is not None:
            try:
                os.unlink(temp, dir_fd=fd)
            except FileNotFoundError:
                pass
        os.close(fd)

if __name__ == "__main__":
    try:
        req = json.load(sys.stdin)
        print(json.dumps(replace(req)))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)
