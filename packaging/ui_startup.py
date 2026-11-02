"""Own one HKCU Run entry. Never rewrite Codex shortcuts or machine-wide startup settings."""
import json
import os
from pathlib import Path
import subprocess
import sys

RUN_PATH = r'Software\Microsoft\Windows\CurrentVersion\Run'
RUN_NAME = 'DeepSeek Harness as Subagent'
RECEIPT = 'ui-startup-registration.json'


def command(root):
    root = Path(root).resolve()
    python = root / 'bin/python/pythonw.exe'
    if not python.is_file():
        python = Path(sys.executable).with_name('pythonw.exe')
    if not python.is_file() or not (root / 'runtime/codex_watch.py').is_file():
        raise ValueError('Desktop companion runtime is missing')
    return [str(python), '-I', '-B', str(root / 'runtime/codex_watch.py'), '--root', str(root), '--config', str(root / 'dsh.config.json')]


def read_entry(registry):
    try:
        with registry.OpenKey(registry.HKEY_CURRENT_USER, RUN_PATH) as key:
            value, kind = registry.QueryValueEx(key, RUN_NAME)
            if kind != registry.REG_SZ:
                raise ValueError('Startup entry has an unexpected type')
            return value
    except FileNotFoundError:
        return None


def register(root, start=True, registry=None):
    if os.name != 'nt' and registry is None:
        return {'status': 'not_supported'}
    if registry is None:
        import winreg as registry
    root = Path(root).resolve()
    args = command(root)
    desired = subprocess.list2cmdline(args)
    before = read_entry(registry)
    if before is not None and before != desired:
        return {'status': 'conflict'}
    receipt_path = root / RECEIPT
    # Adopt an identical registration only when this installation already owns it.
    if before is not None:
        if not receipt_path.is_file() or json.loads(receipt_path.read_text(encoding='utf-8')).get('command') != desired:
            return {'status': 'not_owned'}
    receipt = {'version': 1, 'name': RUN_NAME, 'command': desired, 'config': str(root / 'dsh.config.json'), 'registered': False}
    receipt_path.write_text(json.dumps(receipt), encoding='utf-8')
    with registry.CreateKey(registry.HKEY_CURRENT_USER, RUN_PATH) as key:
        if read_entry(registry) != before:
            raise ValueError('Startup entry changed concurrently')
        registry.SetValueEx(key, RUN_NAME, 0, registry.REG_SZ, desired)
    receipt['registered'] = True
    receipt_path.write_text(json.dumps(receipt), encoding='utf-8')
    if start:
        subprocess.run([sys.executable, '-I', '-B', str(root / 'runtime/codex_watch.py'), '--root', str(root), '--stop'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=25, check=True)
        subprocess.Popen(args, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS)
    return {'status': 'already_registered' if before else 'registered'}


def unregister(root, registry=None):
    root = Path(root).resolve()
    receipt_path = root / RECEIPT
    if not receipt_path.is_file():
        return {'status': 'not_owned'}
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    if registry is None:
        import winreg as registry
    existing = read_entry(registry)
    if existing is not None and existing != receipt.get('command'):
        return {'status': 'changed_preserved'}
    if existing is not None:
        with registry.OpenKey(registry.HKEY_CURRENT_USER, RUN_PATH, 0, registry.KEY_SET_VALUE) as key:
            registry.DeleteValue(key, RUN_NAME)
    if getattr(registry, '__name__', '') == 'winreg':
        subprocess.run([sys.executable, '-I', '-B', str(root / 'runtime/codex_watch.py'), '--root', str(root), '--stop'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=25, check=True)
    receipt_path.unlink()
    return {'status': 'removed'}
