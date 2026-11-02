import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { _electron as electron } from 'playwright-core';

assert.equal(process.platform, 'win32');
const runtime = resolve(process.env.DSH_RELEASE_ROOT ?? '.');
const require = createRequire(join(runtime, 'package.json')), executablePath = require('electron');
const output = resolve('.test-output/owned-windows'); mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'run-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check) {
  const deadline = Date.now() + 15000;
  while (!(await check())) { assert(Date.now() < deadline, 'Window check timed out'); await wait(25); }
}
const env = { ...process.env, DSH_UI_LOCALE: 'en-US' }; delete env.ELECTRON_RUN_AS_NODE;
let parent, desktop;
const requests = [];
const server = createServer((req, res) => {
  let body = ''; req.on('data', data => body += data); req.on('end', () => {
    requests.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'response', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1 } }));
  });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port + '/v1';
const parentScript = join(directory, 'parent.cjs');
writeFileSync(parentScript, `const { app, BrowserWindow } = require('electron');
app.setPath('userData',${JSON.stringify(join(directory, 'parent-data'))});
app.whenReady().then(() => { globalThis.host = new BrowserWindow({width:520,height:350,show:false});
globalThis.changes=[];for(const name of ['minimize','restore','maximize','unmaximize','hide','show'])host.on(name,()=>changes.push(name));
host.loadURL('data:text/html,<h2>DSH isolated owner regression fixture</h2>');host.show(); });`);
const reports = [];
try {
  parent = await electron.launch({ executablePath, args: [parentScript], env }); await parent.firstWindow();
  const owner = await parent.evaluate(() => host.getNativeWindowHandle().readBigUInt64LE().toString());
  // Keep the real helper's attach loop/lifetime; replace only Codex discovery
  // with our separate process fixture. No real Codex window is changed.
  const fixtureHelper = join(directory, 'owner-window.ps1');
  const helperSource = readFileSync(join(runtime, 'desktop/owner-window.ps1'), 'utf8');
  const helper = helperSource.replace(/public static bool IsCodex\(IntPtr h\) \{[\s\S]*?\n  public static IntPtr FindCodex/, `public static bool IsCodex(IntPtr h) { return h == new IntPtr(${owner}); }\n  public static IntPtr FindCodex`);
  assert.notEqual(helper, helperSource); writeFileSync(fixtureHelper, helper);
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ workspace_root: directory, data_dir: join(directory, 'data'), ui_auto_start: false,
    completion_delivery: { mode: 'off' }, ...(process.env.DSH_RELEASE_ROOT ? { billing: { python: join(runtime, 'bin/python/python.exe'), rules: join(runtime, 'billing/rules.py') } } : {}) }));
  const boot = join(directory, 'boot.mjs'), closingReport = join(directory, 'closed.json');
  writeFileSync(boot, `import { app } from 'electron';import cp from 'node:child_process';import {syncBuiltinESMExports,createRequire} from 'node:module';import fs from 'node:fs';
const require=createRequire(${JSON.stringify(pathToFileURL(join(runtime, 'package.json')).href)}),k=require('koffi'),u=k.load('user32.dll');
const get=u.func('uintptr_t __stdcall GetWindow(uintptr_t,uint32_t)'), post=u.func('bool __stdcall PostMessageW(uintptr_t,uint32_t,uintptr_t,intptr_t)');
const cls=u.func('int __stdcall GetClassNameW(uintptr_t,void *,int)'),pid=u.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t,_Out_ uint32_t *)');
const cb=k.proto('bool __stdcall DshEnum(uintptr_t,intptr_t)'),enumerate=u.func('bool __stdcall EnumWindows(DshEnum *,intptr_t)');
globalThis.nativeOwner=w=>Number(get(w.getNativeWindowHandle().readBigUInt64LE(),4));
globalThis.confirmNative=()=>{let pressed=false;enumerate(h=>{const p=[0];pid(h,p);const text=Buffer.alloc(512);cls(h,text,256);
if(p[0]===process.pid&&text.toString('utf16le').split('\\0')[0]==='#32770'){post(h,1126,100,0);pressed=true;}return true;},0);return pressed;};
const original=cp.spawn;globalThis.ownerHelper=undefined;cp.spawn=(exe,args,...rest)=>{
if(args?.some(a=>String(a).endsWith('owner-window.ps1'))){args=args.map(a=>String(a).endsWith('owner-window.ps1')?${JSON.stringify(fixtureHelper)}:a);globalThis.ownerHelper=original(exe,args,...rest);return globalThis.ownerHelper;}return original(exe,args,...rest);};syncBuiltinESMExports();
globalThis.closedWindows=[];globalThis.readyWindows=[];app.on('browser-window-created',(_event,w)=>{w.once('ready-to-show',()=>{readyWindows.push(w.id);w.on('close',event=>{
if(event.defaultPrevented)return;closedWindows.push({id:w.id,url:w.webContents.getURL(),owner:nativeOwner(w),electronParent:w.getParentWindow()?.id??null,
helperStopped:!globalThis.ownerHelper||ownerHelper.exitCode!==null||ownerHelper.signalCode!==null});fs.writeFileSync(${JSON.stringify(closingReport)},JSON.stringify(closedWindows));});});});
process.argv=[process.argv[0],${JSON.stringify(join(runtime, 'desktop/main.mjs'))},'--config',${JSON.stringify(config)},'--auto-start'];
await import(${JSON.stringify(pathToFileURL(join(runtime, 'desktop/main.mjs')).href)});`);
  const hostState = () => parent.evaluate(() => ({ minimized: host.isMinimized(), maximized: host.isMaximized(), visible: host.isVisible(), enabled: host.isEnabled(), bounds: host.getBounds() }));
  const launch = async () => {
    desktop = await electron.launch({ executablePath, args: [boot], env });
    const page = await desktop.firstWindow(); await page.getByRole('button', { name: 'Close DSH as Subagent', exact: true }).waitFor();
    await until(() => desktop.evaluate(({ BrowserWindow }) => nativeOwner(BrowserWindow.getAllWindows()[0]) !== 0));
    return page;
  };
  const open = async (page, kind) => {
    const event = desktop.waitForEvent('window');
    await page.evaluate(kind => window.dsh.openManagementWindow(kind), kind);
    const result = await event; await result.waitForLoadState('domcontentloaded');
    await until(() => desktop.evaluate(({ BrowserWindow }, suffix) => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().endsWith(suffix) && readyWindows.includes(w.id)), kind === 'api_keys' ? '#api-keys' : '#models'));
    return result;
  };
  const confirm = async click => {
    let failure;
    const pending = click().catch(error => { failure = error; });
    await until(() => { if (failure) throw failure; return desktop.evaluate(() => confirmNative()); });
    await pending;
    if (failure) throw failure;
  };
  for (const mode of ['normal', 'maximized', 'minimized']) {
    await parent.evaluate(() => { host.restore(); host.show(); });
    const page = await launch();
    // Exercise configuration writes and an actual native confirmation dialog.
    const apiPage = await open(page, 'api_keys');
    const api = await apiPage.evaluate(async base => {
      const old = await window.dsh.apis.list();
      if (old.value.entries.length) return old.value.entries[0];
      const added = await window.dsh.apis.add({ name: 'Window test', protocol: 'openai_responses', base_url: base, api_key: 'local-only-dummy', expected_revision: old.value.revision });
      return added.value.entries[0];
    }, base);
    const modelPage = await open(page, 'models');
    await modelPage.getByRole('button', { name: 'Add model', exact: true }).waitFor();
    await confirm(() => modelPage.evaluate(async api => {
      const list = await window.dsh.models.list();
      const result = await window.dsh.models.verify({ draft: { api_id: api.id, model_id: 'probe-' + Date.now(), reasoning_levels: ['none', 'high'] }, expected_revision: list.value.revision });
      if (!result.ok || result.value.cancelled) throw Error(JSON.stringify(result));
    }, api));
    if (mode === 'maximized') await parent.evaluate(() => host.maximize());
    if (mode === 'minimized') await parent.evaluate(() => host.minimize());
    await wait(250);
    const before = await hostState(); await parent.evaluate(() => { changes.length = 0; });
    const allowClosed = error => { if (!/closed|destroyed/i.test(error.message)) throw error; };
    const apiClosed = apiPage.waitForEvent('close');
    await apiPage.evaluate(() => window.dsh.apis.close()).catch(allowClosed); await apiClosed;
    const modelClosed = modelPage.waitForEvent('close');
    await modelPage.evaluate(() => window.dsh.models.close()).catch(allowClosed); await modelClosed;
    await wait(150);
    assert.deepEqual(await hostState(), before, 'Closing configuration pages changed the external owner: ' + mode);
    assert.deepEqual(await parent.evaluate(() => changes), []);
    // Also close the main window while both configuration pages are still open.
    await open(page, 'api_keys'); await open(page, 'models');
    // A minimized owner hides its owned windows; use maintenance shutdown there.
    const closed = desktop.waitForEvent('close');
    if (mode === 'minimized') await desktop.evaluate(({ app }) => app.quit());
    else await confirm(() => page.evaluate(() => window.dsh.windowAction('close')).catch(error => {
      if (!/closed|destroyed/i.test(error.message)) throw error;
    }));
    await closed; desktop = undefined; await wait(150);
    assert.deepEqual(await hostState(), before, 'Closing control window changed the external owner: ' + mode);
    assert.deepEqual(await parent.evaluate(() => changes), []);
    const recorded = JSON.parse(readFileSync(closingReport, 'utf8'));
    assert.equal(new Set(recorded.map(row => row.id)).size, 5);
    assert(recorded.every(row => row.owner === 0 && row.electronParent === null), 'Every window must be detached before native destruction');
    assert(recorded.find(row => !row.url.includes('#')).helperStopped, 'Owner helper must exit before closing control');
    reports.push({ mode, before, after: await hostState(), detached_windows: recorded.length });
  }
  assert.equal(requests.length, 3);
  const report = { ok: true, directory, paid_api_calls: 0, loopback_requests: requests.length, reports,
    checks: ['API/model pages after edits and native model confirmation', 'real close confirmation', 'owner helper exits before detach',
      'all windows detached before destruction', 'normal/maximized/minimized external owner state preserved', 'maintenance shutdown'] };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await desktop?.close(); await parent?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
