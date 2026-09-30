import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelRuntime, generateSummary } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, normalizeContext } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { bindModelSession, resolveModel } from '../src/models.js';

const token = `e30.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'test-account'}})).toString('base64')}.signature`;

test('authorized model absent from static catalog reaches native Codex payload with summary affinity', async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('openai-codex',async () => ({type:'oauth',access:token,refresh:'',expires:Date.now()+3_600_000}));
  const runtime = await ModelRuntime.create({ credentials, modelsPath:null, refreshOnCreate:false });
  const model = await resolveModel(runtime, {id:'gpt-platform-new-codex',contextWindow:200_000,maxTokens:16_000});
  assert.equal(model.api,'openai-codex-responses');
  assert(model.input.includes('image'));
  assert.equal(model.baseUrl,runtime.getModel('openai-codex','gpt-5.5')?.baseUrl);
  assert.equal(model.provider,'openai-codex');
  assert.equal(model.contextWindow,200_000);
  assert.equal(model.maxTokens,16_000);
  bindModelSession(runtime,'chat-stable');
  const payloads: Record<string,unknown>[] = [];
  const context = normalizeContext({messages:[{role:'user',content:'Summarize the conversation',timestamp:0}]});
  const options = {apiKey:token, onPayload(payload: unknown) { payloads.push(structuredClone(payload) as Record<string,unknown>); throw new Error('captured-payload'); }, fetch:async () => { throw new Error('Unexpected network'); }};
  await runtime.completeSimple(model,context,options);
  await assert.rejects(generateSummary([{role:'user',content:'Summarize this history',timestamp:0}],model,4096,token,undefined,undefined,undefined,undefined,undefined,
    (selected, input, request) => runtime.streamSimple(selected,input,{...request,...options})), /captured-payload/);
  assert.deepEqual(payloads.map(payload => payload.model),['gpt-platform-new-codex','gpt-platform-new-codex']);
  assert.deepEqual(payloads.map(payload => payload.prompt_cache_key),['chat-stable','chat-stable']);
});

test('shared built-in model IDs resolve through Platform Codex auth, not another provider', async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('openai-codex',async () => ({type:'oauth',access:token,refresh:'',expires:Date.now()+3_600_000}));
  const runtime = await ModelRuntime.create({credentials,modelsPath:null,refreshOnCreate:false});
  const shared = runtime.getModels('openai-codex').find(model =>
    runtime.getModels().find(candidate => candidate.id === model.id)?.provider !== 'openai-codex');
  assert(shared, 'SDK fixture must contain a Codex ID also listed by an earlier built-in provider');
  const selected = await resolveModel(runtime,{id:shared.id});
  assert.equal(selected.provider,'openai-codex');
  assert.equal(selected.api,'openai-codex-responses');
  assert.equal(selected.id,shared.id);
});

test('known injected provider remains usable and request fence blocks post-cancel generation', async () => {
  const runtime = await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false});
  const faux = fauxProvider({models:[{id:'test-model'}],tokensPerSecond:1_000_000});
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('summary')]);
  const model = await resolveModel(runtime,{id:faux.getModel().id});
  assert.equal(model.provider,faux.getModel().provider);
  let checks = 0;
  let cancelled = false;
  bindModelSession(runtime,'session-one',() => { checks++; if (cancelled) throw new DOMException('Cancelled','AbortError'); });
  const context = normalizeContext({messages:[{role:'user',content:'Hello',timestamp:0}]});
  const result = await runtime.completeSimple(model,context);
  assert.equal(result.content[0]?.type,'text');
  assert.equal(checks,1);
  cancelled = true;
  assert.throws(() => runtime.streamSimple(model,context),{name:'AbortError'});
});
