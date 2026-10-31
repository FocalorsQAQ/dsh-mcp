import { existsSync, lstatSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inside = path => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const manifest = JSON.parse(readFileSync(resolve(root, 'core-manifest.json'), 'utf8'));
for (const { path, target } of manifest.links.sort((a,b) => b.path.length - a.path.length)) {
  if (!path.startsWith('node_modules/') || !target.startsWith('node_modules/')) continue;
  const from = resolve(root, path), to = resolve(root, target);
  if (!inside(from) || !inside(to) || !existsSync(from)) continue;
  if (!lstatSync(from).isSymbolicLink() || !inside(realpathSync(dirname(from))) || realpathSync(from) !== realpathSync(to)) continue;
  unlinkSync(from); // Unlink only the generated junction, never its contents or user data.
  for (let dir=dirname(from); dir!==root && inside(dir); dir=dirname(dir)) {
    try { rmdirSync(dir); } catch { break; } // Empty directories only.
  }
}
