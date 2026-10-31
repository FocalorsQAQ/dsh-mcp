"""Create portable ZIPs without following links or including local runtime data."""
import json
import pathlib
import sys
import zipfile

stage = json.loads(pathlib.Path('.release/latest-stage.json').read_text(encoding='utf-8'))
config = json.loads(pathlib.Path('packaging/release.json').read_text(encoding='utf-8'))
output = pathlib.Path('release-output').resolve()
output.mkdir(exist_ok=True)
names = {
    'app': f"dsh-mcp-{config['version']}-win-x64.zip",
    'core': f"deepseek-harness-cli-{config['core_version']}-dsh-mcp-{config['version']}-win-x64.zip",
}
for kind, filename in names.items():
    if len(sys.argv) > 1 and kind not in sys.argv[1:]:
        continue
    source = pathlib.Path(stage[kind])
    target = output / filename
    count = 0
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True, strict_timestamps=False) as archive:
        for path in sorted(source.rglob('*')):
            if path.is_symlink() or path.is_junction():
                raise RuntimeError(f'Links must be represented by core-manifest.json: {path}')
            if not path.is_file():
                continue
            relative = path.relative_to(source)
            if any(part in ('.git', '.dsh-mcp', '.env', '.test-output', '__pycache__') for part in relative.parts):
                raise RuntimeError(f'Private/cache data in release: {relative}')
            archive.write(path, relative.as_posix())
            count += 1
    print(json.dumps({'file': str(target), 'files': count, 'bytes': target.stat().st_size}), flush=True)
