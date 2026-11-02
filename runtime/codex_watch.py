"""Per-user desktop companion. Observes Codex windows; never opens a chat or calls a model."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def instance_name(root, config):
    identity = str(Path(root).resolve()).casefold() + '\n' + str(Path(config).resolve()).casefold()
    return 'Local\\dsh-codex-ui-' + hashlib.sha256(identity.encode()).hexdigest()[:32]


def is_codex_window(image, window_class):
    path = image.replace('/', '\\').casefold()
    return (path.endswith('\\chatgpt.exe') and '\\openai.codex_' in path) or (
        path.endswith('\\codex.exe') and window_class == 'Chrome_WidgetWin_1')


class LaunchTracker:
    """Launch once per process generation, preserving a user's decision to close the panel."""
    def __init__(self):
        self.launched = set()
        self.retry_after = {}

    def tick(self, candidates, alive, enabled, launch, now):
        self.launched = {key for key in self.launched if alive(key)}
        self.retry_after = {key: due for key, due in self.retry_after.items() if alive(key)}
        result = []
        if not enabled:
            return result
        for key in dict.fromkeys(candidates):
            if key in self.launched or now < self.retry_after.get(key, 0):
                continue
            try:
                launch()
            except Exception:
                self.retry_after[key] = now + 10
                result.append((key, False))
            else:
                self.launched.add(key)
                self.retry_after.pop(key, None)
                result.append((key, True))
        return result


class Windows:
    def __init__(self):
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.user = ctypes.WinDLL('user32', use_last_error=True)
        self.callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        declarations = [
            (self.kernel.OpenProcess, [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            (self.kernel.CloseHandle, [wintypes.HANDLE], wintypes.BOOL),
            (self.kernel.QueryFullProcessImageNameW, [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            (self.kernel.GetProcessTimes, [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4, wintypes.BOOL),
            (self.kernel.ProcessIdToSessionId, [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            (self.kernel.CreateMutexW, [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
            (self.kernel.CreateEventW, [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
            (self.kernel.OpenEventW, [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
            (self.kernel.SetEvent, [wintypes.HANDLE], wintypes.BOOL),
            (self.kernel.WaitForSingleObject, [wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            (self.user.EnumWindows, [self.callback_type, wintypes.LPARAM], wintypes.BOOL),
            (self.user.IsWindowVisible, [wintypes.HWND], wintypes.BOOL),
            (self.user.GetWindow, [wintypes.HWND, wintypes.UINT], wintypes.HWND),
            (self.user.GetWindowThreadProcessId, [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
            (self.user.GetClassNameW, [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
        ]
        for function, args, result in declarations:
            function.argtypes, function.restype = args, result
        self.session = wintypes.DWORD()
        if not self.kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(self.session)):
            raise OSError('Cannot identify the desktop session')

    def process(self, pid):
        session = wintypes.DWORD()
        if not self.kernel.ProcessIdToSessionId(pid, ctypes.byref(session)) or session.value != self.session.value:
            return None
        handle = self.kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            path, size = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
            times = [wintypes.FILETIME() for _ in range(4)]
            if not self.kernel.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)):
                return None
            if not self.kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
                return None
            created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
            return (pid, created), path.value
        finally:
            self.kernel.CloseHandle(handle)

    def alive(self, identity):
        current = self.process(identity[0])
        return current is not None and current[0] == identity

    def candidates(self):
        found, cache = {}, {}
        @self.callback_type
        def visit(window, _):
            if not self.user.IsWindowVisible(window) or self.user.GetWindow(window, 4):
                return True
            pid, cls = wintypes.DWORD(), ctypes.create_unicode_buffer(256)
            self.user.GetWindowThreadProcessId(window, ctypes.byref(pid))
            self.user.GetClassNameW(window, cls, len(cls))
            if pid.value not in cache:
                cache[pid.value] = self.process(pid.value)
            current = cache[pid.value]
            if current and is_codex_window(current[1], cls.value):
                found[current[0]] = current[1]
            return True
        if not self.user.EnumWindows(visit, 0):
            raise OSError('Cannot enumerate desktop windows')
        return found


def auto_start_enabled(config):
    value = json.loads(Path(config).read_text(encoding='utf-8-sig')).get('ui_auto_start', True)
    if not isinstance(value, bool):
        raise ValueError('Invalid ui_auto_start setting')
    return value


def launch_ui(root, config):
    node = Path(root) / 'bin/node/node.exe'
    executable = str(node) if node.is_file() else shutil.which('node')
    if not executable:
        raise OSError('Node runtime missing')
    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    subprocess.run([executable, str(Path(root) / 'scripts/start-ui.mjs'), '--auto-start', '--config', str(config)],
                   cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   creationflags=subprocess.CREATE_NO_WINDOW, timeout=15, check=True)


def write_status(root, value):
    path = Path(root) / 'ui-startup-status.json'
    temporary = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    try:
        temporary.write_text(json.dumps(value), encoding='utf-8')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--config')
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--stop', action='store_true')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    config = Path(args.config).resolve() if args.config else root / 'dsh.config.json'
    native = Windows()
    name = instance_name(root, config)
    if args.probe:
        print(json.dumps({'enabled': auto_start_enabled(config), 'codex': [
            {'pid': key[0], 'created': str(key[1]), 'executable': image} for key, image in native.candidates().items()]}))
        return
    if args.stop:
        event = native.kernel.OpenEventW(0x0002, False, name + '-stop')
        if event:
            native.kernel.SetEvent(event)
            native.kernel.CloseHandle(event)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                handle = native.kernel.CreateMutexW(None, False, name)
                exists = ctypes.get_last_error() == 183
                if handle:
                    native.kernel.CloseHandle(handle)
                if handle and not exists:
                    break
                time.sleep(0.1)
            else:
                raise TimeoutError('Desktop companion has not stopped')
        return
    mutex = native.kernel.CreateMutexW(None, False, name)
    duplicate = ctypes.get_last_error() == 183
    if not mutex:
        raise OSError('Cannot lock desktop companion')
    if duplicate:
        native.kernel.CloseHandle(mutex)
        return
    stop = native.kernel.CreateEventW(None, True, False, name + '-stop')
    if not stop:
        native.kernel.CloseHandle(mutex)
        raise OSError('Cannot create desktop companion stop event')
    tracker = LaunchTracker()
    status = {'pid': os.getpid(), 'started_at': time.time(), 'config': str(config), 'last_launch_at': None, 'last_error': None}
    previous = None
    try:
        while native.kernel.WaitForSingleObject(stop, 0) == 258:
            try:
                enabled = auto_start_enabled(config)
                candidates = native.candidates()
                results = tracker.tick(candidates, native.alive, enabled, lambda: launch_ui(root, config), time.monotonic())
                status.update(enabled=enabled, codex_pids=sorted(key[0] for key in candidates))
                for _, success in results:
                    status['last_error'] = None if success else 'UI_LAUNCH_FAILED'
                    if success:
                        status['last_launch_at'] = time.time()
            except Exception:
                status['last_error'] = 'WATCH_CONFIGURATION_OR_DESKTOP_UNAVAILABLE'
            serialized = json.dumps(status)
            if serialized != previous:
                write_status(config.parent, status)
                previous = serialized
            if native.kernel.WaitForSingleObject(stop, 500) != 258:
                break
    finally:
        try:
            write_status(config.parent, {**status, 'stopped_at': time.time()})
        finally:
            native.kernel.CloseHandle(stop)
            native.kernel.CloseHandle(mutex)


if __name__ == '__main__':
    main()
