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
function request(model: string, kind: 'agent' | 'chat' = 'agent', scope?: string): RunRequest {
  return {kind, sandbox:{scope_key:scope ?? (kind === 'chat' ? 'chat:1' : 'private:1'),workspace_id:kind === 'chat' ? 'chat-user-1' : 'user-1',sandbox_id:'sandbox',lifecycle_id:'lifecycle',profile:'agent',cwd:kind === 'chat' ? '/workspace/conversation' : '/workspace'},model:{id:model,thinking:'off'},prompt:{text:'First question'},context_prefix:'<context time="first"/>',resources:{system_prompt:'Stable assistant instructions.',agents_md:{path:'/workspace/AGENTS.md',content:'PRIVATE_CONTEXT_MARKER'},skills:[{name:'example',description:'Example skill',path:'/workspace/skills/example/SKILL.md'}]},tools:['bash','web_search']};
}
function steering(input_id:string,text:string,context_prefix=''): Parameters<Runtime['steer']>[1] {
  return {input_id,prompt:{text,images:[]},context_prefix};
}
function userTexts(messages:TranscriptContext['messages']):string[] {
  return messages.filter(message=>message.role==='user').map(message=>typeof message.content==='string'?message.content:message.content.filter(part=>part.type==='text').map(part=>part.text).join(''));
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
  let onTerminal: (()=>Promise<void>) | undefined;
  let onProcessRead: (()=>Promise<void>) | undefined;
  let terminalFrames: object[] | undefined;
  const executor = httpServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    executorCalls.push({path:req.url!,body,authorization:req.headers.authorization});
    if(req.url?.endsWith('/terminal'))await onTerminal?.();
    if(req.url?.endsWith('/process/read'))await onProcessRead?.();
    res.setHeader('content-type','application/json');
    if(req.url?.endsWith('/runs/cancel')){
      const outcome=cancelOutcomes.shift()??{confirmed:true};
      if('error' in outcome)res.statusCode=503;
      res.once('finish',()=>onCancel?.());
      res.end(JSON.stringify(outcome));
    }else if(terminalFrames&&req.url?.endsWith('/terminal')&&req.headers.accept==='application/x-ndjson'){
      res.setHeader('content-type','application/x-ndjson');
      res.end(terminalFrames.map(frame=>JSON.stringify(frame)+'\n').join(''));
    }else if(req.url?.endsWith('/process/start')||req.url?.endsWith('/process/read')||req.url?.endsWith('/process/detach')||req.url?.endsWith('/process/kill')){
      const view={id:'proc_test',owner:'private:1',scope_id:'private:1',sandbox_id:'sandbox',name:null,command:'',cwd:'/workspace',state:'running',exit_code:null,reason:'',attached:true,stdin_open:false,started_at:'2026-01-01T00:00:00Z',ended_at:null,log_bytes:0,seq:1};
      if(req.url.endsWith('/process/read'))res.end(JSON.stringify({data:'sandbox output\n',offset_start:0,next_offset:15,retained_from:0,eof:true,process:{...view,state:'exited',exit_code:0,log_bytes:15}}));
      else if(req.url.endsWith('/process/detach'))res.end('{}');
      else res.end(JSON.stringify({process:{...view,...(req.url.endsWith('/process/kill')?{state:'killed',reason:'user'}:{})}}));
    }else res.end(JSON.stringify(req.url?.endsWith('/audit') ? {audit_id:body.audit_id,executor_id:'fake-executor'} : {result:{stdout:'/workspace/.pi-bash-test.log\n15\n1\nsandbox output\n',stderr:'',exit_code:0,status:'completed'}}));
  });
  const gateway = httpServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    gatewayCalls.push({path:req.url!,body:JSON.parse(Buffer.concat(chunks).toString()),authorization:req.headers.authorization});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url?.endsWith('/tasks')?{content:'bg-1',data:{task_id:'bg-1'},is_error:false}:{content:'Web result from the fake gateway',data:{url:'https://example.com'},is_error:false}));
  });
  const socket = join(home,'executor.sock');
  await listen(executor,socket);
  const platformUrl = await listen(gateway);
  const faux = fauxProvider({tokensPerSecond:1_000_000,models:[{id:'runtime-proof',reasoning:true,input:['text','image']},{id:'summary-proof',reasoning:true}]});
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
  return {faux,http,start,events,reopen,home,executorCalls,gatewayCalls,usage,server,cancelOutcomes,get url(){return url;},get modelRuntimeConstructions(){return modelRuntimeConstructions;},onCancel(callback:()=>void){onCancel=callback;},onTerminal(callback:()=>Promise<void>){onTerminal=callback;},onProcessRead(callback:()=>Promise<void>){onProcessRead=callback;},streamTerminal(frames:object[]){terminalFrames=frames;}};
}

test('steering HTTP requires authentication and validates every field before looking up a run', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  const path='/v1/runs/unknown-run/steer';
  const valid=steering('input-1','Literal input');
  for(const authorization of [undefined,'Bearer wrong-secret']){
    const response=await fetch(f.url+path,{method:'POST',headers:{'content-type':'application/json',...(authorization?{authorization}:{})},body:JSON.stringify(valid),signal:AbortSignal.timeout(10_000)});
    assert.equal(response.status,401);
    assert.equal(response.headers.get('www-authenticate'),'Bearer');
  }
  const malformed:unknown[]=[
    null,[],{}, {...valid,input_id:undefined}, {...valid,input_id:''}, {...valid,input_id:1}, {...valid,input_id:'x'.repeat(65)},
    {...valid,prompt:undefined}, {...valid,prompt:null}, {...valid,prompt:[]},
    {...valid,prompt:{images:[]}}, {...valid,prompt:{text:1,images:[]}},
    {...valid,prompt:{text:'Missing images'}}, {...valid,prompt:{text:'Bad images',images:null}}, {...valid,prompt:{text:'Bad images',images:{}}},
    {...valid,context_prefix:undefined}, {...valid,context_prefix:null}, {...valid,context_prefix:1},
  ];
  for(const image of [null,[],{},'image',{mime:'image/png'},{data:'YQ=='},{mime:'',data:'YQ=='},{mime:1,data:'YQ=='},{mime:'image/png',data:''},{mime:'image/png',data:1}]){
    malformed.push({...valid,prompt:{text:'Bad image',images:[image]}});
  }
  for(const body of malformed)assert.equal((await f.http(path,body)).status,400,JSON.stringify(body));
  const invalidJSON=await fetch(f.url+path,{method:'POST',headers:{authorization:'Bearer runtime-secret','content-type':'application/json'},body:'{',signal:AbortSignal.timeout(10_000)});
  assert.equal(invalidJSON.status,400);
  assert.equal((await f.http(path,valid)).status,404);
  assert.equal((await f.http(path,steering('x'.repeat(64),''))).status,404,'empty text and context are valid, and 64-character IDs are accepted');
  const wrongMethod=await f.http(path);
  assert.equal(wrongMethod.status,405);
  assert.equal(wrongMethod.headers.get('allow'),'POST');
  assert.equal(f.faux.state.callCount,0);
});

