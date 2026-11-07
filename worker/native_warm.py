"""Warm child supervision: each work interval owns a host lock.
Idle children are stopped as a group before unlocking. EOF kills and reaps the
child group before releasing; a child inherits the lock across supervisor death.
Only supervisor commands from the private owner pipe can resume a child.
"""
import base64
import fcntl
import json
import os
import select
import signal
import subprocess
import sys
import time

root, capacity = sys.argv[1], int(sys.argv[2])
os.makedirs(root, mode=0o700, exist_ok=True)
flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
config = os.open(os.path.join(root, "capacity.lock"), flags, 0o600)
fcntl.flock(config, fcntl.LOCK_EX)
saved = os.read(config, 100)
if saved and int(saved) != capacity:
    raise ValueError("Host capacity mismatch")
if not saved:
    os.write(config, str(capacity).encode())
os.close(config)
control = os.fdopen(3, "w", buffering=1)
fd = None
slot = None
child = None
active = False
buffer = b""
settings = None
pending = b""
peak_rss_bytes = 0
last_memory_check = 0


def emit(event, **values):
    control.write(json.dumps(dict(event=event, **values)) + "\n")


def alive_group():
    if child is None:
        return []
    text = subprocess.check_output(["/bin/ps", "-axo", "pid=,pgid=,stat="], text=True)
    rows = [line.split() for line in text.splitlines()]
    return [r for r in rows if len(r) == 3 and r[1] == str(child.pid) and not r[2].startswith("Z")]


def stop_group():
    os.killpg(child.pid, signal.SIGSTOP)
    deadline = time.monotonic() + 5
    while True:
        rows = alive_group()
        if rows and all("T" in r[2] for r in rows):
            return
        if not rows or time.monotonic() > deadline:
            raise RuntimeError("Warm group did not acknowledge stopped state")
        time.sleep(0.01)


def acquire():
    global fd, slot, active, child
    if active:
        raise ValueError("Already executing")
    while True:
        choices = [slot] if slot is not None else range(capacity)
        for candidate in choices:
            probe = fd if fd is not None else os.open(os.path.join(root, "slot-%d.lock" % candidate), flags, 0o600)
            try:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fd, slot = probe, candidate
                active = True
                if child is None:
                    child = subprocess.Popen([settings["command"], *settings["args"]],
                                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                             pass_fds=(fd,), start_new_session=True, bufsize=0)
                    for stream in [child.stdout, child.stderr, child.stdin]:
                        os.set_blocking(stream.fileno(), False)
                else:
                    if child.poll() is not None:
                        raise RuntimeError("Warm child exited")
                    os.killpg(child.pid, signal.SIGCONT)
                birth = subprocess.check_output(["/bin/ps", "-p", str(child.pid), "-o", "lstart="], text=True).strip()
                emit("acquired", slot=slot+1, pid=child.pid, birth=birth)
                return
            except BlockingIOError:
                if fd is None:
                    os.close(probe)
        # Owner cancellation closes the pipe. Unexpected messages while queued
        # are rejected; no JSON-RPC work is admitted before acquiring the lock.
        if select.select([0], [], [], 0.05)[0]:
            data = os.read(0, 1)
            if not data:
                raise EOFError()
            raise ValueError("Unexpected command while queued")


try:
    while True:
        readers = [0]
        if child:
            readers += [child.stdout.fileno(), child.stderr.fileno()]
        writers = [child.stdin.fileno()] if child and pending and active else []
        readable, writable, _ = select.select(readers, writers, [], 0.1)
        if child and time.monotonic() - last_memory_check >= 0.25:
            last_memory_check = time.monotonic()
            rows = subprocess.check_output(["/bin/ps", "-axo", "pgid=,rss="], text=True)
            rss = sum(int(parts[1])*1024 for line in rows.splitlines() if len(parts := line.split()) == 2 and parts[0] == str(child.pid))
            peak_rss_bytes = max(peak_rss_bytes, rss)
            if rss > int(settings.get("maxMemoryMiB", 8192))*1048576:
                raise RuntimeError("Warm process group exceeded memory envelope")
        if child and child.poll() is not None:
            raise RuntimeError("Warm child exited: %s" % child.returncode)
        if writable:
            n = os.write(child.stdin.fileno(), pending)
            pending = pending[n:]
        for stream in readable:
            data = os.read(stream, 65536)
            if stream != 0:
                if data:
                    os.write(1 if stream == child.stdout.fileno() else 2, data)
                continue
            if not data:
                raise EOFError()
            buffer += data
            if len(buffer) > 8 * 1024 * 1024:
                raise ValueError("Warm command exceeds envelope")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                request = json.loads(line)
                kind = request["kind"]
                if kind == "configure":
                    if settings is not None:
                        raise ValueError("Warm child already configured")
                    settings = request
                elif kind == "acquire":
                    acquire()
                elif kind == "send":
                    if not active:
                        raise ValueError("Work outside host admission")
                    pending += base64.b64decode(request["bytes"], validate=True)
                elif kind == "release":
                    if not active or pending:
                        raise ValueError("Cannot release unfinished writes")
                    stop_group()
                    fcntl.flock(fd, fcntl.LOCK_UN)
                    active = False
                    emit("released", slot=slot+1, pid=child.pid, peakRssBytes=peak_rss_bytes)
                elif kind == "close":
                    raise EOFError()
                else:
                    raise ValueError("Unknown warm command")
except EOFError:
    pass
except Exception as error:
    emit("failed", error=str(error))
finally:
    if child:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        # Grandchildren share the same group. Never unlock while they execute.
        while alive_group():
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            time.sleep(0.01)
    if fd is not None:
        os.close(fd)
    emit("closed")
