import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer as httpServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, type TranscriptContext, type Usage } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxThinking } from '@earendil-works/pi-ai/providers/faux';
import { Runtime, type RunRequest } from '../src/runtime.js';
import { createServer } from '../src/http.js';

async function listen(server: Server, socket?: string): Promise<string> {
  if (socket) server.listen(socket); else server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : socket!;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function request(model: string, kind: 'agent' | 'chat' = 'agent'): RunRequest {
  return {kind, sandbox:{scope_key:kind === 'chat' ? 'chat:1' : 'private:1',workspace_id:kind === 'chat' ? 'chat-user-1' : 'user-1',sandbox_id:'sandbox',lifecycle_id:'lifecycle',profile:'agent',cwd:kind === 'chat' ? '/workspace/conversation' : '/workspace'},model:{id:model,thinking:'off'},prompt:{text:'First question'},context_prefix:'<context time="first"/>',resources:{system_prompt:'Stable assistant instructions.',agents_md:{path:'/workspace/AGENTS.md',content:'PRIVATE_CONTEXT_MARKER'},skills:[{name:'example',description:'Example skill',path:'/workspace/skills/example/SKILL.md'}]},tools:['bash','web_search']};
}
type WireEvent = {seq:number;type:string;[key:string]:unknown};
async function fixture(t: TestContext, constructionGate?: {entered:()=>void;ready:Promise<void>}) {
  const home = await mkdtemp(join(tmpdir(),'pi-runtime-proof-'));
  await mkdir(join(home,'skills','bundled-example'),{recursive:true});
  await writeFile(join(home,'skills','bundled-example','SKILL.md'),'---\nname: bundled-example\ndescription: Bundled fixture skill\n---\nRead only on demand.\n');
  const executorCalls: {path:string;body:any;authorization:string|undefined}[] = [];
  const gatewayCalls: {path:string;body:any;authorization:string|undefined}[] = [];
  const cancelOutcomes: ({confirmed:boolean}|{error:string})[] = [];
  let onCancel: (()=>void) | undefined;
  const executor = httpServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    executorCalls.push({path:req.url!,body,authorization:req.headers.authorization});
    res.setHeader('content-type','application/json');
    if(req.url?.endsWith('/runs/cancel')){
      const outcome=cancelOutcomes.shift()??{confirmed:true};
      if('error' in outcome)res.statusCode=503;
      res.once('finish',()=>onCancel?.());
      res.end(JSON.stringify(outcome));
    }else res.end(JSON.stringify(req.url?.endsWith('/audit') ? {audit_id:body.audit_id,executor_id:'fake-executor'} : {result:{stdout:'/workspace/.pi-bash-test.log\n15\n1\nsandbox output\n',stderr:'',exit_code:0,status:'completed'}}));
  });
  const gateway = httpServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    gatewayCalls.push({path:req.url!,body:JSON.parse(Buffer.concat(chunks).toString()),authorization:req.headers.authorization});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({content:'Web result from the fake gateway',data:{url:'https://example.com'},is_error:false}));
  });
  const socket = join(home,'executor.sock');
  await listen(executor,socket);
  const platformUrl = await listen(gateway);
  const faux = fauxProvider({tokensPerSecond:1_000_000,models:[{id:'runtime-proof',reasoning:true},{id:'summary-proof',reasoning:true}]});
  const models = await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false});
  const usage: Usage[] = [];
  models.registerNativeProvider({...faux.provider,streamSimple(model,context,options){
    const stream=faux.provider.streamSimple(model,context,options);
    void stream.result().then(message=>usage.push(structuredClone(message.usage)));
    return stream;
  }});
  let modelRuntimeConstructions=0;
  const newRuntime = () => new Runtime({home,platformUrl,platformToken:'tools-secret',executorSocket:socket,executorToken:'executor-secret',skillsDirectory:join(home,'skills'),modelRuntimeFactory:async()=>{
    modelRuntimeConstructions++;
    constructionGate?.entered();await constructionGate?.ready;return models;
  }});
  let runtime = newRuntime();
  let server = createServer(runtime,'runtime-secret');
  let url = await listen(server);
  t.after(async()=>{await runtime.close();await close(server);await close(executor);await close(gateway);await rm(home,{recursive:true,force:true});});
  const http = (path:string,body?:unknown) => fetch(url+path,{method:body === undefined ? 'GET' : 'POST',headers:{authorization:'Bearer runtime-secret','content-type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(10_000)});
  async function start(sid:string,body:RunRequest) {
    const response = await http(`/v1/sessions/${sid}/runs`,body);
    assert.equal(response.status,202,await response.clone().text());
    return (await response.json() as {run_id:string}).run_id;
  }
  async function events(id:string,after=0):Promise<WireEvent[]> {
    const response = await http(`/v1/runs/${id}/events?after=${after}`);
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type')!,/text\/event-stream/);
    return (await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  }
  async function reopen() {
    await runtime.close();
    await close(server);
    runtime = newRuntime();
    server = createServer(runtime,'runtime-secret');
    url = await listen(server);
  }
  return {faux,http,start,events,reopen,executorCalls,gatewayCalls,usage,server,cancelOutcomes,get modelRuntimeConstructions(){return modelRuntimeConstructions;},onCancel(callback:()=>void){onCancel=callback;}};
}

test('HTTP rejects invalid optional model limits before admitting a run or compaction', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  for(const key of ['contextWindow','maxTokens']){
    for(const value of [-1,0,1.5,'1000']){
      const body=request('runtime-proof');
      const model={...body.model,[key]:value};
      assert.equal((await f.http('/v1/sessions/agent-private-1/runs',{...body,model})).status,400);
      assert.equal((await f.http('/v1/sessions/agent-private-1/compact',{model})).status,400);
    }
  }
  assert.equal(f.faux.state.callCount,0);
  f.faux.setResponses([fauxAssistantMessage('Valid limits admitted')]);
  const body=request('runtime-proof');
  Object.assign(body.model,{contextWindow:32_000,maxTokens:4_000});
  assert.equal((await f.events(await f.start('agent-private-1',body))).at(-1)!.text,'Valid limits admitted');
});

test('HTTP runs stream real Pi text, thinking, sandbox and gateway tools, aggregate usage, and replay by sequence', {timeout:20_000}, async t=>{
  const f = await fixture(t);
  const first = fauxAssistantMessage([fauxThinking('Consider tools'),fauxToolCall('bash',{command:'printf sandbox'}),fauxToolCall('web_search',{query:'Pi SDK'})],{stopReason:'toolUse'});
  const last = fauxAssistantMessage('Finished from sandbox and web');
  f.faux.setResponses([first,context=>{
    const results = context.messages.filter(m=>m.role==='toolResult');
    assert.equal(results.length,2);
    assert(results.every(m=>!m.isError));
    return last;
  }]);
  const id = await f.start('agent-private-1',request(f.faux.getModel().id));
  const events = await f.events(id);
  assert.deepEqual(events.map(e=>e.seq),events.map((_,i)=>i+1));
  assert.equal(events.filter(e=>e.type==='text_delta').map(e=>e.delta).join(''),'Finished from sandbox and web');
  assert.equal(events.filter(e=>e.type==='thinking_delta').map(e=>e.delta).join(''),'Consider tools');
  assert.deepEqual(events.filter(e=>e.type==='tool_start').map(e=>e.name),['bash','web_search']);
  assert(events.filter(e=>e.type==='tool_end').every(e=>e.is_error===false));
  assert.equal(f.usage.length,2);
  const sum = (key:keyof Pick<Usage,'input'|'output'|'cacheRead'|'cacheWrite'|'totalTokens'>) => f.usage.reduce((total,usage)=>total+usage[key],0);
  assert(sum('cacheRead')>0 && sum('cacheWrite')>0);
  assert.deepEqual(events.at(-1),{seq:events.length,type:'run_end',status:'completed',text:'Finished from sandbox and web',usage:{input:sum('input'),output:sum('output'),cache_read:sum('cacheRead'),cache_write:sum('cacheWrite'),total:sum('totalTokens')},model:f.faux.getModel().id,side_effects:true});
  assert.deepEqual(await f.events(id,events.length-1),[events.at(-1)]);
  assert.deepEqual(f.executorCalls.map(c=>c.path),['/v1/executor/audit','/v1/executor/terminal']);
  assert(f.executorCalls[0] && f.executorCalls[1] && f.gatewayCalls[0]);
  assert.equal(f.executorCalls[1].body.execution_context.profile,'agent');
  assert(f.executorCalls.every(c=>c.authorization==='Bearer executor-secret'));
  assert.equal(f.gatewayCalls[0].path,'/internal/agent/tools/web');
  assert.equal(f.gatewayCalls[0].authorization,'Bearer tools-secret');
  assert.equal(f.gatewayCalls[0].body.context.run_id,id);
  assert.equal(f.gatewayCalls[0].body.context.owner_user_id,1);
});

test('unchanged resources add no prompt update; an edited AGENTS.md is appended by Pi without rewriting the prefix', {timeout:20_000}, async t=>{
  const f = await fixture(t);
  const captured: TranscriptContext[] = [];
  const answer = (text:string) => (context:TranscriptContext) => {captured.push(structuredClone(context));return fauxAssistantMessage(text);};
  f.faux.setResponses([answer('First answer'),answer('Second answer'),answer('Third answer'),answer('Fourth answer')]);
  const systems = (index:number) => captured[index]!.messages.filter(m=>m.role==='system');
  const prefixKept = (later:number) => assert.deepEqual(captured[later]!.messages.slice(0,captured[later-1]!.messages.length),captured[later-1]!.messages);
  const body = request(f.faux.getModel().id);
  await f.events(await f.start('agent-private-1',body));
  const second = structuredClone(body);
  second.context_prefix = '<context time="second"/>';second.prompt.text='Second question';
  assert.equal((await f.events(await f.start('agent-private-1',second))).at(-1)!.status,'completed');
  assert.equal(f.modelRuntimeConstructions,1,'unchanged resources must reuse the live AgentSession, not reopen its transcript');
  prefixKept(1);
  const leading = JSON.stringify(systems(1));
  assert.equal(systems(1).length,1);
  assert.match(leading,/PRIVATE_CONTEXT_MARKER/);
  assert.match(leading,/platform-skills\/bundled-example\/SKILL.md/);
  assert.doesNotMatch(leading,/time=/);
  assert.deepEqual(systems(1).flatMap(m=>m.toolsAdded?.map(tool=>tool.name)??[]).sort(),['bash','web_search']);
  const last = captured[1]!.messages.at(-1)!;
  assert.equal(last.role,'user');
  assert.match(JSON.stringify(last),/second/);
  assert.match(JSON.stringify(last),/Second question/);
  const edited = structuredClone(second);
  edited.resources.agents_md = {path:'/workspace/AGENTS.md',content:'UPDATED_CONTEXT_MARKER'};edited.prompt.text='Third question';
  await f.events(await f.start('agent-private-1',edited));
  assert.equal(f.modelRuntimeConstructions,2,'changed resources must rebuild the session on its existing transcript');
  prefixKept(2);
  assert.equal(systems(2).length,2);
  assert.equal(JSON.stringify(systems(2)[0]),JSON.stringify(systems(1)[0]));
  assert.match(JSON.stringify(systems(2)[1]),/UPDATED_CONTEXT_MARKER/);
  assert.doesNotMatch(JSON.stringify(systems(2)[1]),/PRIVATE_CONTEXT_MARKER/);
  await f.reopen();
  edited.prompt.text='Fourth question';
  await f.events(await f.start('agent-private-1',edited));
  prefixKept(3);
  assert.equal(systems(3).length,2,'a restart with unchanged resources must not append another copy');
  assert.equal(f.modelRuntimeConstructions,3,'closing the runtime must construct a new session on the next run');
});

test('chat strips private resources and privileged tools and forces chat execution profile', {timeout:20_000}, async t=>{
  const f = await fixture(t);
  let captured: TranscriptContext | undefined;
  f.faux.setResponses([context=>{captured=structuredClone(context);return fauxAssistantMessage(fauxToolCall('bash',{command:'pwd'}),{stopReason:'toolUse'});},fauxAssistantMessage('Chat answer')]);
  const body = request(f.faux.getModel().id,'chat');body.tools=['bash','web_search','web_fetch','browser','schedule','mcp'];
  const events = await f.events(await f.start('chat-conversation',body));
  assert.equal(events.at(-1)!.status,'completed');
  const systems=captured!.messages.filter(m=>m.role==='system');
  assert.deepEqual(systems.flatMap(m=>m.toolsAdded?.map(tool=>tool.name)??[]).sort(),['bash','web_fetch','web_search']);
  assert.doesNotMatch(JSON.stringify(systems),/PRIVATE_CONTEXT_MARKER|SKILL.md/);
  assert.equal(f.executorCalls.find(c=>c.path.endsWith('/terminal'))!.body.execution_context.profile,'chat');
  assert.equal(f.executorCalls.find(c=>c.path.endsWith('/terminal'))!.body.arguments.cwd,'/workspace/conversation');
});

test('active session rejects a concurrent run and cancellation terminates SSE and releases the session', {timeout:20_000}, async t=>{
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  f.faux.setResponses([async (_context,options)=>{
    entered.resolve();
    await new Promise<void>(resolve=>{if(options?.signal?.aborted)resolve();else options?.signal?.addEventListener('abort',()=>resolve(),{once:true});});
    return fauxAssistantMessage('',{stopReason:'aborted'});
  },fauxAssistantMessage('After cancellation')]);
  const body = request(f.faux.getModel().id);
  const id = await f.start('agent-private-1',body);
  await entered.promise;
  const stream = f.events(id);
  assert.equal((await f.http('/v1/sessions/agent-private-1/runs',body)).status,409);
  assert.equal((await f.http(`/v1/runs/${id}/cancel`,{})).status,200);
  const events = await stream;
  assert.equal(events.at(-1)!.status,'cancelled');
  assert.equal(events.filter(e=>e.type==='run_end').length,1);
  assert.equal((await f.events(await f.start('agent-private-1',body))).at(-1)!.text,'After cancellation');
});

for(const outcome of [{confirmed:false},{error:'Manager unavailable'}]){
  test(`unconfirmed cancellation (${JSON.stringify(outcome)}) fences the session until the same run is confirmed`, {timeout:20_000}, async t=>{
    const f=await fixture(t);
    f.cancelOutcomes.push(outcome,{confirmed:true});
    const entered=Promise.withResolvers<void>();
    f.faux.setResponses([async(_context,options)=>{
      entered.resolve();
      await new Promise<void>(resolve=>{if(options?.signal?.aborted)resolve();else options?.signal?.addEventListener('abort',()=>resolve(),{once:true});});
      return fauxAssistantMessage('',{stopReason:'aborted'});
    },fauxAssistantMessage('After confirmed stop')]);
    const body=request('runtime-proof');
    const id=await f.start('agent-private-1',body);
    await entered.promise;
    let terminal=false;
    const stream=f.events(id).then(events=>{terminal=true;return events;});
    const failed=await f.http('/v1/sessions/agent-private-1/cancel',{});
    assert(failed.status>=500&&failed.status<600,await failed.clone().text());
    assert.equal((await f.http('/v1/sessions/agent-private-1/runs',body)).status,409);
    assert.equal(terminal,false,'unconfirmed cancellation must not publish run_end or close SSE');
    const retry=await f.http('/v1/sessions/agent-private-1/cancel',{});
    assert.equal(retry.status,200,await retry.clone().text());
    assert.deepEqual(await retry.json(),{cancelled:true,run_id:id});
    const events=await stream;
    assert.equal(events.filter(event=>event.type==='run_end').length,1);
    assert.equal(events.at(-1)!.status,'cancelled');
    const calls=f.executorCalls.filter(call=>call.path.endsWith('/runs/cancel'));
    assert.equal(calls.length,2);
    assert.deepEqual(calls[0]!.body,calls[1]!.body,'retry must retain the exact Manager cancellation identity');
    assert.match(JSON.stringify(calls[0]!.body),new RegExp(id));
    assert.equal((await f.events(await f.start('agent-private-1',body))).at(-1)!.text,'After confirmed stop');
  });
}

test('cancellation during idle Pi prompt preflight prevents later provider and tool work', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  const entered=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  const acknowledged=Promise.withResolvers<void>();
  const aborted=Promise.withResolvers<void>();
  const prompt=AgentSession.prototype.prompt;
  const abort=AgentSession.prototype.abort;
  t.mock.method(AgentSession.prototype,'prompt',async function(this:AgentSession,...args:Parameters<AgentSession['prompt']>){
    entered.resolve();
    await ready.promise;
    return prompt.apply(this,args);
  });
  t.mock.method(AgentSession.prototype,'abort',async function(this:AgentSession){
    await abort.call(this);
    aborted.resolve();
  });
  t.after(()=>ready.resolve());
  f.onCancel(()=>acknowledged.resolve());
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'printf must-not-run'}),{stopReason:'toolUse'}),fauxAssistantMessage('Must not run')]);
  const body=request('runtime-proof');
  const id=await f.start('agent-private-1',body);
  await entered.promise;
  const cancelling=f.http('/v1/sessions/agent-private-1/cancel',{});
  await Promise.all([acknowledged.promise,aborted.promise]);
  assert.equal((await f.http('/v1/sessions/agent-private-1/runs',body)).status,409);
  ready.resolve();
  const response=await cancelling;
  assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(await response.json(),{cancelled:true,run_id:id});
  const events=await f.events(id);
  assert.equal(events.at(-1)!.status,'cancelled');
  assert.equal(f.faux.state.callCount,0,'resuming preflight must not reach the provider');
  assert.equal(events.some(event=>event.type==='tool_start'),false);
  assert.deepEqual(f.executorCalls.map(call=>call.path),['/v1/executor/runs/cancel']);
  assert.deepEqual(f.gatewayCalls,[]);
  f.faux.setResponses([fauxAssistantMessage('After preflight cancellation')]);
  assert.equal((await f.events(await f.start('agent-private-1',body))).at(-1)!.text,'After preflight cancellation');
});