test('steering during a tool is delivered after tool_end in the next request and persists across reopen', {timeout:20_000}, async t=>{
  const entered=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  t.after(()=>ready.resolve());
  const f=await fixture(t);
  f.onTerminal(async()=>{entered.resolve();await ready.promise;});
  const captured:TranscriptContext[]=[];
  f.faux.setResponses([
    context=>{captured.push(structuredClone(context));return fauxAssistantMessage(fauxToolCall('bash',{command:'printf steering'},{id:'steered-tool'}),{stopReason:'toolUse'});},
    context=>{captured.push(structuredClone(context));return fauxAssistantMessage('Used the inserted instruction');},
    context=>{captured.push(structuredClone(context));return fauxAssistantMessage('Remembered after reopen');},
  ]);
  const body=request('runtime-proof','agent','channel:1:room');
  const input=steering('tool-input','Inspect the sandbox result','<context time="inserted"/>');
  const literal=input.context_prefix+'\n'+input.prompt.text;
  const id=await f.start('agent-private-steered-tool',body);
  await entered.promise;
  const response=await f.http(`/v1/runs/${id}/steer`,input);
  assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(await response.json(),{ok:true});
  assert.equal(f.faux.state.callCount,1,'steering must not start a request while the tool is still running');
  ready.resolve();
  const events=await f.events(id);
  assert.equal(f.faux.state.callCount,2);
  assert.deepEqual(userTexts(captured[0]!.messages),[body.context_prefix+'\n'+body.prompt.text]);
  assert.deepEqual(userTexts(captured[1]!.messages),[body.context_prefix+'\n'+body.prompt.text,literal]);
  assert.equal(captured[1]!.messages.at(-1)!.role,'user');
  assert(captured[1]!.messages.findIndex(message=>message.role==='toolResult')<captured[1]!.messages.length-1);
  assert.deepEqual(events.filter(event=>event.type==='input_delivered').map(({seq,...event})=>event),[{type:'input_delivered',input_id:input.input_id}]);
  assert(events.findIndex(event=>event.type==='tool_end')<events.findIndex(event=>event.type==='input_delivered'));
  assert.equal(events.at(-1)!.status,'completed');
  assert.equal(events.at(-1)!.text,'Used the inserted instruction');
  assert.equal(events.at(-1)!.side_effects,true);
  assert.deepEqual(events.at(-1)!.undelivered_inputs,[]);
  const history=await (await f.http('/v1/sessions/agent-private-steered-tool/history')).json() as {messages:{message:TranscriptContext['messages'][number]}[]};
  assert.deepEqual(userTexts(history.messages.map(entry=>entry.message)),[body.context_prefix+'\n'+body.prompt.text,literal]);
  await f.reopen();
  assert.deepEqual(await (await f.http('/v1/sessions/agent-private-steered-tool/history')).json(),history);
  body.prompt.text='What did I insert?';
  const next=await f.events(await f.start('agent-private-steered-tool',body));
  assert.deepEqual(userTexts(captured[2]!.messages),[body.context_prefix+'\nFirst question',literal,body.context_prefix+'\n'+body.prompt.text]);
  assert.equal(next.at(-1)!.text,'Remembered after reopen');
  assert.deepEqual(next.filter(event=>event.type==='input_delivered'),[]);
  assert.deepEqual(next.at(-1)!.undelivered_inputs,[]);
});

test('steering after a provisional final answer continues the same run and batches inputs in acceptance order', {timeout:20_000}, async t=>{
  const entered=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  t.after(()=>ready.resolve());
  const f=await fixture(t);
  const prompt=AgentSession.prototype.prompt;
  t.mock.method(AgentSession.prototype,'prompt',async function(this:AgentSession,...args:Parameters<AgentSession['prompt']>){
    const unsubscribe=this.agent.subscribe(async event=>{
      if(event.type==='message_end'&&event.message.role==='assistant'&&event.message.content.some(part=>part.type==='text'&&part.text==='Provisional final answer')){
        entered.resolve();
        await ready.promise;
      }
    });
    try{return await prompt.apply(this,args);}finally{unsubscribe();}
  });
  let continuation:TranscriptContext|undefined;
  f.faux.setResponses([fauxAssistantMessage('Provisional final answer'),context=>{continuation=structuredClone(context);return fauxAssistantMessage('Revised final answer');}]);
  const body=request('runtime-proof');
  const id=await f.start('agent-private-steered-final',body);
  await entered.promise;
  const inputs=[steering('first-input','First correction'),steering('second-input','Second correction')];
  for(const input of inputs){
    const response=await f.http(`/v1/runs/${id}/steer`,input);
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),{ok:true});
  }
  ready.resolve();
  const events=await f.events(id);
  assert.equal(f.faux.state.callCount,2,'both inputs must be in one next request, not one continuation each');
  assert.deepEqual(userTexts(continuation!.messages),[body.context_prefix+'\n'+body.prompt.text,...inputs.map(input=>input.prompt.text)]);
  assert.deepEqual(continuation!.messages.slice(-2).map(message=>message.role),['user','user']);
  assert.deepEqual(events.filter(event=>event.type==='input_delivered').map(event=>event.input_id),inputs.map(input=>input.input_id));
  assert.equal(events.filter(event=>event.type==='text_delta').map(event=>event.delta).join(''),'Provisional final answerRevised final answer');
  assert(events.findIndex(event=>event.type==='input_delivered')>events.findIndex(event=>event.type==='text_delta'));
  assert.equal(events.filter(event=>event.type==='run_end').length,1);
  assert.equal(events.at(-1)!.status,'completed');
  assert.equal(events.at(-1)!.text,'Revised final answer');
  assert.equal(events.at(-1)!.side_effects,false);
  assert.deepEqual(events.at(-1)!.undelivered_inputs,[]);
});

