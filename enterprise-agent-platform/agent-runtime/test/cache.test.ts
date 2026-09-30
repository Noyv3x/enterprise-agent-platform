import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { Runtime, type RunRequest } from '../src/runtime.js';
import { createServer } from '../src/http.js';

test('actual Codex payload preserves cache affinity, instructions and resource updates across live reconstruction and reopen', {timeout:20_000}, async t=>{
  const home=await mkdtemp(join(tmpdir(),'pi-cache-proof-'));
  const captures: {context:TranscriptContext;options:SimpleStreamOptions|undefined}[]=[];
  const faux=fauxProvider({models:[{id:'cache-proof'}],tokensPerSecond:1_000_000});
  const models=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false});
  models.registerNativeProvider(faux.provider);
  faux.setResponses(Array.from({length:5},()=> (context:TranscriptContext,options:SimpleStreamOptions|undefined)=>{
    captures.push({context:structuredClone(context),options});return fauxAssistantMessage('A stable answer');
  }));
  const config={home,platformUrl:'http://127.0.0.1:1',platformToken:'unused',executorSocket:join(home,'absent.sock'),executorToken:'unused',skillsDirectory:join(home,'skills'),modelRuntimeFactory:async()=>models};
  let runtime=new Runtime(config);
  let server=createServer(runtime,'secret');
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let address=server.address();assert(address && typeof address==='object');
  let base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(home,{recursive:true,force:true});});
  const image={mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='};
  const body:RunRequest={kind:'agent',sandbox:{scope_key:'private:1',workspace_id:'user-1',sandbox_id:'sandbox',lifecycle_id:'life',profile:'agent',cwd:'/workspace'},model:{id:faux.getModel().id,thinking:'off'},prompt:{text:'First'},context_prefix:'<context time="first"/>',resources:{system_prompt:'Fixed cache prefix',agents_md:{path:'/workspace/AGENTS.md',content:'ORIGINAL_AGENTS_MARKER'},skills:[]},tools:['bash','web_search']};
  const sessionIds=['agent-private-1','agent-private-1','agent-private-1','agent-private-1','agent-private-2'];
  for(const [index,sid] of sessionIds.entries()){
    if(index===2){
      body.resources.system_prompt='UPDATED_SYSTEM_MARKER';
      body.resources.agents_md={path:'/workspace/AGENTS.md',content:'UPDATED_AGENTS_MARKER'};
    }
    if(index===3){
      await runtime.close();
      server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      runtime=new Runtime(config);server=createServer(runtime,'secret');
      server.listen(0,'127.0.0.1');await once(server,'listening');
      address=server.address();assert(address && typeof address==='object');
      base=`http://127.0.0.1:${address.port}`;
    }
    body.prompt.text=`Question ${index}`;
    body.prompt.images=index===2?[image]:[];
    body.context_prefix=`<context time="${index}"/>`;
    const response=await fetch(`${base}/v1/sessions/${sid}/runs`,{method:'POST',headers:{authorization:'Bearer secret','content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
    assert.equal(response.status,202,await response.clone().text());
    const {run_id}=await response.json() as {run_id:string};
    const stream=await fetch(`${base}/v1/runs/${run_id}/events`,{headers:{authorization:'Bearer secret'},signal:AbortSignal.timeout(10_000)});
    const events=(await stream.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
    assert.equal(events.at(-1).status,'completed');
  }
  assert.deepEqual(captures.map(c=>c.options?.sessionId),sessionIds);
  assert.deepEqual(captures.map(c=>c.options?.cacheRetention),sessionIds.map(()=>'short'));

  const codex=openaiCodexProvider();
  const model=models.getModel('openai-codex','gpt-5.5');
  assert(model,'Pinned Pi must expose its Codex model');
  assert.equal(model.api,'openai-codex-responses');
  const payloads:Record<string,unknown>[]=[];
  const token=`e30.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'test-account'}})).toString('base64')}.signature`;
  for(const capture of captures){
    // Stop inside the real provider's payload hook, before any network transport.
    // This asserts generated request bodies, not SDK implementation text.
    const stream=codex.streamSimple({...model,api:'openai-codex-responses'},capture.context,{...capture.options,apiKey:token,onPayload(payload){payloads.push(structuredClone(payload) as Record<string,unknown>);throw new Error('payload-captured-offline');},fetch:async()=>{throw new Error('Unexpected network request');}});
    const result=await stream.result();
    assert.equal(result.stopReason,'error');
    assert.match(result.errorMessage!,/payload-captured-offline/);
  }
  assert.deepEqual(payloads.map(p=>p.prompt_cache_key),sessionIds);
  const initial=payloads[0]!;
  assert.match(initial.instructions as string,/Fixed cache prefix/);
  assert.match(initial.instructions as string,/ORIGINAL_AGENTS_MARKER/);
  const initialTools=initial.tools as {type:string;name:string;parameters?:{type:string;properties:Record<string,unknown>}}[];
  assert.deepEqual(initialTools.map(tool=>tool.name).sort(),['bash','web_search']);
  const bashTool=initialTools.find(tool=>tool.name==='bash')!;
  assert.equal(bashTool.type,'function');
  assert.equal(bashTool.parameters?.type,'object');
  const commandSchema=bashTool.parameters?.properties.command;
  assert(commandSchema && typeof commandSchema==='object' && 'type' in commandSchema);
  assert.equal(commandSchema.type,'string');
  type InputItem={role?:string;content?:string|{type:string;text?:string;image_url?:string}[]};
  const inputs=payloads.map(payload=>payload.input as InputItem[]);
  for(const [index,payload] of payloads.entries()){
    assert.doesNotMatch(payload.instructions as string,/<context|Question \d|input_image|data:image/);
    assert.deepEqual(payload.tools,initial.tools);
    const latestUser=inputs[index]!.filter(item=>item.role==='user').at(-1)!;
    assert(Array.isArray(latestUser.content));
    assert.equal(latestUser.content.filter(part=>part.type==='input_text').map(part=>part.text).join('\n'),`<context time="${index}"/>\nQuestion ${index}`);
  }
  for(const index of [1,2,3]){
    assert.equal(payloads[index]!.instructions,initial.instructions);
    assert.deepEqual(inputs[index]!.slice(0,inputs[index-1]!.length),inputs[index-1]);
  }
  const updates=inputs.map(input=>input.filter(item=>item.role==='developer'||item.role==='system'));
  assert.deepEqual(updates[1],[]);
  for(const index of [2,3]){
    const changed=updates[index]!;
    assert.equal(changed.length,1,'changed resources must be carried once in conversation, including after reopen');
    assert.match(JSON.stringify(changed),/UPDATED_SYSTEM_MARKER/);
    assert.match(JSON.stringify(changed),/UPDATED_AGENTS_MARKER/);
    assert.doesNotMatch(JSON.stringify(changed),/ORIGINAL_AGENTS_MARKER|<context|Question \d/);
    const updateIndex=inputs[index]!.indexOf(changed[0]!);
    assert(updateIndex>inputs[index]!.findIndex(item=>item.role==='user'&&JSON.stringify(item).includes('Question 1')));
    assert(updateIndex<inputs[index]!.findIndex(item=>item.role==='user'&&JSON.stringify(item).includes('Question 2')));
    const imageTurn=inputs[index]!.find(item=>item.role==='user'&&JSON.stringify(item).includes('Question 2'))!;
    assert(Array.isArray(imageTurn.content));
    assert.deepEqual(imageTurn.content.filter(part=>part.type==='input_image').map(part=>part.image_url),[`data:${image.mime};base64,${image.data}`]);
  }
  assert.match(payloads[4]!.instructions as string,/UPDATED_SYSTEM_MARKER/);
  assert.match(payloads[4]!.instructions as string,/UPDATED_AGENTS_MARKER/);
  assert.doesNotMatch(payloads[4]!.instructions as string,/ORIGINAL_AGENTS_MARKER/);
  assert.deepEqual(updates[4],[]);
});