test('session cancellation waits for active run termination and is idempotent when idle', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  const entered=Promise.withResolvers<void>();
  f.faux.setResponses([async(_context,options)=>{
    entered.resolve();
    await new Promise<void>(resolve=>{if(options?.signal?.aborted)resolve();else options?.signal?.addEventListener('abort',()=>resolve(),{once:true});});
    return fauxAssistantMessage('',{stopReason:'aborted'});
  },fauxAssistantMessage('Session is free')]);
  const body=request('runtime-proof');
  const id=await f.start('agent-private-1',body);
  await entered.promise;
  const response=await f.http('/v1/sessions/agent-private-1/cancel',{});
  assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(await response.json(),{cancelled:true,run_id:id});
  assert.equal((await f.events(id)).at(-1)!.status,'cancelled');
  assert.deepEqual(await (await f.http('/v1/sessions/agent-private-1/cancel',{})).json(),{cancelled:false,run_id:null});
  assert.equal((await f.events(await f.start('agent-private-1',body))).at(-1)!.text,'Session is free');
});

test('session cancellation covers admitted runs still constructing their Pi session', {timeout:20_000}, async t=>{
  const entered=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  const f=await fixture(t,{entered:()=>entered.resolve(),ready:ready.promise});
  t.after(()=>ready.resolve());
  f.faux.setResponses([fauxAssistantMessage('Must never start generation')]);
  const starting=f.http('/v1/sessions/agent-private-1/runs',request('runtime-proof'));
  await entered.promise;
  const cancelObserved=Promise.withResolvers<void>();
  f.server.once('request',()=>cancelObserved.resolve());
  const cancelling=f.http('/v1/sessions/agent-private-1/cancel',{});
  await cancelObserved.promise;
  ready.resolve();
  const admission=await starting;
  assert.equal(admission.status,409,await admission.clone().text());
  const response=await cancelling;
  assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(await response.json(),{cancelled:false,run_id:null});
  assert.equal(f.faux.state.callCount,0);
  assert.deepEqual(await (await f.http('/v1/sessions/agent-private-1/cancel',{})).json(),{cancelled:false,run_id:null});
});