test('steering pending limit rejects the thirty-third input but accepts duplicates at capacity and after closure', {timeout:20_000}, async t=>{
  const entered=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  t.after(()=>ready.resolve());
  const f=await fixture(t);
  let continuation:TranscriptContext|undefined;
  f.faux.setResponses([
    async()=>{entered.resolve();await ready.promise;return fauxAssistantMessage('Before all pending inputs');},
    context=>{continuation=structuredClone(context);return fauxAssistantMessage('All pending inputs received');},
  ]);
  const id=await f.start('agent-private-steered-cap',request('runtime-proof'));
  await entered.promise;
  const inputs=Array.from({length:32},(_,index)=>steering(`input-${index}`,`Instruction ${index}`));
  for(const input of inputs){
    const response=await f.http(`/v1/runs/${id}/steer`,input);
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),{ok:true});
  }
  const duplicate={...inputs[0]!,prompt:{text:'A duplicate must not replace the accepted message',images:[]}};
  const repeated=await f.http(`/v1/runs/${id}/steer`,duplicate);
  assert.equal(repeated.status,200);
  assert.deepEqual(await repeated.json(),{ok:true});
  assert.equal((await f.http(`/v1/runs/${id}/steer`,steering('overflow','Must not be accepted'))).status,409);
  ready.resolve();
  const events=await f.events(id);
  assert.equal(f.faux.state.callCount,2);
  assert.deepEqual(userTexts(continuation!.messages).slice(1),inputs.map(input=>input.prompt.text));
  assert.deepEqual(events.filter(event=>event.type==='input_delivered').map(event=>event.input_id),inputs.map(input=>input.input_id));
  assert.equal(events.at(-1)!.status,'completed');
  assert.deepEqual(events.at(-1)!.undelivered_inputs,[]);
  const closedDuplicate=await f.http(`/v1/runs/${id}/steer`,duplicate);
  assert.equal(closedDuplicate.status,200);
  assert.deepEqual(await closedDuplicate.json(),{ok:true});
  assert.equal((await f.http(`/v1/runs/${id}/steer`,steering('after-done','Too late'))).status,409);
  assert.deepEqual(await f.events(id),events,'duplicate acceptance after closure must not append any events');
});

test('steering closes admission and clears undelivered inputs when prompt returns before waitForIdle settles', {timeout:20_000}, async t=>{
  const settled=Promise.withResolvers<AgentSession>();
  const returnPrompt=Promise.withResolvers<void>();
  const idleEntered=Promise.withResolvers<AgentSession>();
  const returnIdle=Promise.withResolvers<void>();
  t.after(()=>{returnPrompt.resolve();returnIdle.resolve();});
  const f=await fixture(t);
  const prompt=AgentSession.prototype.prompt;
  const waitForIdle=AgentSession.prototype.waitForIdle;
  let firstPrompt=true;
  let firstIdle=true;
  t.mock.method(AgentSession.prototype,'prompt',async function(this:AgentSession,...args:Parameters<AgentSession['prompt']>){
    const pause=firstPrompt;firstPrompt=false;
    await prompt.apply(this,args);
    if(pause){settled.resolve(this);await returnPrompt.promise;}
  });
  t.mock.method(AgentSession.prototype,'waitForIdle',async function(this:AgentSession){
    if(firstIdle){firstIdle=false;idleEntered.resolve(this);await returnIdle.promise;}
    return waitForIdle.call(this);
  });
  let nextContext:TranscriptContext|undefined;
  f.faux.setResponses([fauxAssistantMessage('Normal answer before prompt settlement'),context=>{nextContext=structuredClone(context);return fauxAssistantMessage('Clean next run');}]);
  const body=request('runtime-proof');
  const id=await f.start('agent-private-steered-settlement',body);
  await settled.promise;
  const inputs=[steering('late-first','Undelivered normal input one'),steering('late-second','Undelivered normal input two')];
  for(const input of inputs)assert.equal((await f.http(`/v1/runs/${id}/steer`,input)).status,200);
  returnPrompt.resolve();
  const session=await idleEntered.promise;
  assert.equal(session.agent.hasQueuedMessages(),false,'Pi queues must be cleared as soon as prompt returns, not after waitForIdle');
  assert.equal(session.pendingMessageCount,0);
  assert.equal((await f.http(`/v1/runs/${id}/steer`,steering('after-prompt','Must be rejected before run_end'))).status,409);
  const duplicate=await f.http(`/v1/runs/${id}/steer`,inputs[0]);
  assert.equal(duplicate.status,200);
  assert.deepEqual(await duplicate.json(),{ok:true});
  assert.equal((await f.http('/v1/sessions/agent-private-steered-settlement/runs',body)).status,409,'the run is still active while waitForIdle is pending');
  returnIdle.resolve();
  const events=await f.events(id);
  assert.equal(events.at(-1)!.status,'completed');
  assert.equal(events.at(-1)!.text,'Normal answer before prompt settlement');
  assert.deepEqual(events.filter(event=>event.type==='input_delivered'),[]);
  assert.deepEqual(events.at(-1)!.undelivered_inputs,inputs.map(input=>input.input_id));
  body.prompt.text='Fresh after normal settlement';
  const next=await f.events(await f.start('agent-private-steered-settlement',body));
  assert.deepEqual(userTexts(nextContext!.messages),[body.context_prefix+'\nFirst question',body.context_prefix+'\n'+body.prompt.text]);
  assert.equal(next.at(-1)!.text,'Clean next run');
  assert.deepEqual(next.filter(event=>event.type==='input_delivered'),[]);
  assert.deepEqual(next.at(-1)!.undelivered_inputs,[]);
});

