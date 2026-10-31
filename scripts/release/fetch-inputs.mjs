import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const config = JSON.parse(readFileSync(new URL('../../packaging/release.json', import.meta.url), 'utf8'));
const cache = resolve('.release-cache'); mkdirSync(cache, { recursive: true });
const inputs = [
  { name: `node-v${config.node_version}-win-x64.zip`, url: `https://nodejs.org/dist/v${config.node_version}/node-v${config.node_version}-win-x64.zip`, sha256: config.node_sha256 },
  { name: `python-${config.python_version}-embed-amd64.zip`, url: `https://www.python.org/ftp/python/${config.python_version}/python-${config.python_version}-embed-amd64.zip`, sha256: config.python_sha256 },
  { name: `innosetup-${config.inno_version}.exe`, url: `https://github.com/jrsoftware/issrc/releases/download/is-${config.inno_version.replaceAll('.', '_')}/innosetup-${config.inno_version}.exe`, sha256: config.inno_sha256 },
];
await Promise.all(inputs.map(async item => {
  const path = join(cache, item.name);
  if (!existsSync(path)) {
    const r = await fetch(item.url); if (!r.ok) throw new Error(`Download failed: ${item.name}: HTTP ${r.status}`);
    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  }
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (item.sha256 && sha256 !== item.sha256) throw new Error('Checksum mismatch: ' + item.name);
  console.log(JSON.stringify({ ...item, sha256, path }));
}));