test('automatic threshold compaction streams its lifecycle, accounts for summary usage, and preserves continuation context', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  const summary='Automatic checkpoint: the historical question was answered.';
  f.faux.setResponses([
    fauxAssistantMessage('Historical answer.'),
    context=>{
      const messages=JSON.stringify(context.messages);
      assert.match(messages,/Historical answer/);
      assert.match(messages,/Recent question/);
      return fauxAssistantMessage('Answer before automatic compaction.');
    },
    context=>{
      assert.match(JSON.stringify(context.messages),/Historical answer/);
      return fauxAssistantMessage(summary);
    },
  ]);
  const body=request('runtime-proof');
  // Keep Pi's default 16,384-token reserve and 20,000-token recent suffix.
  // Each prompt fits alone; together they cross this model's compaction threshold.
  body.model.contextWindow=64_000;
  body.prompt.text='Historical question. '.repeat(5_000);
  const first=await f.events(await f.start('agent-private-1',body));
  assert.equal(first.at(-1)!.status,'completed');
  assert.deepEqual(first.filter(event=>event.type==='compaction'),[]);
  assert.equal(f.usage.length,1);
  body.prompt.text='Recent question. '.repeat(6_500);
  const id=await f.start('agent-private-1',body);
  const events=await f.events(id);
  assert.deepEqual(events.filter(event=>event.type==='compaction').map(({seq,...event})=>event),[
    {type:'compaction',phase:'start',reason:'threshold'},
    {type:'compaction',phase:'end',reason:'threshold'},
  ]);
  assert.equal(f.usage.length,3,'the second run must make one summary request and one answer request');
  const currentUsage=f.usage.slice(1);
  const sum=(key:keyof Pick<Usage,'input'|'output'|'cacheRead'|'cacheWrite'|'totalTokens'>)=>currentUsage.reduce((total,usage)=>total+usage[key],0);
  assert(f.usage[2]!.input>0 && f.usage[2]!.output>0,'summary usage must contribute to the run total');
  assert.deepEqual(events.at(-1),{seq:events.length,type:'run_end',status:'completed',text:'Answer before automatic compaction.',usage:{input:sum('input'),output:sum('output'),cache_read:sum('cacheRead'),cache_write:sum('cacheWrite'),total:sum('totalTokens')},model:'runtime-proof',side_effects:false});
  assert.equal(events.filter(event=>event.type==='text_delta').map(event=>event.delta).join(''),'Answer before automatic compaction.','summary text must not leak into assistant output');
  assert.deepEqual(await f.events(id),events,'SSE replay must preserve the compaction lifecycle and final usage');
  const history=await f.http('/v1/sessions/agent-private-1/history');
  assert.match(await history.text(),/Automatic checkpoint: the historical question was answered/);
  f.faux.setResponses([context=>{
    assert.match(JSON.stringify(context.messages),/Automatic checkpoint: the historical question was answered/);
    assert.match(JSON.stringify(context.messages),/Answer before automatic compaction/);
    return fauxAssistantMessage('Continued from the checkpoint.');
  }]);
  body.prompt.text='Continue from the checkpoint.';
  const continuation=await f.events(await f.start('agent-private-1',body));
  assert.equal(continuation.at(-1)!.text,'Continued from the checkpoint.');
  assert.deepEqual(continuation.filter(event=>event.type==='compaction'),[]);
  const usage=f.usage[3]!;
  assert.deepEqual(continuation.at(-1)!.usage,{input:usage.input,output:usage.output,cache_read:usage.cacheRead,cache_write:usage.cacheWrite,total:usage.totalTokens},'a later run must not charge the previous summary again');
});