test('steering cancellation rejects new inputs and reports pending IDs without leaking into the next run', {timeout:20_000}, async t=>{
  const entered=Promise.withResolvers<void>();
  const aborted=Promise.withResolvers<void>();
  const terminal=Promise.withResolvers<void>();
  t.after(()=>terminal.resolve());
  const f=await fixture(t);
  let nextContext:TranscriptContext|undefined;
  f.faux.setResponses([
    async(_context,options)=>{
      assert(options?.signal);
      entered.resolve();
      await new Promise<void>(resolve=>{if(options.signal!.aborted)resolve();else options.signal!.addEventListener('abort',()=>resolve(),{once:true});});
      aborted.resolve();
      await terminal.promise;
      return fauxAssistantMessage('',{stopReason:'aborted'});
    },
    context=>{nextContext=structuredClone(context);return fauxAssistantMessage('Clean after cancellation');},
  ]);
  const body=request('runtime-proof');
  const id=await f.start('agent-private-steered-cancel',body);
  await entered.promise;
  const inputs=[steering('cancel-first','Never deliver cancelled input one'),steering('cancel-second','Never deliver cancelled input two')];
  for(const input of inputs)assert.equal((await f.http(`/v1/runs/${id}/steer`,input)).status,200);
  const cancelling=f.http(`/v1/runs/${id}/cancel`,{});
  await aborted.promise;
  assert.equal((await f.http(`/v1/runs/${id}/steer`,steering('while-cancelled','Must not be admitted'))).status,409);
  const duplicate=await f.http(`/v1/runs/${id}/steer`,inputs[0]);
  assert.equal(duplicate.status,200);
  assert.deepEqual(await duplicate.json(),{ok:true});
  terminal.resolve();
  assert.equal((await cancelling).status,200);
  const events=await f.events(id);
  assert.equal(events.at(-1)!.status,'cancelled');
  assert.equal(events.filter(event=>event.type==='run_end').length,1);
  assert.deepEqual(events.filter(event=>event.type==='input_delivered'),[]);
  assert.deepEqual(events.at(-1)!.undelivered_inputs,inputs.map(input=>input.input_id));
  assert.equal((await f.http(`/v1/runs/${id}/steer`,inputs[1])).status,200);
  assert.equal((await f.http(`/v1/runs/${id}/steer`,steering('after-cancelled','Still closed'))).status,409);
  body.prompt.text='Fresh after cancellation';
  const next=await f.events(await f.start('agent-private-steered-cancel',body));
  assert.deepEqual(userTexts(nextContext!.messages),[body.context_prefix+'\nFirst question',body.context_prefix+'\n'+body.prompt.text]);
  assert.equal(next.at(-1)!.text,'Clean after cancellation');
  assert.deepEqual(next.filter(event=>event.type==='input_delivered'),[]);
  assert.deepEqual(next.at(-1)!.undelivered_inputs,[]);
});

test('steering failure reports and clears accepted undelivered inputs before the next run', {timeout:20_000}, async t=>{
  const entered=Promise.withResolvers<AgentSession>();
  const fail=Promise.withResolvers<void>();
  t.after(()=>fail.resolve());
  const f=await fixture(t);
  const prompt=AgentSession.prototype.prompt;
  let failFirst=true;
  t.mock.method(AgentSession.prototype,'prompt',async function(this:AgentSession,...args:Parameters<AgentSession['prompt']>){
    if(failFirst){
      failFirst=false;
      entered.resolve(this);
      await fail.promise;
      throw new Error('Pi prompt failed before delivery');
    }
    return prompt.apply(this,args);
  });
  let nextContext:TranscriptContext|undefined;
  f.faux.setResponses([context=>{nextContext=structuredClone(context);return fauxAssistantMessage('Clean after failure');}]);
  const body=request('runtime-proof');
  const id=await f.start('agent-private-steered-failure',body);
  const session=await entered.promise;
  const inputs=[steering('failed-first','Undelivered failed input one'),steering('failed-second','Undelivered failed input two')];
  for(const input of inputs)assert.equal((await f.http(`/v1/runs/${id}/steer`,input)).status,200);
  fail.resolve();
  const events=await f.events(id);
  assert.equal(events.at(-1)!.status,'failed');
  assert.equal(events.at(-1)!.error,'Pi prompt failed before delivery');
  assert.equal(events.at(-1)!.side_effects,false);
  assert.deepEqual(events.filter(event=>event.type==='input_delivered'),[]);
  assert.deepEqual(events.at(-1)!.undelivered_inputs,inputs.map(input=>input.input_id));
  assert.equal(session.agent.hasQueuedMessages(),false);
  assert.equal(session.pendingMessageCount,0);
  assert.equal(f.faux.state.callCount,0);
  body.prompt.text='Fresh after failure';
  const next=await f.events(await f.start('agent-private-steered-failure',body));
  assert.deepEqual(userTexts(nextContext!.messages),[body.context_prefix+'\n'+body.prompt.text]);
  assert.equal(next.at(-1)!.text,'Clean after failure');
  assert.deepEqual(next.filter(event=>event.type==='input_delivered'),[]);
  assert.deepEqual(next.at(-1)!.undelivered_inputs,[]);
});

