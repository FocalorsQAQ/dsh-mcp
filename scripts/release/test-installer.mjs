import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Same installer source and payloads, with an isolated Windows installation identity. */
export function testInstaller(version, directory) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid test version.');
  directory = realpathSync(directory);
  if (dirname(directory) !== realpathSync('.test-output/release') || !/^run-[\w-]+$/.test(basename(directory))) {
    throw new Error('Installer tests require their own directory under .test-output/release.');
  }
  const current = JSON.parse(readFileSync('packaging/release.json', 'utf8'));
  let source = version === current.version ? readFileSync('packaging/windows-installer.iss', 'utf8') :
    execFileSync('git', ['show', `v${version}:packaging/windows-installer.iss`], { encoding: 'utf8' });
  for (const setting of ['AppId', 'DefaultGroupName', 'LicenseFile']) {
    if (source.match(new RegExp('^' + setting + '=.*$', 'gm'))?.length !== 1) throw new Error('Unexpected installer setting: ' + setting);
  }
  const identity = 'dsh-mcp-test-' + basename(directory);
  source = source.replace(/^AppId=.*$/m, 'AppId=' + identity)
    .replace(/^DefaultGroupName=.*$/m, 'DefaultGroupName=' + identity)
    .replace(/^LicenseFile=.*$/m, 'LicenseFile=' + resolve('LICENSE'));
  const app = `dsh-mcp-${version}-win-x64.zip`, core = `deepseek-harness-cli-${current.core_version}-dsh-mcp-${version}-win-x64.zip`;
  const hash = name => createHash('sha256').update(readFileSync(resolve('release-output', name))).digest('hex');
  const defines = { AppVersion: version, ReleaseOutput: directory, AppArchive: app, CoreArchive: core,
    AppSHA256: hash(app), CoreSHA256: hash(core), DownloadBase: `https://github.com/${current.repository}/releases/download/v${version}` };
  const include = join(directory, `definitions-${version}.iss`), script = join(directory, `setup-${version}.iss`);
  writeFileSync(include, Object.entries(defines).map(([key, value]) => `#define ${key} "${value}"`).join('\n'));
  writeFileSync(script, source);
  execFileSync(process.env.ISCC_PATH ?? resolve('.release-cache/InnoSetup/ISCC.exe'), ['/Qp', '/DReleaseInclude=' + include, script], { windowsHide: true, stdio: 'pipe' });
  return join(directory, `dsh-mcp-${version}-setup-win-x64.exe`);
}
