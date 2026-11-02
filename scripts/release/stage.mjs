import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(readFileSync(join(root, 'packaging/release.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this release on Windows x64.');
if (config.version !== pkg.version) throw new Error('Release version mismatch.');
const output = join(root, '.release'); mkdirSync(output, { recursive: true });
const stage = mkdtempSync(join(output, 'stage-'));
const app = join(stage, 'app'), core = join(stage, 'core'); mkdirSync(app); mkdirSync(core);
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true, dereference: true,
  filter: source => !['__pycache__', '.dsh-mcp', '.env'].includes(basename(source)) && !source.endsWith('.pyc'),
}); };
for (const path of ['dist', 'dist-ui', 'desktop', 'resources', 'billing', 'runtime', 'licenses', 'docs', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'package.json', 'config/worker.patch.yml', 'scripts/start-ui.mjs', 'packaging/initialize.mjs', 'packaging/launch-server.mjs', 'packaging/uninstall-links.mjs']) copy(join(root, path), join(app, path));
copy(join(root, 'packaging/codex_registration.py'), join(app, 'packaging/codex_registration.py'));
copy(join(root, 'packaging/ui_startup.py'), join(app, 'packaging/ui_startup.py'));
copy(join(root, 'packaging/prompt-hook.mjs'), join(app, 'packaging/prompt-hook.mjs'));
copy(join(root, 'packaging/review-hook.ps1'), join(app, 'packaging/review-hook.ps1'));
copy(join(root, 'packaging/Review task hook.cmd'), join(app, 'Review task hook.cmd'));
copy(join(root, 'packaging/runtime-links.mjs'), join(app, 'packaging/runtime-links.mjs'));
for (const name of ['Initialize.cmd', 'Control UI.cmd', 'Harness CLI.cmd', 'Connect to Codex.cmd']) copy(join(root, 'packaging', name), join(app, name));
copy(join(root, 'dsh.config.json'), join(app, 'dsh.config.example.json'));
writeFileSync(join(app, 'release-info.json'), JSON.stringify(config, null, 2));

function extract(zip, dest) {
  mkdirSync(dest, { recursive: true });
  const result = spawnSync('tar.exe', ['-xf', zip, '-C', dest], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('Archive extraction failed.');
}
const nodeDir = join(stage, 'node-input');
extract(join(root, '.release-cache', `node-v${config.node_version}-win-x64.zip`), nodeDir);
copy(join(nodeDir, `node-v${config.node_version}-win-x64`), join(app, 'bin/node'));
extract(join(root, '.release-cache', `python-${config.python_version}-embed-amd64.zip`), join(app, 'bin/python'));

const packages = new Map(), links = [], optionalMissing = [];
function resolvePackage(name, start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const path = join(dir, 'node_modules', name);
    if (existsSync(join(path, 'package.json'))) return realpathSync(path);
    if (dirname(dir) === dir) return undefined;
  }
}
function copyPackage(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (['node_modules', '.git', '__pycache__'].includes(entry.name) || entry.name.endsWith('.pyc')) continue;
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      const target = realpathSync(from), r = relative(source, target);
      if (r.startsWith('..') || resolve(target) === resolve(root)) throw new Error('External package symlink: ' + from);
    }
    cpSync(from, to, { recursive: true, dereference: true });
  }
}
function addPackage(source) {
  if (packages.has(source)) return packages.get(source);
  const info = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  // Short stable paths avoid Windows MAX_PATH failures during archive installation.
  const id = createHash('sha256').update(relative(root, source)).digest('hex').slice(0, 12);
  const destination = 'node_modules/.dsh/' + id;
  const record = { name: info.name, version: info.version, license: info.license ?? null, path: destination };
  packages.set(source, record);
  copyPackage(source, join(core, destination));
  const names = new Set([...Object.keys(info.dependencies ?? {}), ...Object.keys(info.optionalDependencies ?? {}), ...Object.keys(info.peerDependencies ?? {})]);
  for (const name of names) {
    const dep = resolvePackage(name, source);
    if (!dep) {
      if (info.optionalDependencies?.[name] || info.peerDependenciesMeta?.[name]?.optional || (info.peerDependencies?.[name] && !info.dependencies?.[name])) { optionalMissing.push({ package: info.name, name }); continue; }
      throw new Error('Missing dependency: ' + info.name + ' -> ' + name);
    }
    const target = addPackage(dep);
    links.push({ path: destination + '/node_modules/' + name, target: target.path });
  }
  return record;
}
for (const name of Object.keys(pkg.dependencies)) {
  const found = resolvePackage(name, root); if (!found) throw new Error('Missing root dependency: ' + name);
  const dep = addPackage(found);
  links.push({ path: 'node_modules/' + name, target: dep.path });
}
// Native shared loaders resolve a platform package on behalf of a sibling.
// Preserve pnpm's hoisted fallback aliases as well as each package's own edges.
const direct = new Set(Object.keys(pkg.dependencies));
for (const name of new Set([...packages.values()].map(record => record.name))) {
  if (direct.has(name)) continue;
  const source = resolvePackage(name, join(root, 'node_modules/.pnpm'));
  const target = source && packages.get(source);
  if (target) links.push({ path: 'node_modules/' + name, target: target.path });
}
const inventory = [...packages.values()].sort((a,b) => a.name.localeCompare(b.name));
const manifest = { application_version: config.version, core_version: config.core_version, source: config.core_repository,
  upstream_tag: config.core_tag, distribution: 'Official npm packages redistributed with pinned dependencies; not an upstream binary release.', links };
writeFileSync(join(core, 'core-manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join(core, 'THIRD_PARTY_PACKAGES.json'), JSON.stringify(inventory, null, 2));
copy(join(root, 'THIRD_PARTY_NOTICES.md'), join(core, 'THIRD_PARTY_NOTICES.md'));
copy(join(root, 'licenses'), join(core, 'licenses'));
const report = { stage, app, core, packages: inventory.length, links: links.length, optionalMissing };
writeFileSync(join(output, 'latest-stage.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