test('steering preserves registered skill commands literally and passes images and context prefixes unchanged', {timeout:20_000}, async t=>{
  const entered=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  t.after(()=>ready.resolve());
  const f=await fixture(t);
  const skillPath=join(f.home,'literal-skill.md');
  await writeFile(skillPath,'---\nname: x\ndescription: Literal steering test skill\n---\nSKILL_EXPANSION_MUST_NOT_APPEAR\n');
  const body=request('runtime-proof');
  body.resources.skills=[{name:'x',description:'Literal steering test skill',path:skillPath}];
  let continuation:TranscriptContext|undefined;
  f.faux.setResponses([
    async()=>{entered.resolve();await ready.promise;return fauxAssistantMessage('Before literal inputs');},
    context=>{continuation=structuredClone(context);return fauxAssistantMessage('Literal inputs received');},
  ]);
  const id=await f.start('agent-private-steered-literal',body);
  await entered.promise;
  const imageInput=steering('image-input','  Describe this image.\n','<context time="image"/>\n');
  imageInput.prompt.images=[{mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='}];
  const inputs=[steering('skill-input','/skill:x literal arguments'),imageInput,steering('prefix-only','','Only the prefix'),steering('empty-input','')];
  for(const input of inputs)assert.equal((await f.http(`/v1/runs/${id}/steer`,input)).status,200);
  ready.resolve();
  const events=await f.events(id);
  assert.equal(f.faux.state.callCount,2);
  const literalTexts=['/skill:x literal arguments','<context time="image"/>\n\n  Describe this image.\n','Only the prefix',''];
  assert.deepEqual(userTexts(continuation!.messages).slice(1),literalTexts);
  assert(JSON.stringify(continuation!.messages.filter(message=>message.role==='system')).includes(skillPath),'the literal command must name a registered skill');
  assert.doesNotMatch(JSON.stringify(continuation!.messages),/SKILL_EXPANSION_MUST_NOT_APPEAR/);
  const imageMessage=continuation!.messages.filter(message=>message.role==='user')[2]!;
  assert.deepEqual(imageMessage.content,[{type:'text',text:literalTexts[1]},{type:'image',mimeType:'image/png',data:imageInput.prompt.images[0]!.data}]);
  assert.deepEqual(events.filter(event=>event.type==='input_delivered').map(event=>event.input_id),inputs.map(input=>input.input_id));
  assert.equal(events.at(-1)!.status,'completed');
  assert.equal(events.at(-1)!.side_effects,false);
  assert.deepEqual(events.at(-1)!.undelivered_inputs,[]);
});

test('steering accepted before Pi starts is included in the first model request', {timeout:20_000}, async t=>{
  const entered=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  t.after(()=>ready.resolve());
  const f=await fixture(t);
  const prompt=AgentSession.prototype.prompt;
  t.mock.method(AgentSession.prototype,'prompt',async function(this:AgentSession,...args:Parameters<AgentSession['prompt']>){
    entered.resolve();
    await ready.promise;
    return prompt.apply(this,args);
  });
  let firstContext:TranscriptContext|undefined;
  f.faux.setResponses([context=>{firstContext=structuredClone(context);return fauxAssistantMessage('First request included steering');}]);
  const body=request('runtime-proof');
  const id=await f.start('agent-private-steered-preflight',body);
  await entered.promise;
  const inputs=[steering('preflight-first','Before the agent loop'),steering('preflight-second','Also before the agent loop','<context time="early"/>')];
  for(const input of inputs)assert.equal((await f.http(`/v1/runs/${id}/steer`,input)).status,200);
  assert.equal(f.faux.state.callCount,0);
  ready.resolve();
  const events=await f.events(id);
  assert.equal(f.faux.state.callCount,1,'preflight inputs must not wait until a second model request');
  assert.deepEqual(userTexts(firstContext!.messages),[body.context_prefix+'\n'+body.prompt.text,'Before the agent loop','<context time="early"/>\nAlso before the agent loop']);
  assert.deepEqual(events.filter(event=>event.type==='input_delivered').map(event=>event.input_id),inputs.map(input=>input.input_id));
  assert(events.findLastIndex(event=>event.type==='input_delivered')<events.findIndex(event=>event.type==='text_delta'));
  assert.equal(events.at(-1)!.status,'completed');
  assert.deepEqual(events.at(-1)!.undelivered_inputs,[]);
});

test('steering matching the original prompt is not falsely delivered before the steering boundary', {timeout:20_000}, async t=>{
  const preflight=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  const originalStarted=Promise.withResolvers<void>();
  t.after(()=>ready.resolve());
  const f=await fixture(t);
  const prompt=AgentSession.prototype.prompt;
  let userStarts=0;
  t.mock.method(AgentSession.prototype,'prompt',async function(this:AgentSession,...args:Parameters<AgentSession['prompt']>){
    const unsubscribe=this.agent.subscribe(async(event,signal)=>{
      if(event.type==='message_start'&&event.message.role==='user'&&++userStarts===1){
        originalStarted.resolve();
        await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});
        // Stop before the initial steering poll, which otherwise emits queued users even after abort.
        throw new Error('Cancelled at the original prompt boundary');
      }
    });
    preflight.resolve();
    await ready.promise;
    try{return await prompt.apply(this,args);}finally{unsubscribe();}
  });
  const body=request('runtime-proof');
  body.context_prefix='';
  body.prompt.text='The original and inserted messages are identical';
  f.faux.setResponses([fauxAssistantMessage('Must not reach the provider')]);
  const id=await f.start('agent-private-steered-identical-root',body);
  await preflight.promise;
  const input=steering('identical-input',body.prompt.text);
  assert.equal((await f.http(`/v1/runs/${id}/steer`,input)).status,200);
  ready.resolve();
  await originalStarted.promise;
  assert.equal((await f.http(`/v1/runs/${id}/cancel`,{})).status,200);
  const events=await f.events(id);
  assert.equal(userStarts,1);
  assert.equal(f.faux.state.callCount,0);
  assert.deepEqual(events.filter(event=>event.type==='input_delivered'),[],'the original message_start must not acknowledge same-text pending steering');
  assert.equal(events.at(-1)!.status,'cancelled');
  assert.deepEqual(events.at(-1)!.undelivered_inputs,[input.input_id]);
});

