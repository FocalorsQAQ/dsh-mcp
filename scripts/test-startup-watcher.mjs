import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const runtime = resolve(process.env.DSH_RELEASE_ROOT ?? '.');
const python = process.env.DSH_RELEASE_ROOT ? join(runtime,'bin/python/python.exe') : 'python';
const node = process.env.DSH_RELEASE_ROOT ? join(runtime,'bin/node/node.exe') : process.execPath;
const directory = mkdtempSync((mkdirSync(resolve('.test-output/ui-autostart'),{recursive:true}),resolve('.test-output/ui-autostart/watch-')));
const config = join(directory,'config.json'), data = join(directory,'data');
const settings = { workspace_root: directory, data_dir: data, ui_auto_start: true,
  ...(process.env.DSH_RELEASE_ROOT ? {billing:{python,rules:join(runtime,'billing/rules.py')}}:{}) };
writeFileSync(config,JSON.stringify(settings));
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_THREAD_ID;
const run = async (exe,args) => {
  const child = spawn(exe,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']}); let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk});
  const timer=setTimeout(()=>child.kill(),30000);
  const [code]=await once(child,'exit');clearTimeout(timer); assert.equal(code,0,stderr);return stdout;
};
const watchArgs=[join(runtime,'runtime/codex_watch.py'),'--root',runtime,'--config',config];
const inspect=async()=>JSON.parse(await run('powershell.exe',['-NoProfile','-File',resolve('scripts/test-ui-window.ps1'),'-ConfigPath',config]));
const until=async check=>{const deadline=Date.now()+30000;while(!(await check())){assert(Date.now()<deadline,'Startup check timed out');await new Promise(r=>setTimeout(r,200));}};
const status=()=>{try{return JSON.parse(readFileSync(join(directory,'ui-startup-status.json'),'utf8'))}catch{return {}}};
const close=()=>run(node,[join(runtime,'scripts/start-ui.mjs'),'--config',config,'--quit']);
let companion, fixture;
const fixtureExe=join(directory,'Codex.exe');
const startFixture=()=>{fixture=spawn(fixtureExe,[],{windowsHide:true,stdio:'ignore'});return once(fixture,'spawn');};
try {
  await run('powershell.exe',['-NoProfile','-File',resolve('scripts/test-codex-window.ps1'),'-OutputPath',fixtureExe]);
  const probe=JSON.parse(await run(python,['-I','-B',...watchArgs,'--probe']));
  if(!probe.codex.length)await startFixture();
  const started=Date.now();
  companion=spawn(python,['-I','-B',...watchArgs],{env,windowsHide:true,stdio:'ignore'});await once(companion,'spawn');
  await until(async()=>{const rows=await inspect();return rows.length===1&&rows[0].visible;});
  const startupMs=Date.now()-started;
  assert(status().last_launch_at);
  assert(!existsSync(join(data,'chats','discovery','state.json')),'Desktop startup must not require an MCP host');
  assert(existsSync(join(data,'outsourcing.json')),'Settings must be available before any task');
  await run(python,['-I','-B',...watchArgs]); // Single-instance companion exits immediately.
  assert.equal(status().pid,companion.pid);
  assert.equal((await inspect()).length,1);
  await close();await until(async()=>(await inspect()).length===0);
  await new Promise(r=>setTimeout(r,1600));assert.equal((await inspect()).length,0,'Manual close must stay closed');
  fixture?.kill();if(fixture)await once(fixture,'exit');
  await startFixture(); // A new desktop process generation opens the panel again.
  await until(async()=>(await inspect()).some(row=>row.visible));
  assert.equal((await inspect()).length,1);
  await close();await until(async()=>(await inspect()).length===0);
  writeFileSync(config,JSON.stringify({...settings,ui_auto_start:false}));
  fixture.kill();await once(fixture,'exit');await startFixture();
  await until(()=>status().enabled===false);await new Promise(r=>setTimeout(r,1000));
  assert.equal((await inspect()).length,0,'Explicit opt-out must suppress desktop startup');
  const report={ok:true,directory,startup_ms:startupMs,paid_api_calls:0,checks:['native Windows desktop detection','UI before MCP or work','single companion and control window','manual close respected','new Codex process reopens UI','ui_auto_start opt-out']};
  writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {
  await run(python,['-I','-B',...watchArgs,'--stop']).catch(()=>{});
  companion?.kill();fixture?.kill();await close().catch(()=>{});
}
