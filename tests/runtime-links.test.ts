import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { restoreRuntimeLinks } from '../packaging/runtime-links.mjs';

const kind = process.platform === 'win32' ? 'junction' : 'dir';
function fixture() {
  const output = resolve('.test-output/runtime-links'); fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(join(output, 'run-'));
  const root = join(directory, 'installed app'); fs.mkdirSync(root);
  function pkg(id: string, name = 'fixture-package') {
    const target = 'node_modules/.dsh/' + id;
    const path = join(root, target); fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: id }));
    fs.writeFileSync(join(path, 'keep.txt'), id);
    return { target, path };
  }
  return { directory, root, pkg, link: join(root, 'node_modules/fixture-alias') };
}

test('creates runtime links for a fresh installation', () => {
  const f = fixture(); const current = f.pkg('123456789abc');
  assert.deepEqual(restoreRuntimeLinks(f.root, { links: [{ path: 'node_modules/fixture-alias', target: current.target }] }),
    { created: 1, migrated: 0, unchanged: 0 });
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(current.path));
});

test('upgrades legacy links and npm aliases, preserves both package trees, and is idempotent', () => {
  const f = fixture(); const old = f.pkg('0001'), current = f.pkg('123456789abc');
  fs.symlinkSync(old.path, f.link, kind);
  const manifest = { links: [{ path: 'node_modules/fixture-alias', target: current.target }] };
  assert.deepEqual(restoreRuntimeLinks(f.root, manifest), { created: 0, migrated: 1, unchanged: 0 });
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(current.path));
  assert.equal(fs.readFileSync(join(old.path, 'keep.txt'), 'utf8'), '0001');
  assert.equal(fs.readFileSync(join(current.path, 'keep.txt'), 'utf8'), '123456789abc');
  assert.deepEqual(restoreRuntimeLinks(f.root, manifest), { created: 0, migrated: 0, unchanged: 1 });
});

test('rejects ordinary directories, external links and different packages before changing any link', () => {
  for (const conflict of ['directory', 'external', 'different-package']) {
    const f = fixture(); const old = f.pkg('0001'), current = f.pkg('123456789abc');
    fs.symlinkSync(old.path, f.link, kind);
    const blocked = join(f.root, 'node_modules/blocked');
    if (conflict === 'directory') fs.mkdirSync(blocked);
    else {
      const target = conflict === 'external' ? join(f.directory, 'user-data') : f.pkg('0002', 'another-package').path;
      fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(join(target, 'keep.txt'), 'untouched');
      fs.symlinkSync(target, blocked, kind);
    }
    assert.throws(() => restoreRuntimeLinks(f.root, { links: [
      { path: 'node_modules/fixture-alias', target: current.target },
      { path: 'node_modules/blocked', target: current.target },
    ] }), /runtime dependency/);
    assert.equal(fs.realpathSync(f.link), fs.realpathSync(old.path));
    if (conflict !== 'directory') assert.equal(fs.readFileSync(join(blocked, 'keep.txt'), 'utf8'), 'untouched');
  }
});

test('rejects escaping parents and targets without writing outside the installation', () => {
  const f = fixture(); const current = f.pkg('123456789abc');
  const outside = join(f.directory, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, join(f.root, 'node_modules/@scope'), kind);
  assert.throws(() => restoreRuntimeLinks(f.root, { links: [
    { path: 'node_modules/@scope/fixture-package', target: current.target },
  ] }), /escapes installation/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.throws(() => restoreRuntimeLinks(f.root, { links: [
    { path: 'node_modules/fixture-alias', target: 'node_modules/../../outside' },
  ] }), /escapes installation/);
});

test('restores the old junction if committing a replacement fails', t => {
  const f = fixture(); const old = f.pkg('0001'), current = f.pkg('123456789abc');
  fs.symlinkSync(old.path, f.link, kind);
  const mocked = t.mock.method(fs, 'renameSync', () => { throw new Error('Simulated rename failure'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => restoreRuntimeLinks(f.root, { links: [
      { path: 'node_modules/fixture-alias', target: current.target },
    ] }), /Simulated rename failure/);
    assert.equal(fs.realpathSync(f.link), fs.realpathSync(old.path));
    assert.deepEqual(fs.readdirSync(join(f.root, 'node_modules')).sort(), ['.dsh', 'fixture-alias']);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});
