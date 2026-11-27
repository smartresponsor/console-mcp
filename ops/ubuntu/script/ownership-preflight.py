#!/usr/bin/env python3
"""Read-only inode-pinned preflight for ENG-16. No privilege elevation."""
import argparse
import os
import stat
import sys

class UnsafePath(Exception):
    pass

def walk(root):
    """Open each path component without following symlinks, pinning descriptors."""
    if not os.path.isabs(root):
        raise UnsafePath("absolute path required")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        for component in root.split("/"):
            if not component:
                continue
            if component in (".", ".."):
                raise UnsafePath("relative component")
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise

def inspect(root, max_entries=10000):
    base = walk(root)
    opened = [base]
    seen = set()
    count = 0
    try:
        device = os.fstat(base).st_dev
        pending = [base]
        while pending:
            current = pending.pop()
            info = os.fstat(current)
            if (info.st_dev, info.st_ino) in seen:
                raise UnsafePath("repeated inode")
            seen.add((info.st_dev, info.st_ino))
            for name in os.listdir(current):
                count += 1
                if count > max_entries:
                    raise UnsafePath("entry limit")
                st = os.stat(name, dir_fd=current, follow_symlinks=False)
                if st.st_dev != device:
                    raise UnsafePath("mount boundary")
                if stat.S_ISLNK(st.st_mode):
                    raise UnsafePath("symlink")
                if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
                    raise UnsafePath("special file")
                if stat.S_ISREG(st.st_mode) and st.st_nlink != 1:
                    raise UnsafePath("hard-linked regular file")
                if stat.S_ISDIR(st.st_mode):
                    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
                    if (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != (st.st_dev, st.st_ino):
                        os.close(fd)
                        raise UnsafePath("TOCTOU inode changed")
                    opened.append(fd)
                    pending.append(fd)
        return count
    finally:
        for fd in reversed(opened):
            os.close(fd)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("root")
    args = p.parse_args()
    try:
        print("PREFLIGHT_PASS entries=" + str(inspect(args.root)))
    except (UnsafePath, OSError) as exc:
        print("PREFLIGHT_DENIED " + str(exc), file=sys.stderr)
        return 78
    return 0

if __name__ == "__main__":
    sys.exit(main())
