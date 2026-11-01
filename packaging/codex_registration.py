"""Register only dsh in Codex's documented user config, preserving all other text."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import tomllib
import uuid


def parse(raw):
    return tomllib.loads(raw.decode('utf-8-sig'))


def replace_checked(path, before, after):
    if path.exists() and path.read_bytes() != before:
        raise ValueError('Codex configuration changed concurrently; retry registration.')
    if before:
        backup = path.with_name('config.toml.dsh-backup-' + uuid.uuid4().hex)
        with backup.open('xb') as stream:
            stream.write(before)
    fd, temporary = tempfile.mkstemp(prefix='.dsh-config-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(after)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists() and path.read_bytes() != before:
            raise ValueError('Codex configuration changed concurrently; retry registration.')
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def register_mcp(root, home):
    home.mkdir(parents=True, exist_ok=True)
    path = home / 'config.toml'
    if path.is_symlink():
        raise ValueError('A linked Codex config requires manual setup.')
    before = path.read_bytes() if path.exists() else b''
    current = parse(before)
    snippet = (root / 'codex-mcp.toml').read_text(encoding='utf-8')
    desired = tomllib.loads(snippet)['mcp_servers']['dsh']
    existing = current.get('mcp_servers', {}).get('dsh')
    if existing is not None:
        return {'status': 'already_registered' if existing == desired else 'conflict', 'config': str(path)}
    marker = uuid.uuid4().hex
    block = '\n# BEGIN dsh-mcp ' + marker + '\n' + snippet.rstrip() + '\n# END dsh-mcp ' + marker + '\n'
    after = before + block.encode('utf-8')
    parsed = parse(after)  # Inline tables or unusual TOML must fail before writing.
    if parsed['mcp_servers']['dsh'] != desired:
        raise ValueError('Generated Codex registration is invalid.')
    receipt = {'config': str(path), 'block': block, 'entry': desired}
    receipt_path = root / 'codex-registration.json'
    # Save ownership before the config change so uninstall can recover after an interruption.
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False), encoding='utf-8')
    replace_checked(path, before, after)
    return {'status': 'registered', 'config': str(path)}


def unregister_mcp(root):
    receipt_path = root / 'codex-registration.json'
    if not receipt_path.exists():
        return {'status': 'not_owned'}
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    path = Path(receipt['config'])
    if path.is_symlink():
        return {'status': 'changed_preserved'}
    if not path.exists():
        return {'status': 'already_removed'}
    before = path.read_bytes()
    block = receipt['block'].encode('utf-8')
    if before.count(block) != 1 or parse(before).get('mcp_servers', {}).get('dsh') != receipt['entry']:
        return {'status': 'changed_preserved'}
    after = before.replace(block, b'', 1)
    parse(after)
    replace_checked(path, before, after)
    return {'status': 'removed'}


def hook_command(root):
    # Codex uses PowerShell for Windows command hooks. Single-quote each literal.
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    return '& ' + ' '.join(map(quote, [root / 'bin/node/node.exe', root / 'packaging/prompt-hook.mjs', '--config', root / 'dsh.config.json']))


def register_hook(root, home):
    path = home / 'config.toml'
    before = path.read_bytes() if path.exists() else b''
    if path.is_symlink():
        raise ValueError('Linked config requires manual setup')
    command = hook_command(root)
    groups = parse(before).get('hooks', {}).get('UserPromptSubmit', [])
    for group in groups:
        for hook in group.get('hooks', []):
            if hook.get('command') == command:
                return 'registered_review_required'
    block = '\n# BEGIN dsh task snapshot hook\n[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = ' + json.dumps(command) + '\ntimeout = 15\nstatusMessage = "Saving dsh task settings"\n# END dsh task snapshot hook\n'
    after = before + block.encode('utf-8')
    parse(after)
    (root / 'codex-hook-registration.json').write_text(json.dumps({'config': str(path), 'block': block}), encoding='utf-8')
    replace_checked(path, before, after)
    return 'registered_review_required'


def unregister_hook(root):
    receipt = root / 'codex-hook-registration.json'
    if not receipt.exists():
        return 'not_owned'
    saved = json.loads(receipt.read_text(encoding='utf-8'))
    path = Path(saved['config'])
    if not path.exists() or path.is_symlink():
        return 'changed_preserved'
    before = path.read_bytes()
    block = saved['block'].encode('utf-8')
    if before.count(block) != 1:
        return 'changed_preserved'
    after = before.replace(block, b'', 1)
    parse(after)
    replace_checked(path, before, after)
    return 'removed'


def register(root, home):
    result = register_mcp(root, home)
    if result['status'] != 'conflict':
        result['hook'] = register_hook(root, home)
    return result


def unregister(root):
    hook = unregister_hook(root)
    result = unregister_mcp(root)
    result['hook'] = hook
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['register', 'unregister'])
    parser.add_argument('--root', required=True)
    parser.add_argument('--codex-home')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    home = Path(args.codex_home or os.environ.get('CODEX_HOME') or Path.home() / '.codex').resolve()
    try:
        result = register(root, home) if args.action == 'register' else unregister(root)
    except Exception:
        # Never include configuration text or credentials in installer output.
        result = {'status': 'error', 'message': 'Codex registration failed; use codex-mcp.toml to configure manually.'}
    (root / 'codex-registration-result.json').write_text(json.dumps(result), encoding='utf-8')
    print(json.dumps(result))
    return 2 if result['status'] in ('error', 'conflict') else 0


if __name__ == '__main__':
    raise SystemExit(main())
