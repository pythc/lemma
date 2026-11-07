"""Local kernel-backed shared/exclusive lease, owned by the parent's stdin pipe.

Never unlink the lock file: concurrent opens must refer to the same inode.
No heartbeat or stale-time takeover can evict a live or paused holder.
"""
import fcntl
import json
import os
import select
import stat
import sys


def main():
    filename, mode = sys.argv[1:]
    if mode not in ("read", "write"):
        raise ValueError("Invalid library lease mode")
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(filename, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Library lock is not a regular file")
        operation = fcntl.LOCK_SH if mode == "read" else fcntl.LOCK_EX
        while True:
            # Detect a dead owner even while waiting for another process.
            if select.select([sys.stdin.buffer], [], [], 0)[0]:
                if not os.read(sys.stdin.fileno(), 1):
                    return
                raise ValueError("Unexpected lease input")
            try:
                fcntl.flock(fd, operation | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                select.select([sys.stdin.buffer], [], [], 0.05)
        print(json.dumps({"acquired": True, "mode": mode, "pid": os.getpid()}),
              flush=True)
        # EOF means the parent released the lease or exited unexpectedly.
        if sys.stdin.buffer.read(1):
            raise ValueError("Unexpected lease input")
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr, flush=True)
        sys.exit(1)