for(const cold of [false,true]){
  test(`manual compaction of a short ${cold?'reopened':'live'} session preserves history without summarizing`, {timeout:20_000}, async t=>{
    const f=await fixture(t);
    f.faux.setResponses([fauxAssistantMessage('Short answer retained.')]);
    const body=request('runtime-proof');
    await f.events(await f.start('agent-private-1',body));
    const before=await (await f.http('/v1/sessions/agent-private-1/history')).json();
    if(cold)await f.reopen();
    const response=await f.http('/v1/sessions/agent-private-1/compact',{model:{id:'summary-proof',thinking:'off'}});
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),{compacted:false,reason:'too_small'});
    assert.equal(f.faux.state.callCount,1,'a short transcript must not invoke a summary provider');
    assert.deepEqual(await (await f.http('/v1/sessions/agent-private-1/history')).json(),before);
    f.faux.setResponses([context=>{
      assert.match(JSON.stringify(context.messages),/Short answer retained/);
      return fauxAssistantMessage('Next prompt admitted.');
    }]);
    body.prompt.text='Next question.';
    assert.equal((await f.events(await f.start('agent-private-1',body))).at(-1)!.text,'Next prompt admitted.');
  });
}

for(const cold of [false,true]){
  test(`session cancellation aborts and awaits manual compaction of a ${cold?'reopened':'live'} session`, {timeout:20_000}, async t=>{
    const f=await fixture(t);
    const entered=Promise.withResolvers<void>();
    const aborted=Promise.withResolvers<void>();
    const terminal=Promise.withResolvers<void>();
    t.after(()=>terminal.resolve());
    f.faux.setResponses([
      fauxAssistantMessage('Historical answer. '.repeat(5_000)),
      fauxAssistantMessage('Recent answer.'),
      async (_context,options)=>{
        assert(options?.signal,'manual summary must receive a cancellation signal');
        entered.resolve();
        await new Promise<void>(resolve=>{
          if(options.signal!.aborted)resolve();
          else options.signal!.addEventListener('abort',()=>resolve(),{once:true});
        });
        aborted.resolve();
        await terminal.promise;
        return fauxAssistantMessage('',{stopReason:'aborted'});
      },
    ]);
    const body=request('runtime-proof');body.prompt.text='Historical question. '.repeat(5_000);
    await f.events(await f.start('agent-private-1',body));
    body.prompt.text='Recent question.';
    await f.events(await f.start('agent-private-1',body));
    const before=await (await f.http('/v1/sessions/agent-private-1/history')).json();
    if(cold)await f.reopen();
    const compacting=f.http('/v1/sessions/agent-private-1/compact',{model:{id:'summary-proof',thinking:'off'}});
    await entered.promise;
    let cancelled=false;
    const cancelling=f.http('/v1/sessions/agent-private-1/cancel',{}).then(response=>{cancelled=true;return response;});
    await aborted.promise;
    assert.equal((await f.http('/v1/sessions/agent-private-1/runs',body)).status,409);
    assert.equal(cancelled,false,'cancellation must wait for summary termination');
    terminal.resolve();
    const response=await cancelling;
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),{cancelled:true,run_id:null});
    const compactResponse=await compacting;
    assert.equal(compactResponse.status,409,await compactResponse.clone().text());
    assert.deepEqual(await compactResponse.json(),{error:'Session compaction cancelled'});
    assert.deepEqual(await (await f.http('/v1/sessions/agent-private-1/history')).json(),before);
    f.faux.setResponses([fauxAssistantMessage('After compaction cancellation.')]);
    body.prompt.text='Continue after cancellation.';
    assert.equal((await f.events(await f.start('agent-private-1',body))).at(-1)!.text,'After compaction cancellation.');
    assert.deepEqual(await (await f.http('/v1/sessions/agent-private-1/cancel',{})).json(),{cancelled:false,run_id:null});
  });
}

