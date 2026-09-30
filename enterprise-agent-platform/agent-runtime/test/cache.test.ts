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

test('real Runtime keeps Pi session affinity across turns and reopen; actual Codex payload uses that identity', {timeout:20_000}, async t=>{
  const home=await mkdtemp(join(tmpdir(),'pi-cache-proof-'));
  const captures: {context:TranscriptContext;options:SimpleStreamOptions|undefined}[]=[];
  const faux=fauxProvider({models:[{id:'cache-proof'}],tokensPerSecond:1_000_000});
  const models=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false});
  models.registerNativeProvider(faux.provider);
  faux.setResponses(Array.from({length:4},()=> (context:TranscriptContext,options:SimpleStreamOptions|undefined)=>{
    captures.push({context:structuredClone(context),options});return fauxAssistantMessage('A stable answer');
  }));
  const config={home,platformUrl:'http://127.0.0.1:1',platformToken:'unused',executorSocket:join(home,'absent.sock'),executorToken:'unused',skillsDirectory:join(home,'skills'),modelRuntimeFactory:async()=>models};
  let runtime=new Runtime(config);
  let server=createServer(runtime,'secret');
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let address=server.address();assert(address && typeof address==='object');
  let base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(home,{recursive:true,force:true});});
  const body:RunRequest={kind:'agent',sandbox:{scope_key:'private:1',workspace_id:'user-1',sandbox_id:'sandbox',lifecycle_id:'life',profile:'agent',cwd:'/workspace'},model:{id:faux.getModel().id,thinking:'off'},prompt:{text:'First'},context_prefix:'<context time="first"/>',resources:{system_prompt:'Fixed cache prefix',skills:[]},tools:[]};
  for(const [index,sid] of ['agent-private-1','agent-private-1','agent-private-1','agent-private-2'].entries()){
    if(index===2){
      await runtime.close();
      server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      runtime=new Runtime(config);server=createServer(runtime,'secret');
      server.listen(0,'127.0.0.1');await once(server,'listening');
      address=server.address();assert(address && typeof address==='object');
      base=`http://127.0.0.1:${address.port}`;
    }
    body.prompt.text=`Question ${index}`;
    body.context_prefix=`<context time="${index}"/>`;
    const response=await fetch(`${base}/v1/sessions/${sid}/runs`,{method:'POST',headers:{authorization:'Bearer secret','content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
    assert.equal(response.status,202,await response.clone().text());
    const {run_id}=await response.json() as {run_id:string};
    const stream=await fetch(`${base}/v1/runs/${run_id}/events`,{headers:{authorization:'Bearer secret'},signal:AbortSignal.timeout(10_000)});
    const events=(await stream.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
    assert.equal(events.at(-1).status,'completed');
  }
  assert.deepEqual(captures.map(c=>c.options?.sessionId),['agent-private-1','agent-private-1','agent-private-1','agent-private-2']);
  assert(captures[0] && captures[1] && captures[2]);
  assert.deepEqual(captures[1].context.messages.slice(0,captures[0].context.messages.length),captures[0].context.messages);
  assert.deepEqual(captures[2].context.messages.slice(0,captures[1].context.messages.length),captures[1].context.messages);

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
  assert.deepEqual(payloads.map(p=>p.prompt_cache_key),['agent-private-1','agent-private-1','agent-private-1','agent-private-2']);
  assert(payloads[0] && payloads[1] && payloads[2]);
  assert.deepEqual(payloads[1].instructions,payloads[0].instructions);
  assert.deepEqual(payloads[2].instructions,payloads[0].instructions);
  assert.deepEqual(payloads[1].tools,payloads[0].tools);
});
