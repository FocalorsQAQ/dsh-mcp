import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Replace only links between this installation's managed packages, never package contents. */
export function restoreRuntimeLinks(installation, manifest) {
  const root = realpathSync(installation);
  const inside = path => { const r = relative(root, path); return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
  const managed = path => /^node_modules\/\.dsh\/[a-f0-9]{4,64}$/.test(relative(root, path).split(sep).join('/'));
  const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
  const safe = path => {
    if (typeof path !== 'string' || !path.startsWith('node_modules/') || path.includes('\\')) throw new Error('Invalid runtime link.');
    const absolute = resolve(root, path);
    if (!inside(absolute)) throw new Error('Runtime link escapes installation.');
    return absolute;
  };
  const checkParent = path => {
    let parent = dirname(path);
    while (!existsSync(parent)) parent = dirname(parent);
    if (!inside(realpathSync(parent))) throw new Error('Runtime link parent escapes installation.');
  };
  const names = new Map();
  const packageName = path => {
    if (names.has(path)) return names.get(path);
    const file = join(path, 'package.json');
    if (!stat(file)?.isFile() || realpathSync(file) !== file) throw new Error('Invalid managed package metadata.');
    const name = JSON.parse(readFileSync(file, 'utf8')).name;
    if (typeof name !== 'string' || !name) throw new Error('Invalid managed package name.');
    names.set(path, name); return name;
  };
  // Validate the whole plan before touching any existing link, including old upgrade aliases.
  const plans = manifest.links.map(({ path, target }) => {
    const from = safe(path), to = safe(target);
    if (!managed(to) || !existsSync(to) || realpathSync(to) !== to) throw new Error('Missing or external runtime dependency: ' + path);
    const match = /^node_modules\/(?:\.dsh\/[a-f0-9]{4,64}\/node_modules\/)?((?:@[^/]+\/)?[^/]+)$/.exec(path);
    if (!match) throw new Error('Invalid runtime package path: ' + path);
    const name = packageName(to); // npm aliases may differ from the actual package name.
    checkParent(from);
    const current = stat(from);
    if (!current) return { from, to, action: 'create' };
    if (!current.isSymbolicLink() || !existsSync(from)) throw new Error('Conflicting runtime dependency: ' + path);
    const previous = realpathSync(from);
    if (previous === to) return { from, to, action: 'keep' };
    if (!managed(previous) || packageName(previous) !== name) throw new Error('Unmanaged runtime dependency: ' + path);
    return { from, to, action: 'replace', previous, originalLink: readlinkSync(from) };
  });
  const counts = { created: 0, migrated: 0, unchanged: 0 };
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  for (const plan of plans) {
    const { from, to, action } = plan;
    if (action === 'keep') { counts.unchanged++; continue; }
    checkParent(from);
    if (action === 'create') {
      mkdirSync(dirname(from), { recursive: true });
      symlinkSync(to, from, type); counts.created++; continue;
    }
    // Prepare the new junction first. A failed replacement restores the original link.
    const temporary = from + '.dsh-' + randomUUID();
    if (!inside(temporary)) throw new Error('Runtime link temporary path escapes installation.');
    symlinkSync(to, temporary, type);
    let removed = false;
    try {
      if (!stat(from)?.isSymbolicLink() || readlinkSync(from) !== plan.originalLink || realpathSync(from) !== plan.previous) {
        throw new Error('Runtime dependency changed during initialization. Retry installation.');
      }
      unlinkSync(from); removed = true;
      renameSync(temporary, from); counts.migrated++;
    } catch (error) {
      if (removed && !stat(from)) symlinkSync(plan.previous, from, type);
      throw error;
    } finally {
      if (stat(temporary)?.isSymbolicLink()) unlinkSync(temporary);
    }
  }
  return counts;
}