test('manual compaction requires a selected model and generates its summary using that model', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage('Historical answer. '.repeat(5_000)),
    fauxAssistantMessage('Recent answer.'),
    (_context,options,_state,model)=>{
      assert.equal(model.id,'summary-proof');
      assert.equal(options?.reasoning,'high');
      assert.equal(options?.sessionId,'agent-private-1');
      assert.equal(options?.cacheRetention,'short');
      return fauxAssistantMessage('Preserved summary of earlier work.');
    },
  ]);
  const body=request('runtime-proof');body.prompt.text='Historical question. '.repeat(5_000);
  await f.events(await f.start('agent-private-1',body));
  body.prompt.text='Recent question.';
  await f.events(await f.start('agent-private-1',body));
  assert.equal((await f.http('/v1/sessions/agent-private-1/compact',{})).status,400);
  const response=await f.http('/v1/sessions/agent-private-1/compact',{model:{id:'summary-proof',thinking:'high'}});
  assert.equal(response.status,200,await response.clone().text());
  const usage=f.usage[2]!;
  assert(usage.input>0 && usage.output>0 && usage.cacheRead>0 && usage.cacheWrite>0);
  assert.deepEqual(await response.json(),{compacted:true,model:'summary-proof',usage:{input:usage.input,output:usage.output,cache_read:usage.cacheRead,cache_write:usage.cacheWrite,total:usage.totalTokens}});
  assert.equal(f.faux.state.callCount,3);
  const history=await f.http('/v1/sessions/agent-private-1/history');
  assert.match(await history.text(),/Preserved summary of earlier work/);
});

