"""Serialize registry ownership changes with an OS-released file lock.

Only metadata crosses stdin/stdout. The stable guard file must never be deleted:
unlinking an OS-locked file would let competitors lock different file objects.
"""
import contextlib
import ctypes
import datetime
import json
import os
from pathlib import Path
import re
import sys
import time


class LockError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def process_identity(pid):
    """None means proven dead; permission/inspection failures never mean dead."""
    if os.name == "nt":
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        kernel.GetProcessTimes.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x100000 | 0x1000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
        if not handle:
            if ctypes.get_last_error() == 87:  # invalid PID
                return None
            raise LockError("LOCKED", "Cannot establish whether the recorded owner has exited.")
        try:
            wait = kernel.WaitForSingleObject(handle, 0)
            if wait == 0:
                return None
            if wait != 258:
                raise LockError("LOCKED", "Cannot inspect the recorded owner.")
            created, exited, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
            if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel_time), ctypes.byref(user_time)):
                raise LockError("LOCKED", "Cannot read the recorded owner's creation time.")
            return "win32:" + str((created.dwHighDateTime << 32) | created.dwLowDateTime)
        finally:
            kernel.CloseHandle(handle)
    if sys.platform.startswith("linux"):
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            if fields[0] == "Z":
                return None
            boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            return "linux:" + boot + ":" + fields[19]
        except FileNotFoundError:
            return None
    try:
        os.kill(pid, 0)
        # No reliable creation-time probe on other platforms: never reclaim a live PID.
        return "alive"
    except ProcessLookupError:
        return None


@contextlib.contextmanager
def guard(path):
    with path.open("a+b") as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + 3
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise LockError("LOCK_BUSY", "Another server is updating registry ownership; retry shortly.")
                time.sleep(0.02)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def atomic_json(path, value, token, replace=True):
    temporary = path.with_name(path.name + "." + token + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=True)
            handle.flush()
            os.fsync(handle.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            # Exclusive publication also protects against an older dsh version
            # that does not yet participate in the guard protocol.
            try:
                if os.name == "nt":
                    os.rename(temporary, path)  # Windows rename never overwrites an existing target.
                else:
                    os.link(temporary, path)
            except FileExistsError:
                raise LockError("LOCKED", "Another server acquired this data directory.")
    finally:
        temporary.unlink(missing_ok=True)


def run(command):
    pid, token = command["pid"], command["token"]
    if pid != os.getppid() or not isinstance(token, str) or len(token) != 36 or any(c not in "0123456789abcdef-" for c in token):
        raise LockError("LOCK_PROTOCOL", "Invalid lock owner.")
    directory = Path(command["directory"]).resolve(strict=True)
    path = directory / "server.lock"
    with guard(directory / ".server.lock.guard"):
        owner = None
        try:
            owner = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(owner, dict) or type(owner.get("pid")) is not int or not 0 < owner["pid"] <= 0xFFFFFFFF or not isinstance(owner.get("token"), str):
                raise ValueError("Invalid owner")
            if "process_identity" in owner and (not isinstance(owner["process_identity"], str) or not re.fullmatch(r"win32:[0-9]+|linux:[0-9a-f-]+:[0-9]+|alive", owner["process_identity"])):
                raise ValueError("Invalid process identity")
        except FileNotFoundError:
            pass
        except (ValueError, UnicodeError):
            raise LockError("LOCKED", "Unreadable server.lock; preserve it and inspect the data directory.")
        if command["operation"] == "release":
            if not owner or owner.get("token") != token or owner["pid"] != pid:
                raise LockError("LOCKED", "Registry lock ownership changed unexpectedly.")
            path.unlink()
            return {"recovered": False}
        if command["operation"] != "acquire":
            raise LockError("LOCK_PROTOCOL", "Unknown lock operation.")
        if owner:
            identity = process_identity(owner["pid"])
            if identity is not None and (identity == "alive" or not owner.get("process_identity") or owner["process_identity"] == identity):
                raise LockError("LOCKED", "This data directory is already owned by a running dsh MCP server (PID " + str(owner["pid"]) + ").")
        own_identity = process_identity(pid)
        if own_identity is None:
            raise LockError("LOCKED", "The requesting server has already exited.")
        current = {"version": 2, "pid": pid, "token": token, "process_identity": own_identity}
        if owner:
            # Keep diagnostics separate from the state/ledger; never modify either here.
            atomic_json(directory / "last-recovery.json", {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "previous_owner": owner, "new_owner": current}, token)
        atomic_json(path, current, token, replace=owner is not None)
        return {"recovered": owner is not None, "previous_pid": owner["pid"] if owner else None}


if __name__ == "__main__":
    try:
        result = run(json.loads(sys.stdin.read(16384)))
        print(json.dumps({"ok": True, **result}))
    except LockError as error:
        print(json.dumps({"ok": False, "code": error.code, "message": error.message}))
    except Exception:
        # Do not echo command input, filesystem contents or inherited environment.
        print(json.dumps({"ok": False, "code": "LOCK_IO", "message": "Registry lock helper failed; check directory permissions and Python availability."}))