test('steering delivery matches Pi message identity before exact-text fallback for cloned events', {timeout:20_000}, async t=>{
  const entered=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  t.after(()=>ready.resolve());
  const f=await fixture(t);
  const subscribe=AgentSession.prototype.subscribe;
  let session:AgentSession|undefined;
  let queued:AgentSession['messages']=[];
  let identityStarts=0;
  let clonedStarts=0;
  t.mock.method(AgentSession.prototype,'subscribe',function(this:AgentSession,listener:Parameters<AgentSession['subscribe']>[0]){
    session=this;
    return subscribe.call(this,event=>{
      if(event.type==='message_start'&&event.message.role==='user'){
        if(event.message===queued[0]){
          identityStarts++;
          const content=event.message.content;
          event.message.content=[{type:'text',text:'Different text only during the identity observation'}];
          try{listener(event);}finally{event.message.content=content;}
          return;
        }
        if(event.message===queued[1]){
          clonedStarts++;
          listener({...event,message:structuredClone(event.message)});
          return;
        }
      }
      listener(event);
    });
  });
  let continuation:TranscriptContext|undefined;
  f.faux.setResponses([
    async()=>{entered.resolve();await ready.promise;return fauxAssistantMessage('Before identical steering inputs');},
    context=>{continuation=structuredClone(context);return fauxAssistantMessage('Both identical inputs received');},
  ]);
  const id=await f.start('agent-private-steered-message-matching',request('runtime-proof'));
  await entered.promise;
  const literal='  Identical steering text with exact whitespace.\n';
  const inputs=[steering('identity-input',literal),steering('cloned-input',literal)];
  for(const input of inputs)assert.equal((await f.http(`/v1/runs/${id}/steer`,input)).status,200);
  queued=session!.agent.peekQueuedMessages();
  assert.equal(queued.length,2);
  ready.resolve();
  const events=await f.events(id);
  assert.equal(identityStarts,1);
  assert.equal(clonedStarts,1);
  assert.equal(f.faux.state.callCount,2);
  assert.deepEqual(userTexts(continuation!.messages).slice(1),[literal,literal],'observation hooks must not change model-visible input');
  assert.deepEqual(events.filter(event=>event.type==='input_delivered').map(event=>event.input_id),inputs.map(input=>input.input_id));
  assert.equal(events.at(-1)!.status,'completed');
  assert.deepEqual(events.at(-1)!.undelivered_inputs,[]);
});

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
  assert.deepEqual(events.at(-1),{seq:events.length,type:'run_end',status:'completed',text:'Finished from sandbox and web',usage:{input:sum('input'),output:sum('output'),cache_read:sum('cacheRead'),cache_write:sum('cacheWrite'),total:sum('totalTokens')},model:f.faux.getModel().id,side_effects:true,undelivered_inputs:[]});
  assert.deepEqual(await f.events(id,events.length-1),[events.at(-1)]);
  assert.deepEqual(f.executorCalls.map(c=>c.path),['/v1/executor/audit','/v1/executor/process/start','/v1/executor/process/read']);
  assert(f.executorCalls[0] && f.executorCalls[1] && f.gatewayCalls[0]);
  assert.equal(f.executorCalls[1].body.execution_context.profile,'agent');
  assert(f.executorCalls.every(c=>c.authorization==='Bearer executor-secret'));
  assert.equal(f.gatewayCalls[0].path,'/internal/agent/tools/web');
  assert.equal(f.gatewayCalls[0].authorization,'Bearer tools-secret');
  assert.equal(f.gatewayCalls[0].body.context.run_id,id);
  assert.equal(f.gatewayCalls[0].body.context.owner_user_id,1);
});

test('thinking summary deltas stream between start and end in order', {timeout:20_000}, async t=>{
  const f = await fixture(t);
  const summary = '**Inspecting packages**\n\nChecking the runtime and its scripted-model fixtures.';
  f.faux.setResponses([fauxAssistantMessage([fauxThinking(summary),{type:'text',text:'Done'}])]);
  const body = request(f.faux.getModel().id);
  body.model.thinking = 'medium';
  const events = await f.events(await f.start('agent-private-thinking',body));
  const thinking = events.filter(event=>event.type.startsWith('thinking_'));
  const deltas = thinking.slice(1,-1);
  assert(deltas.length>1);
  assert(deltas.every(event=>event.type==='thinking_delta'));
  assert.equal(deltas.map(event=>event.delta).join(''),summary);
  assert.deepEqual(thinking[0],{seq:1,type:'thinking_start'});
  assert.deepEqual(thinking.at(-1),{seq:thinking.length,type:'thinking_end'});
  assert.deepEqual(events.slice(0,thinking.length),thinking);
  assert.equal(events[thinking.length]?.type,'text_delta');
  assert.equal(events.at(-1)?.status,'completed');
  assert.equal(events.at(-1)?.text,'Done');
});

test('a reasoning block without a summary emits start and end without deltas', {timeout:20_000}, async t=>{
  const f = await fixture(t);
  // Faux synthesizes an empty delta; script Codex's no-summary stream without it.
  const streamSimple = f.faux.provider.streamSimple;
  t.mock.method(f.faux.provider,'streamSimple',(...args:Parameters<typeof streamSimple>)=>{
    const stream = streamSimple(...args);
    const push = stream.push.bind(stream);
    t.mock.method(stream,'push',(event:Parameters<typeof push>[0])=>{
      if(event.type!=='thinking_delta'||event.delta!=='')push(event);
    });
    return stream;
  });
  f.faux.setResponses([fauxAssistantMessage([fauxThinking(''),{type:'text',text:'Done'}])]);
  const body = request(f.faux.getModel().id);
  body.model.thinking = 'medium';
  const events = await f.events(await f.start('agent-private-empty-thinking',body));
  const thinking = events.filter(event=>event.type.startsWith('thinking_'));
  assert.deepEqual(thinking,[{seq:1,type:'thinking_start'},{seq:2,type:'thinking_end'}]);
  assert.deepEqual(events.slice(0,2),thinking);
  assert.equal(events[2]?.type,'text_delta');
  assert.equal(events.at(-1)?.status,'completed');
  assert.equal(events.at(-1)?.text,'Done');
});