test('cancellation deadline preserves admission fence until pending construction settles', {timeout:10_000}, async t=>{
  const home=await mkdtemp(join(tmpdir(),'pi-cancel-deadline-'));
  const construction=Promise.withResolvers<ModelRuntime>();
  const runtime=new Runtime({home,platformUrl:'http://127.0.0.1:1',platformToken:'unused',executorSocket:join(home,'absent.sock'),executorToken:'unused',skillsDirectory:join(home,'skills'),modelRuntimeFactory:()=>construction.promise});
  t.after(async()=>{t.mock.timers.reset();construction.reject(new Error('Test cleanup'));await runtime.close();await rm(home,{recursive:true,force:true});});
  const body=request('runtime-proof');
  const starting=runtime.start('agent-private-1',body);
  const rejectedStart=assert.rejects(starting,{status:409});
  t.mock.timers.enable({apis:['setTimeout']});
  const cancelling=runtime.cancelSession('agent-private-1');
  const deadline=assert.rejects(cancelling,{status:504});
  t.mock.timers.tick(30_000);
  await deadline;
  await assert.rejects(runtime.start('agent-private-1',body),{status:409});
  construction.reject(new Error('Construction rejected'));
  await rejectedStart;
  assert.deepEqual(await runtime.cancelSession('agent-private-1'),{cancelled:false,run_id:null});
  t.mock.timers.reset();
});
