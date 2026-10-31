import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const output = resolve('.test-output/codex-registration'); mkdirSync(output, { recursive:true });
function fixture(original = '') {
  const root = mkdtempSync(join(output,'run-')), home=join(root,'codex-home');mkdirSync(home);
  writeFileSync(join(root,'codex-mcp.toml'),'[mcp_servers.dsh]\ncommand = "node"\nargs = ["dsh.js"]\ntool_timeout_sec = 75\n');
  writeFileSync(join(home,'config.toml'),original);
  const call = (action:string) => {
    const result=spawnSync('python',['-I','-B',resolve('packaging/codex_registration.py'),action,'--root',root,'--codex-home',home],{encoding:'utf8',windowsHide:true});
    assert(!result.error);return {code:result.status,...JSON.parse(result.stdout)};
  };
  return {root,home,call,read:()=>readFileSync(join(home,'config.toml'),'utf8')};
}
test('Codex registration preserves settings, backs up, is idempotent, and removes only its entry',()=>{
  const original='# keep this comment\nmodel = "existing"\n[mcp_servers.other]\ncommand = "other"\n';
  const f=fixture(original);assert.equal(f.call('register').status,'registered');assert(f.read().startsWith(original));
  const backups=readdirSync(f.home).filter(x=>x.startsWith('config.toml.dsh-backup-'));assert.equal(backups.length,1);
  assert.equal(readFileSync(join(f.home,backups[0]!),'utf8'),original);
  const registered=f.read();assert.equal(f.call('register').status,'already_registered');assert.equal(f.read(),registered);
  const extra='\n[extra]\nvalue = 1\n';writeFileSync(join(f.home,'config.toml'),registered+extra);
  assert.equal(f.call('unregister').status,'removed');assert.equal(f.read(),original+extra);
});
test('Codex registration never replaces an existing different dsh or malformed configuration',()=>{
  for(const original of ['[mcp_servers.dsh]\ncommand = "owned-by-user"\n','bad = [','mcp_servers = { other = { command = "x" } }\n']) {
    const f=fixture(original);assert.equal(f.call('register').code,2);assert.equal(f.read(),original);
  }
});
test('Codex uninstall preserves user-edited and pre-existing matching entries',()=>{
  const f=fixture();assert.equal(f.call('register').status,'registered');
  const changed=f.read().replace('tool_timeout_sec = 75','tool_timeout_sec = 90');writeFileSync(join(f.home,'config.toml'),changed);
  assert.equal(f.call('unregister').status,'changed_preserved');assert.equal(f.read(),changed);
  const g=fixture('[mcp_servers.dsh]\ncommand = "node"\nargs = ["dsh.js"]\ntool_timeout_sec = 75\n');
  assert.equal(g.call('register').status,'already_registered');assert.equal(g.call('unregister').status,'not_owned');
  assert(g.read().includes('[mcp_servers.dsh]'));
});
