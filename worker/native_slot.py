"""Host admission and worker supervision. Kernel locks are never unlinked.
The pipe owner dying kills the supervised process group before releasing a slot.
"""
import fcntl
import json
import os
import select
import signal
import subprocess
import sys
import time


def main():
    root, capacity = sys.argv[1], int(sys.argv[2])
    os.makedirs(root, mode=0o700, exist_ok=True)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(os.path.join(root, "capacity.lock"), flags, 0o600), "r+") as config:
        fcntl.flock(config, fcntl.LOCK_EX)
        saved = config.read()
        if saved and int(saved) != capacity:
            raise ValueError("Host capacity differs from established resource service")
        if not saved:
            config.write(str(capacity))
            config.flush()
    def open_slot(slot):
        return os.open(os.path.join(root, "slot-%d.lock" % slot), flags, 0o600)
    if len(sys.argv) > 3 and sys.argv[3] == "--snapshot":
        occupied = []
        for slot in range(capacity):
            probe = open_slot(slot)
            try:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                occupied.append(slot + 1)
            finally:
                os.close(probe)
        print(json.dumps({"limit": capacity, "running": len(occupied), "slots": occupied, "scope": "local_host"}))
        return
    fd = None
    request = json.loads(sys.stdin.buffer.readline())
    acquired = False
    try:
        while not acquired:
            if select.select([sys.stdin.buffer], [], [], 0)[0]:
                if not os.read(sys.stdin.fileno(), 1):
                    return
                raise ValueError("Unexpected input while queued")
            for slot in range(capacity):
                try:
                    probe = open_slot(slot)
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fd = probe
                    acquired = True
                    break
                except BlockingIOError:
                    os.close(probe)
            if not acquired:
                select.select([sys.stdin.buffer], [], [], 0.05)
        with os.fdopen(3, "w", closefd=False) as control:
            control.write(json.dumps({"event": "acquired", "slot": slot + 1, "limit": capacity}) + "\n")
            control.flush()
        if sys.stdin.buffer.readline() != b"go\n":
            return
        # An inherited flock keeps the slot owned even if the supervisor itself
        # is killed before its worker; no stale-time takeover can evict it.
        child = subprocess.Popen([request["command"], *request["args"]], stdin=subprocess.DEVNULL, pass_fds=(fd,))
        while child.poll() is None:
            if select.select([sys.stdin.buffer], [], [], 0.05)[0]:
                # The wrapper and worker share a detached group owned by Node.
                # SIGKILL of this group closes the lease only after all members die.
                os.killpg(os.getpgrp(), signal.SIGKILL)
            time.sleep(0.005)
        sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
    finally:
        if fd is not None:
            os.close(fd)


if __name__ == "__main__":
    main()
