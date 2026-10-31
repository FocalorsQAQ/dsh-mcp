import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const root = resolve('.test-output/release'); mkdirSync(root, {recursive:true});
const directory = mkdtempSync(join(root,'run-'));
const install = join(directory,'installed app'), data=join(directory,'user-data'), workspace=join(directory,'workspace');
const config = JSON.parse(readFileSync('packaging/release.json','utf8'));
const codexHome = join(directory, 'codex-home'); mkdirSync(codexHome);
const originalCodex = '# Existing user settings\nmodel = "preserved-model"\n';
writeFileSync(join(codexHome, 'config.toml'), originalCodex);
const installEnvironment = { ...process.env, CODEX_HOME: codexHome };
const installer = resolve('release-output',`dsh-mcp-${config.version}-setup-win-x64.exe`);
async function run(exe,args,options={}) {
  const { allowFailure = false, ...spawnOptions } = options;
  const child = spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],...spawnOptions});
  let output=''; child.stdout.on('data',x=>{output+=x;}); child.stderr.on('data',x=>{output+=x;});
  const timeout=setTimeout(()=>child.kill(),180000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});clearTimeout(timeout);
  if (!allowFailure) assert.equal(code,0,output || `${exe} exited ${code}`); return output;
}
const args=['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS',`/DIR=${install}`,`/WORKSPACE=${workspace}`,`/DATADIR=${data}`,`/LOG=${join(directory,'install.log')}`];
if (!process.argv.includes('--online')) args.push('/PACKAGEDIR='+resolve('release-output'));
const upgradeIndex = process.argv.indexOf('--upgrade-from');
const upgradeFrom = upgradeIndex < 0 ? undefined : process.argv[upgradeIndex + 1];
let previousConfig;
if (upgradeIndex >= 0) {
  assert.match(upgradeFrom ?? '', /^0\.1\.[01]$/);
  const baselineArgs = args.filter(arg => !arg.startsWith('/LOG='));
  await run(resolve('release-output', `dsh-mcp-${upgradeFrom}-setup-win-x64.exe`),
    [...baselineArgs, `/LOG=${join(directory, 'baseline-install.log')}`], { env: installEnvironment });
  const configPath = join(install, 'dsh.config.json');
  const settings = JSON.parse(readFileSync(configPath, 'utf8')); settings.max_concurrent_agents = 2;
  writeFileSync(configPath, JSON.stringify(settings, null, 2)); previousConfig = readFileSync(configPath, 'utf8');
  writeFileSync(join(data, 'keep-on-upgrade.txt'), 'existing user data');
  if (process.argv.includes('--through-failed-012')) {
    // Replay the published v0.1.2 payloads and original initializer without its error dialog.
    for (const archive of ['dsh-mcp-0.1.2-win-x64.zip', 'deepseek-harness-cli-0.2.2-alpha.2-dsh-mcp-0.1.2-win-x64.zip']) {
      await run('tar.exe', ['-xf', resolve('release-output', archive), '-C', install]);
    }
    const failure = await run(join(install, 'bin/node/node.exe'), [join(install, 'packaging/initialize.mjs')], { env: installEnvironment, allowFailure: true });
    assert.match(failure, /Conflicting runtime dependency/);
    writeFileSync(join(directory, 'failed-012-initialization.log'), failure);
    const manifest = JSON.parse(readFileSync(join(install, 'core-manifest.json'), 'utf8'));
    const expected = manifest.links.find(link => link.path === 'node_modules/electron').target;
    assert.notEqual(realpathSync(join(install, 'node_modules/electron')), realpathSync(join(install, expected)), 'Reproduce the old upgrade conflict before testing the fix.');
  }
}
await run(installer,args,{env:installEnvironment});
const initialization = JSON.parse(readFileSync(join(install, 'initialization-result.json'), 'utf8'));
assert.equal(initialization.status, 'ready');
if (previousConfig) {
  assert.equal(readFileSync(join(install, 'dsh.config.json'), 'utf8'), previousConfig);
  assert.equal(readFileSync(join(data, 'keep-on-upgrade.txt'), 'utf8'), 'existing user data');
  assert(initialization.links.migrated > 0, 'The upgrade must migrate existing runtime links.');
}
assert.match(readFileSync(join(codexHome, 'config.toml'),'utf8'), /\[mcp_servers\.dsh\]/);
assert(readFileSync(join(codexHome, 'config.toml'),'utf8').startsWith(originalCodex));
assert(existsSync(join(install,'codex-mcp.toml')));
assert(existsSync(join(install,'node_modules/@deepseek-ai/dsh/lib/bin.js')));
const node=join(install,'bin/node/node.exe'), python=join(install,'bin/python/python.exe');
const cfg=join(install,'dsh.config.json');
const doctor=JSON.parse(await run(node,[join(install,'packaging/launch-server.mjs'),'--config',cfg,'--doctor']));
assert(doctor.cli_exists && doctor.versions_match); assert.equal(doctor.cli_version,config.core_version);
assert.equal(doctor.workspace_root,workspace); assert.equal(doctor.data_dir,data);
if (process.env.DSH_TEST_CODEX_EXE) {
  const registered = await run(process.env.DSH_TEST_CODEX_EXE, ['mcp','get','dsh','--json'], { env:installEnvironment });
  assert(registered.includes('launch-server.mjs'));
  writeFileSync(join(directory,'codex-readback.json'),registered);
}
await run(python,['-I','-B','-c','import ctypes, json, importlib, pathlib; print("embedded Python ready")']);
// Ensure initialization is idempotent and does not overwrite existing user settings.
const original=readFileSync(cfg,'utf8'); await run(node,[join(install,'packaging/initialize.mjs')]); assert.equal(readFileSync(cfg,'utf8'),original);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.DSH_UI_LOCALE;delete env.DEEPSEEK_API_KEY;
let desktop;
try {
  const require=createRequire(join(install,'package.json'));
  desktop=await electron.launch({executablePath:require('electron'),args:[join(install,'desktop/main.mjs'),'--config',cfg],env,timeout:30000});
  const page=await desktop.firstWindow();
  await page.getByRole('combobox').selectOption('en-US');
  await page.getByRole('button',{name:'Manage API keys',exact:true}).waitFor();
  await page.screenshot({path:join(directory,'packaged-ui.png')});
} finally { await desktop?.close(); }
const autoStart = await run(process.execPath,[resolve('scripts/test-ui-autostart.mjs')],{env:{...env,DSH_RELEASE_ROOT:install}});
writeFileSync(join(directory,'ui-autostart.log'),autoStart);
writeFileSync(join(directory,'orb-ui.log'), await run(process.execPath,[resolve('scripts/test-orb-ui.mjs')],{env:{...env,DSH_RELEASE_ROOT:install}}));
const smoke=await run(process.execPath,[resolve('scripts/smoke.mjs')],{env:{...env,DSH_RELEASE_ROOT:install}});
writeFileSync(join(directory,'smoke.log'),smoke);
writeFileSync(join(data,'keep-on-uninstall.txt'),'user data must survive uninstall');
await run(join(install,'unins000.exe'),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',`/LOG=${join(directory,'uninstall.log')}`]);
assert(existsSync(join(data,'keep-on-uninstall.txt')));
assert(!existsSync(join(install,'bin/node/node.exe')));
assert.equal(readFileSync(join(codexHome, 'config.toml'),'utf8'), originalCodex);
const report={directory,online:process.argv.includes('--online'),upgrade_from:upgradeFrom,through_failed_012:process.argv.includes('--through-failed-012'),initialization,doctor,checks:['installer','embedded runtimes','CLI resolution','idempotent initialization','English UI','MCP auto-opens UI without duplicate windows','floating orb with live concurrency and drag/restore','real MCP/SDK/CLI mock tasks','uninstall preserves user data',...(upgradeFrom?['upgrade migrates links and preserves configuration/data']:[])],paid_api_calls:0};
writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
