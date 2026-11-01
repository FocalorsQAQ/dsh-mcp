import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const runtime=resolve(process.env.DSH_RELEASE_ROOT ?? '.');
const runtimeNode=process.env.DSH_RELEASE_ROOT ? join(runtime,'bin/node/node.exe') : process.execPath;
const { OutsourcingSwitch }=await import(pathToFileURL(join(runtime,'dist/global-control.js')));
const directory = mkdtempSync(resolve('.test-output/codex-snapshot-')), home = join(directory, 'home'), data = join(directory, 'data'); mkdirSync(home);
const observed = [], notices = []; let latestPayload;
const mock = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  try { const payload = JSON.parse(body); latestPayload = payload; const serialized = JSON.stringify(payload); observed.push({ path: req.url, disable_notice: serialized.includes('外包已禁用'), status_check_instruction: serialized.includes('Call get_status before delegating'), tools: payload.tools?.map(t => ({ name:t.name, type:t.type, tools:t.tools?.map(x=>x.name) })) }); }
  catch { observed.push({ path:req.url }); }
  res.writeHead(200, {'content-type':'text/event-stream'});
  const id = 'resp_local_' + observed.length;
  res.end('data: ' + JSON.stringify({type:'response.created',response:{id,status:'in_progress',output:[]}}) + '\n\n' +
    'data: ' + JSON.stringify({type:'response.completed',response:{id,status:'completed',output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0}}}}) + '\n\n');
});
mock.listen(0,'127.0.0.1'); await once(mock,'listening');
const cfg = join(directory,'dsh.json'); writeFileSync(cfg,JSON.stringify({workspace_root:directory,data_dir:data,codex_home:home,ui_auto_start:false,control:{enabled:false},session_idle_timeout_ms:1000,...(process.env.DSH_RELEASE_ROOT?{billing:{python:join(runtime,'bin/python/python.exe'),rules:join(runtime,'billing/rules.py')}}:{})}));
const q=s=>JSON.stringify(s.replaceAll('\\','/'));
writeFileSync(join(home,'config.toml'), 'model = "gpt-5"\nmodel_provider = "local_test"\n[model_providers.local_test]\nname = "Local probe"\nbase_url = "http://127.0.0.1:' + mock.address().port + '/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[mcp_servers.dsh]\ncommand = ' + q(runtimeNode) + '\nargs = [' + [join(runtime,'packaging/launch-server.mjs'),'--config',cfg].map(q).join(',') + ']\n');
const ps=s=>"'"+s.replaceAll("'", "''")+"'";
const hookCommand='& '+[runtimeNode,join(runtime,'packaging/prompt-hook.mjs'),'--config',cfg].map(ps).join(' ');
const file=join(home,'config.toml');
writeFileSync(file,readFileSync(file,'utf8')+'\n[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = '+JSON.stringify(hookCommand)+'\ntimeout = 15\n');
const env={...process.env,CODEX_HOME:home}; delete env.CODEX_THREAD_ID; delete env.OPENAI_API_KEY; delete env.DEEPSEEK_API_KEY;
assert(process.env.DSH_TEST_CODEX_EXE, 'Set DSH_TEST_CODEX_EXE.');
// The test home contains only our reviewed fixture hook. This per-test override is never installed or persisted.
const child=spawn(process.env.DSH_TEST_CODEX_EXE,['-c','features.hooks=true','-c','features.code_mode_host=true','-c','features.prefer_mxc=true','app-server'],{env,cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
let sequence=0,stderr=''; const pending=new Map(); child.stderr.on('data',c=>{stderr=(stderr+c).slice(-6000)});
createInterface({input:child.stdout}).on('line',line=>{const msg=JSON.parse(line); if(msg.method)notices.push(msg); const p=pending.get(msg.id); if(p){pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}});
const call=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(new Error(method+' timed out')),30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
const until=async check=>{const limit=Date.now()+20000; while(!check()){if(Date.now()>limit)throw new Error('wait timeout');await new Promise(r=>setTimeout(r,100));}};
try {
  await call('initialize',{clientInfo:{name:'local_refresh_probe',version:'1'},capabilities:{experimentalApi:true}}); child.stdin.write('{"method":"initialized"}\n');
  const id=(await call('thread/start',{config:{bypass_hook_trust:true},cwd:directory,ephemeral:false,approvalPolicy:'never',sandbox:'read-only',model:'gpt-5',modelProvider:'local_test'})).thread.id;
  const hooks=await call('hooks/list',{threadId:id});
  assert.equal(hooks.data[0].errors.length,0,JSON.stringify(hooks));
  const gate=new OutsourcingSwitch(data,process.env.DSH_RELEASE_ROOT?join(runtime,'bin/python/python.exe'):'python',false);
  const snapshots=[];
  for(const enabled of [true,false]){
    gate.updateSettings({enabled,round_budget:enabled?[2,10]:[1,3],max_root_agents:enabled?3:1},gate.snapshot().revision);
    const start=notices.length;
    const turn=(await call('turn/start',{threadId:id,input:[{type:'text',text:'Local fixture. Reply OK.',text_elements:[]}]})).turn.id;
    await until(()=>notices.slice(start).some(n=>n.method==='turn/completed'));
    const path=join(data,'task-snapshots',id,turn+'.json');
    assert(existsSync(path),'Snapshot must exist before the first model request; hook notices: '+JSON.stringify(notices.filter(n=>n.method.includes('hook'))));
    const captured=JSON.parse(readFileSync(path,'utf8')); snapshots.push(captured);
    assert.equal(captured.settings.enabled,enabled);
    assert(JSON.stringify(latestPayload).includes('[dsh task configuration'), 'Hook must inject configuration before the model starts');
    gate.updateSettings({enabled:!enabled,max_root_agents:12,round_budget:[7,8]},gate.snapshot().revision);
    const status=await call('mcpServer/tool/call',{threadId:id,server:'dsh',tool:'get_status',arguments:{}});
    assert(!status.isError,JSON.stringify(status));
    assert.equal(status.structuredContent.enabled,enabled,'Later edits cannot affect the submitted turn');
    if(enabled){assert.equal(status.structuredContent.control.max_root_agents,3);assert.deepEqual(status.structuredContent.control.budget,[2,10]);}
  }
  assert.notEqual(snapshots[0].turn_id,snapshots[1].turn_id);
  console.log(JSON.stringify({ok:true,checks:['actual Codex UserPromptSubmit', 'snapshot before model', 'developer context injection', 'settings immutable across live edits', 'same chat next submission refresh', 'no paid API'],directory}));
} catch(error){console.log(String(error));process.exitCode=1;}
finally {writeFileSync(join(directory,'report.json'),JSON.stringify({observed,notices,stderr},null,2));console.log(directory);child.stdin.end();child.kill();mock.closeAllConnections();mock.close();for(const p of pending.values())clearTimeout(p.timer);}

