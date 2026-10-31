import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const release = JSON.parse(readFileSync('packaging/release.json', 'utf8'));
const output = resolve('release-output');
const app = `dsh-mcp-${release.version}-win-x64.zip`;
const core = `deepseek-harness-cli-${release.core_version}-dsh-mcp-${release.version}-win-x64.zip`;
const hash = file => createHash('sha256').update(readFileSync(join(output, file))).digest('hex');
const defines = {
  AppVersion: release.version, ReleaseOutput: output, AppArchive: app, CoreArchive: core,
  AppSHA256: hash(app), CoreSHA256: hash(core),
  DownloadBase: `https://github.com/${release.repository}/releases/download/v${release.version}`,
};
const include = resolve('.release/installer.generated.iss');
writeFileSync(include, Object.entries(defines).map(([key,value]) => `#define ${key} "${value}"`).join('\n'));
const compiler = process.env.ISCC_PATH ?? resolve('.release-cache/InnoSetup/ISCC.exe');
const result = spawnSync(compiler, ['/Qp', '/DReleaseInclude=' + include, resolve('packaging/windows-installer.iss')], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
const installer = `dsh-mcp-${release.version}-setup-win-x64.exe`;
writeFileSync(join(output, 'SHA256SUMS.txt'), [app,core,installer].map(name => hash(name) + '  ' + name).join('\n') + '\n');
writeFileSync(join(output, 'release-manifest.json'), JSON.stringify({ ...release, artifacts: [app,core,installer].map(name=>({name,sha256:hash(name)})) }, null, 2));
console.log(JSON.stringify({ output, installer }));