test('two reasoning blocks in one response keep separate start and end boundaries', {timeout:20_000}, async t=>{
  const f = await fixture(t);
  const summaries = ['**Inspecting packages**\n\nReading the runtime.','**Choosing the change**\n\nForwarding each boundary.'];
  f.faux.setResponses([fauxAssistantMessage([...summaries.map(fauxThinking),{type:'text',text:'Done'}])]);
  const body = request(f.faux.getModel().id);
  body.model.thinking = 'medium';
  const events = await f.events(await f.start('agent-private-thinking-blocks',body));
  const blocks:string[] = [];
  let open:string|undefined;
  for(const event of events){
    if(event.type==='thinking_start'){
      assert.equal(open,undefined,'the previous block must end before another starts');
      open = '';
    }else if(event.type==='thinking_delta'){
      assert(open!==undefined,'a summary delta must belong to an open block');
      assert(typeof event.delta==='string');
      open += event.delta;
    }else if(event.type==='thinking_end'){
      assert(open!==undefined,'each end must have its own start');
      blocks.push(open);
      open = undefined;
    }else assert.equal(open,undefined,'thinking must end before text or run completion');
  }
  assert.equal(open,undefined);
  assert.deepEqual(blocks,summaries);
  assert.equal(events.at(-1)?.status,'completed');
  assert.equal(events.at(-1)?.text,'Done');
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
  const body = request(f.faux.getModel().id,'chat');body.tools=['bash','web_search','web_fetch','browser','schedule','mcp','task','job','wait'];
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
  assert.deepEqual(events.at(-1),{seq:events.length,type:'run_end',status:'completed',text:'Answer before automatic compaction.',usage:{input:sum('input'),output:sum('output'),cache_read:sum('cacheRead'),cache_write:sum('cacheWrite'),total:sum('totalTokens')},model:'runtime-proof',side_effects:false,undelivered_inputs:[]});
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

test('tool_input events map ids and names across several tool calls in one message and concatenate to the generated arguments', {timeout:20_000}, async t=>{
  const f = await fixture(t);
  const bashArgs = {command:'printf sandbox'};
  const writeArgs = {path:'notes.md',content:'# Title\n'.repeat(40)};
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('write',writeArgs,{id:'call-write'}),fauxToolCall('bash',bashArgs,{id:'call-bash'})],{stopReason:'toolUse'}),
    fauxAssistantMessage('done'),
  ]);
  const id = await f.start('agent-private-inputs',request(f.faux.getModel().id));
  const events = await f.events(id);
  const starts = events.filter(e=>e.type==='tool_input_start');
  assert.deepEqual(starts.map(e=>[e.tool_call_id,e.name]),[['call-write','write'],['call-bash','bash']]);
  const text = (call:string) => events.filter(e=>e.type==='tool_input_delta'&&e.tool_call_id===call).map(e=>e.delta).join('');
  assert.deepEqual(JSON.parse(text('call-write')),writeArgs);
  assert.deepEqual(JSON.parse(text('call-bash')),bashArgs);
  // Argument deltas of one call never precede its start and never follow its tool_start.
  for(const call of ['call-write','call-bash']){
    const first = events.findIndex(e=>e.type==='tool_input_start'&&e.tool_call_id===call);
    const last = events.findLastIndex(e=>e.type==='tool_input_delta'&&e.tool_call_id===call);
    const executed = events.findIndex(e=>e.type==='tool_start'&&e.tool_call_id===call);
    assert(first>=0&&first<last&&last<executed,`${call}: ${first} ${last} ${executed}`);
  }
  assert.deepEqual(events.filter(e=>e.type==='tool_start').map(e=>e.args),[writeArgs,bashArgs]);
});

test('bash live output from Manager frames becomes ordered coalesced tool_output events before tool_end', {timeout:20_000}, async t=>{
  const f = await fixture(t);
  const result = {stdout:'/workspace/.pi-bash-test.log\n15\n1\nlive one two\n',stderr:'live one two\n',exit_code:0,status:'completed'};
  f.streamTerminal([
    {type:'output',stream:'stdout',data:'/workspace/.pi-bash-test.log\n15\n1\nlive one two\n'},
    {type:'output',stream:'stderr',data:'live '},{type:'output',stream:'stderr',data:'one '},{type:'output',stream:'stderr',data:'two\n'},
    {type:'result',result},
  ]);
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('bash',{command:'echo live one two'},{id:'call-live'})],{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
  const id = await f.start('agent-private-output',request(f.faux.getModel().id,'agent','channel:1:room'));
  const events = await f.events(id);
  const output = events.filter(e=>e.type==='tool_output');
  assert(output.length>=1&&output.length<3,'three writes within one interval are coalesced');
  assert(output.every(e=>e.tool_call_id==='call-live'&&!('truncated' in e)));
  assert.equal(output.map(e=>e.delta).join(''),'live one two\n');
  const end = events.findIndex(e=>e.type==='tool_end');
  assert(events.findLastIndex(e=>e.type==='tool_output')<end&&events.findIndex(e=>e.type==='tool_start')<events.findIndex(e=>e.type==='tool_output'));
  assert.equal(events[end]!.is_error,false);
  assert.deepEqual(events.filter(e=>e.type==='tool_end').map(e=>e.content_preview),[[{type:'text',text:'live one two\n'}]]);
});

test('live bash output stops at 512 KiB with a single truncated event while tool_end stays authoritative', {timeout:20_000}, async t=>{
  const f = await fixture(t);
  const chunk = 'x'.repeat(64*1024);
  f.streamTerminal([
    ...Array.from({length:12},()=>({type:'output',stream:'stderr',data:chunk})),
    {type:'result',result:{stdout:'/workspace/.pi-bash-test.log\n15\n1\nfinal\n',stderr:'',exit_code:0,status:'completed'}},
  ]);
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('bash',{command:'big'},{id:'call-big'})],{stopReason:'toolUse'}),fauxAssistantMessage('done')]);
  const id = await f.start('agent-private-cap',request(f.faux.getModel().id,'agent','channel:1:room'));
  const events = await f.events(id);
  const output = events.filter(e=>e.type==='tool_output');
  assert.equal(output.slice(0,-1).reduce((total,e)=>total+Buffer.byteLength(String(e.delta)),0)+Buffer.byteLength(String(output.at(-1)!.delta)),512*1024);
  assert.deepEqual(output.at(-1),{...output.at(-1)!,delta:'',truncated:true});
  assert.equal(output.filter(e=>e.truncated===true).length,1);
  assert.deepEqual(events.find(e=>e.type==='tool_end')!.content_preview,[{type:'text',text:'final\n'}]);
});

function subagent(model:string,uid=1,n=7):RunRequest {
  const body=request(model,'agent',`private:${uid}/delegate/bg-${n}`);
  body.kind='subagent';body.tools=['read','bash','grep','web_search','web_fetch'];
  return body;
}

