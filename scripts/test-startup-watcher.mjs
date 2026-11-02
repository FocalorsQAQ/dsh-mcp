import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

let runtime = resolve(process.env.DSH_RELEASE_ROOT ?? '.');
let python = process.env.DSH_RELEASE_ROOT ? join(runtime,'bin/python/python.exe') : 'python';
const node = process.env.DSH_RELEASE_ROOT ? join(runtime,'bin/node/node.exe') : process.execPath;
const directory = mkdtempSync((mkdirSync(resolve('.test-output/ui-autostart'),{recursive:true}),resolve('.test-output/ui-autostart/watch-')));
const config = join(directory,'config.json'), data = join(directory,'data');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.CODEX_THREAD_ID;
const run = async (exe,args) => {
  const child = spawn(exe,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']}); let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk});
  const timer=setTimeout(()=>child.kill(),30000);
  const [code]=await once(child,'exit');clearTimeout(timer); assert.equal(code,0,stderr);return stdout;
};
if (!process.env.DSH_RELEASE_ROOT) {
  // Explorer does not inherit Codex's private PATH. Model the packaged runtime layout explicitly.
  python=(await run(python,['-I','-c','import sys; print(sys.executable)'])).trim();
  const source=runtime;
  runtime=join(directory,'runtime');mkdirSync(join(runtime,'bin'),{recursive:true});
  for(const folder of ['runtime','scripts','desktop','dist','dist-ui','resources','billing','node_modules'])
    symlinkSync(join(source,folder),join(runtime,folder),'junction');
  symlinkSync(dirname(node),join(runtime,'bin/node'),'junction');
  symlinkSync(dirname(python),join(runtime,'bin/python'),'junction');
}
const settings = { workspace_root: directory, data_dir: data, ui_auto_start: true,
  billing:{python,rules:join(runtime,'billing/rules.py')} };
writeFileSync(config,JSON.stringify(settings));
const watchArgs=[join(runtime,'runtime/codex_watch.py'),'--root',runtime,'--config',config];
const inspect=async()=>JSON.parse(await run('powershell.exe',['-NoProfile','-File',resolve('scripts/test-ui-window.ps1'),'-ConfigPath',config]));
const until=async check=>{const deadline=Date.now()+30000;while(!(await check())){assert(Date.now()<deadline,'Startup check timed out');await new Promise(r=>setTimeout(r,200));}};
const status=()=>{try{return JSON.parse(readFileSync(join(directory,'ui-startup-status.json'),'utf8'))}catch{return {}}};
const close=()=>run(node,[join(runtime,'scripts/start-ui.mjs'),'--config',config,'--quit']);
let fixture;
const fixtureExe=join(directory,'Codex.exe');
const startFixture=()=>{fixture=spawn(fixtureExe,[],{windowsHide:true,stdio:'ignore'});return once(fixture,'spawn');};
try {
  await run('powershell.exe',['-NoProfile','-File',resolve('scripts/test-codex-window.ps1'),'-OutputPath',fixtureExe]);
  const probe=JSON.parse(await run(python,['-I','-B',...watchArgs,'--probe']));
  if(!probe.codex.length)await startFixture();
  const started=Date.now();
  const lifecycle=JSON.parse(await run(python,['-I','-B',resolve('tests/fixtures/start-companion-job.py'),runtime,config]));
  assert.equal(lifecycle.kill_on_launcher_exit,true);
  assert.equal(lifecycle.companion.status,'started');
  await until(async()=>{const rows=await inspect();return rows.length===1&&rows[0].visible;});
  assert.equal(JSON.parse(await run(python,['-I','-B',...watchArgs,'--probe'])).companion_ready,true,'Companion must survive its launcher job exiting');
  const startupMs=Date.now()-started;
  assert(status().last_launch_at);
  assert(!existsSync(join(data,'chats','discovery','state.json')),'Desktop startup must not require an MCP host');
  assert(existsSync(join(data,'outsourcing.json')),'Settings must be available before any task');
  const firstPid=status().pid;
  await run(python,['-I','-B',...watchArgs]); // Single-instance companion exits immediately.
  assert.equal(JSON.parse(await run(python,['-I','-B',...watchArgs,'--ensure-running'])).status,'running');
  assert.equal(status().pid,firstPid);
  assert.equal((await inspect()).length,1);
  await close();await until(async()=>(await inspect()).length===0);
  await new Promise(r=>setTimeout(r,1600));assert.equal((await inspect()).length,0,'Manual close must stay closed');
  // Losing the watcher is recoverable without reopening a deliberately closed UI in this generation.
  process.kill(firstPid); // This PID came from our unique disposable config's status.
  await until(async()=>!JSON.parse(await run(python,['-I','-B',...watchArgs,'--probe'])).companion_ready);
  assert.equal(JSON.parse(await run(python,['-I','-B',...watchArgs,'--ensure-running'])).status,'started');
  await until(()=>status().pid!==firstPid);
  await new Promise(r=>setTimeout(r,1600));assert.equal((await inspect()).length,0,'Watcher recovery must retain manual closure');
  fixture?.kill();if(fixture)await once(fixture,'exit');
  await startFixture(); // A new desktop process generation opens the panel again.
  await until(async()=>(await inspect()).some(row=>row.visible));
  assert.equal((await inspect()).length,1);
  await close();await until(async()=>(await inspect()).length===0);
  writeFileSync(config,JSON.stringify({...settings,ui_auto_start:false}));
  fixture.kill();await once(fixture,'exit');await startFixture();
  await until(()=>status().enabled===false);await new Promise(r=>setTimeout(r,1000));
  assert.equal((await inspect()).length,0,'Explicit opt-out must suppress desktop startup');
  const report={ok:true,directory,startup_ms:startupMs,paid_api_calls:0,checks:['native Windows desktop detection','UI before MCP or work','survives launcher kill-on-close job','single companion and control window','manual close respected','dead companion recovery retains closure','new Codex process reopens UI','ui_auto_start opt-out']};
  writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {
  await run(python,['-I','-B',...watchArgs,'--stop']).catch(()=>{});
  fixture?.kill();await close().catch(()=>{});
}
