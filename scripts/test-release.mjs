import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const root = resolve('.test-output/release'); mkdirSync(root, {recursive:true});
const directory = mkdtempSync(join(root,'run-'));
const install = join(directory,'installed app'), data=join(directory,'user-data'), workspace=join(directory,'workspace');
const config = JSON.parse(readFileSync('packaging/release.json','utf8'));
const installer = resolve('release-output',`dsh-mcp-${config.version}-setup-win-x64.exe`);
async function run(exe,args,options={}) {
  const child = spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],...options});
  let output=''; child.stdout.on('data',x=>{output+=x;}); child.stderr.on('data',x=>{output+=x;});
  const timeout=setTimeout(()=>child.kill(),180000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});clearTimeout(timeout);
  assert.equal(code,0,output || `${exe} exited ${code}`); return output;
}
const args=['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS',`/DIR=${install}`,`/WORKSPACE=${workspace}`,`/DATADIR=${data}`,`/LOG=${join(directory,'install.log')}`];
if (!process.argv.includes('--online')) args.push('/PACKAGEDIR='+resolve('release-output'));
await run(installer,args);
assert(existsSync(join(install,'codex-mcp.toml')));
assert(existsSync(join(install,'node_modules/@deepseek-ai/dsh/lib/bin.js')));
const node=join(install,'bin/node/node.exe'), python=join(install,'bin/python/python.exe');
const cfg=join(install,'dsh.config.json');
const doctor=JSON.parse(await run(node,[join(install,'packaging/launch-server.mjs'),'--config',cfg,'--doctor']));
assert(doctor.cli_exists && doctor.versions_match); assert.equal(doctor.cli_version,config.core_version);
assert.equal(doctor.workspace_root,workspace); assert.equal(doctor.data_dir,data);
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
const smoke=await run(process.execPath,[resolve('scripts/smoke.mjs')],{env:{...env,DSH_RELEASE_ROOT:install}});
writeFileSync(join(directory,'smoke.log'),smoke);
writeFileSync(join(data,'keep-on-uninstall.txt'),'user data must survive uninstall');
await run(join(install,'unins000.exe'),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',`/LOG=${join(directory,'uninstall.log')}`]);
assert(existsSync(join(data,'keep-on-uninstall.txt')));
assert(!existsSync(join(install,'bin/node/node.exe')));
const report={directory,online:process.argv.includes('--online'),doctor,checks:['installer','embedded runtimes','CLI resolution','idempotent initialization','English UI','real MCP/SDK/CLI mock tasks','uninstall preserves user data'],paid_api_calls:0};
writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