test('subagent runs get exactly their tool subset, no AGENTS.md, and the foreground bash', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  let captured:TranscriptContext|undefined;
  f.faux.setResponses([context=>{captured=structuredClone(context);return fauxAssistantMessage(fauxToolCall('bash',{command:'printf child'}),{stopReason:'toolUse'});},fauxAssistantMessage('Child report')]);
  const events=await f.events(await f.start('agent-private-1-bg-7',subagent(f.faux.getModel().id)));
  assert.equal(events.at(-1)!.status,'completed');
  assert.equal(events.at(-1)!.text,'Child report');
  const systems=captured!.messages.filter(m=>m.role==='system');
  assert.deepEqual(systems.flatMap(m=>m.toolsAdded?.map(tool=>tool.name)??[]).sort(),['bash','grep','read','web_fetch','web_search']);
  assert.doesNotMatch(JSON.stringify(systems),/PRIVATE_CONTEXT_MARKER/);
  assert.deepEqual(f.executorCalls.map(c=>c.path),['/v1/executor/audit','/v1/executor/terminal'],'a subagent runs foreground commands only');
  const terminal=f.executorCalls[1]!.body;
  assert.equal(terminal.scope_id,'private:1/delegate/bg-7');
  assert.equal(terminal.execution_context.profile,'agent');
});

test('subagent runs are rejected outside the delegate scope, with another session ID or with tools beyond the subset', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  const model=f.faux.getModel().id;
  const attempts:[string,string,(body:RunRequest)=>void][]=[
    ['the root personal scope','agent-private-1-bg-7',body=>{body.sandbox.scope_key='private:1';}],
    ['a channel scope','agent-private-1-bg-7',body=>{body.sandbox.scope_key='channel:1:room';}],
    ['a chat scope','agent-private-1-bg-7',body=>{body.sandbox.scope_key='chat:1';}],
    ['another user\'s delegate scope under this sid','agent-private-2-bg-7',()=>{}],
    ['a mismatched child number','agent-private-1-bg-8',()=>{}],
    ['the parent session ID','agent-private-1',()=>{}],
    ['the chat profile','agent-private-1-bg-7',body=>{body.sandbox.profile='chat';}],
    ...['browser','schedule','mcp','task','job','wait'].map(tool=>[`the ${tool} tool`,'agent-private-1-bg-7',(body:RunRequest)=>{body.tools=['read',tool];}] as [string,string,(body:RunRequest)=>void]),
  ];
  for(const [label,sid,mutate] of attempts){
    const body=subagent(model);mutate(body);
    const response=await f.http(`/v1/sessions/${sid}/runs`,body);
    assert.equal(response.status,400,label);
  }
  assert.deepEqual(f.executorCalls,[]);
  assert.equal(f.faux.state.callCount,0);
  f.faux.setResponses([fauxAssistantMessage('Still admitted')]);
  assert.equal((await f.events(await f.start('agent-private-1-bg-7',subagent(model)))).at(-1)!.text,'Still admitted');
});

test('only the root personal agent scope gets task, job and wait', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  const seen:Record<string,string[]>={};
  for(const [sid,scope] of [['agent-private-1','private:1'],['agent-channel-1','channel:1:room'],['agent-private-1-bg-7','private:1/delegate/bg-7']] as const){
    f.faux.setResponses([context=>{seen[scope]=context.messages.filter(m=>m.role==='system').flatMap(m=>m.toolsAdded?.map(tool=>tool.name)??[]).sort();return fauxAssistantMessage('ok');}]);
    const body=request(f.faux.getModel().id,'agent',scope);body.tools=['bash','web_search','browser','task','job','wait'];
    assert.equal((await f.events(await f.start(sid,body))).at(-1)!.status,'completed');
  }
  assert.deepEqual(seen['private:1'],['bash','browser','job','task','wait','web_search']);
  assert.deepEqual(seen['channel:1:room'],['bash','web_search']);
  assert.deepEqual(seen['private:1/delegate/bg-7'],['bash','web_search']);
});

test('a steering input promotes a running personal bash to a background task without rerunning it', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  const entered=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  t.after(()=>ready.resolve());
  f.onProcessRead(async()=>{entered.resolve();await ready.promise;});
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'make watch'},{id:'long-bash'}),{stopReason:'toolUse'}),fauxAssistantMessage('Handled the message')]);
  const id=await f.start('agent-private-1',request(f.faux.getModel().id));
  await entered.promise;
  const input=steering('promote-input','Please check something else');
  assert.equal((await f.http(`/v1/runs/${id}/steer`,input)).status,200);
  const events=await f.events(id);
  assert.equal(events.at(-1)!.status,'completed');
  const end=events.find(e=>e.type==='tool_end')!;
  assert.equal(end.is_error,false);
  assert.deepEqual(end.details,{background:{task_id:'bg-1',process_id:'proc_test'}});
  assert.match(JSON.stringify(end.content_preview),/Backgrounded early to handle an incoming message; the command keeps running\./);
  assert(events.findIndex(e=>e.type==='tool_end')<events.findIndex(e=>e.type==='input_delivered'));
  assert.deepEqual(f.executorCalls.map(c=>c.path),['/v1/executor/audit','/v1/executor/process/start','/v1/executor/process/read','/v1/executor/process/detach']);
  assert.equal(f.executorCalls[1]!.body.arguments.command,'make watch');
  assert.equal(f.executorCalls[1]!.body.arguments.attached,true);
  assert.deepEqual(f.gatewayCalls.map(c=>[c.path,c.body.action,c.body.arguments,c.body.context.tool_call_id]),[['/internal/agent/tools/tasks','register_process',{process_id:'proc_test',delivered:false},'long-bash']]);
  assert.equal(events.at(-1)!.side_effects,true);
});

test('cancelling a run kills a personal bash process that was not promoted', {timeout:20_000}, async t=>{
  const f=await fixture(t);
  const entered=Promise.withResolvers<void>();
  const ready=Promise.withResolvers<void>();
  t.after(()=>ready.resolve());
  f.onProcessRead(async()=>{entered.resolve();await ready.promise;});
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'sleep 1000'}),{stopReason:'toolUse'}),fauxAssistantMessage('Must not run')]);
  const id=await f.start('agent-private-1',request(f.faux.getModel().id));
  await entered.promise;
  const response=await f.http('/v1/sessions/agent-private-1/cancel',{});
  assert.equal(response.status,200,await response.clone().text());
  assert.equal((await f.events(id)).at(-1)!.status,'cancelled');
  const paths=f.executorCalls.map(c=>c.path);
  assert(paths.includes('/v1/executor/process/kill'),'the unpromoted process must be killed by Runtime');
  assert(paths.includes('/v1/executor/runs/cancel'));
  assert.equal(paths.includes('/v1/executor/process/detach'),false);
  assert.deepEqual(f.gatewayCalls,[]);
});
