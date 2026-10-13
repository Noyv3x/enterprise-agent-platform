import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, type AssistantMessage, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { Runtime, type RunRequest } from '../src/runtime.js';
import { createServer } from '../src/http.js';
import { effortPath } from '../src/session-path.js';
import { planStableEffort } from '../src/effort.js';
import { generateTitle, judgeEffort, parseEffort, sanitizeTitle } from '../src/judge.js';

const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64')}.signature`;
type Item = { type?: string; role?: string; content?: unknown; reasoning?: { effort?: string } };
type Payload = { reasoning?: { effort?: string }; input: Item[]; model: string };
type Event = { type: string; [key: string]: unknown };
interface Capture { sid: string | undefined; payload: Payload; planned: boolean }

// Each conversation request is converted by the real Codex provider code, with the session wrapper's onPayload
// composed in; the payload is captured before any transport and the scripted faux reply continues the session.
async function harness(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pi-effort-proof-'));
  const captures: Capture[] = [];
  const judgeCalls: { text: string; options: SimpleStreamOptions | undefined }[] = [];
  const judgeAnswers: (string | Error | 'hang')[] = [];
  const faux = fauxProvider({ models: [{ id: 'gpt-6.1-sol', reasoning: true }, { id: 'gpt-6-sol', reasoning: true }, { id: 'gpt-5.5-fake', reasoning: true }], tokensPerSecond: 1_000_000 });
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  for (const model of faux.models) model.thinkingLevelMap = { xhigh: 'xhigh' };
  models.registerNativeProvider(faux.provider);
  const judgeFaux = fauxProvider({ models: [{ id: 'gpt-6-luna', reasoning: true }], tokensPerSecond: 1_000_000 });
  const judgeModels = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  for (const model of judgeFaux.models) model.thinkingLevelMap = { xhigh: 'xhigh' };
  judgeModels.registerNativeProvider(judgeFaux.provider);
  const template = models.getModel('openai-codex', 'gpt-5.5');
  assert(template);
  const codex = openaiCodexProvider();
  const replies: (string | ((context: TranscriptContext) => string | Promise<string>))[] = [];
  const responder: FauxResponseStep = async (context, options, _state, model) => {
    let payload: Payload | undefined;
    const captured = await codex.streamSimple({ ...template, id: model.id, api: 'openai-codex-responses' }, context, {
      ...options, apiKey: token, fetch: async () => { throw new Error('Unexpected network request'); },
      async onPayload(body, selected) {
        const replaced = await options?.onPayload?.(body, selected);
        payload = structuredClone(replaced ?? body) as Payload;
        throw new Error('payload-captured-offline');
      },
    }).result();
    assert.match(captured.errorMessage!, /payload-captured-offline/);
    captures.push({ sid: options?.sessionId, payload: payload!, planned: options?.onPayload !== undefined });
    const next = replies.shift() ?? 'ok';
    return fauxAssistantMessage(typeof next === 'function' ? await next(context) : next);
  };
  const judgeResponder: FauxResponseStep = async (context, options) => {
    const text = JSON.stringify(context.messages);
    judgeCalls.push({ text, options });
    const answer = judgeAnswers.shift() ?? 'high';
    if (answer === 'hang') await new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
    if (answer instanceof Error) return fauxAssistantMessage('', { stopReason: 'error', errorMessage: answer.message }) as AssistantMessage;
    return fauxAssistantMessage(answer as string);
  };
  faux.setResponses(Array.from({ length: 40 }, () => responder));
  judgeFaux.setResponses(Array.from({ length: 40 }, () => judgeResponder));
  const config = { home, platformUrl: 'http://127.0.0.1:1', platformToken: 'unused', executorSocket: join(home, 'absent.sock'), executorToken: 'unused', modelRuntimeFactory: async (id: string) => id === 'gpt-6-luna' ? judgeModels : models };
  let runtime = new Runtime(config);
  let server = createServer(runtime, 'secret');
  let base = '';
  async function listen() {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert(address && typeof address === 'object');
    base = `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    await runtime.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await listen();
  t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }); });
  const http = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(`${base}${path}`, { method, headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const h = {
    home, captures, judgeCalls, judgeAnswers, replies, faux, judgeFaux, http, runtime: () => runtime,
    async restart() { await stop(); runtime = new Runtime(config); server = createServer(runtime, 'secret'); await listen(); },
    body(text: string, thinking: RunRequest['model']['thinking'], model = 'gpt-6.1-sol', extra: Partial<RunRequest> = {}): RunRequest {
      return { kind: 'agent', sandbox: { scope_key: 'private:1', workspace_id: 'user-1', sandbox_id: 'sandbox', lifecycle_id: 'life', profile: 'agent', cwd: '/workspace' }, model: { id: model, thinking },
        ...(thinking === 'auto' ? { judge: { id: 'gpt-6-luna', thinking: 'low' as const } } : {}),
        prompt: { text }, context_prefix: '<context time="now"/>', resources: { system_prompt: 'Fixed prefix', agents_md: null, skills: [] }, tools: ['bash'], ...extra };
    },
    async start(sid: string, body: RunRequest) {
      const response = await http(`/v1/sessions/${sid}/runs`, body);
      assert.equal(response.status, 202, await response.clone().text());
      return (await response.json() as { run_id: string }).run_id;
    },
    async events(runId: string): Promise<Event[]> {
      const stream = await fetch(`${base}/v1/runs/${runId}/events`, { headers: { authorization: 'Bearer secret' }, signal: AbortSignal.timeout(15_000) });
      return (await stream.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as Event);
    },
    async run(sid: string, body: RunRequest) {
      const events = await h.events(await h.start(sid, body));
      const end = events.at(-1)!;
      assert.equal(end.type, 'run_end');
      assert.equal(end.status, 'completed', JSON.stringify(end));
      return end;
    },
  };
  return h;
}
const updates = (items: Item[]) => items.filter(item => item.type === 'configuration_update');
const userIndex = (items: Item[], text: string) => items.findIndex(item => item.role === 'user' && JSON.stringify(item).includes(text));
function noAdjacent(items: Item[]) {
  for (let index = 1; index < items.length; index++) assert(!(items[index]!.type === 'configuration_update' && items[index - 1]!.type === 'configuration_update'), 'adjacent configuration updates');
}

test('auto effort: request-level effort stays pinned, changes ride update items before their user message and replay byte-identically', { timeout: 60_000 }, async t => {
  const h = await harness(t);
  h.judgeAnswers.push('high', 'low', 'xhigh', 'xhigh');
  const ends: Event[] = [];
  for (const text of ['Question 0', 'Question 1', 'Question 2', 'Question 3']) ends.push(await h.run('agent-private-1', h.body(text, 'auto')));
  assert.deepEqual(ends.map(end => end.effort), ['high', 'low', 'xhigh', 'xhigh']);
  assert(ends.every(end => (end.judge_usage as { model: string }).model === 'gpt-6-luna'));
  const payloads = h.captures.map(capture => capture.payload);
  assert.equal(payloads.length, 4);
  const base = payloads[0]!.reasoning!.effort;
  assert.deepEqual(payloads.map(payload => payload.reasoning!.effort), [base, base, base, base], 'request-level effort never changes');
  assert.deepEqual(updates(payloads[0]!.input), []);
  assert.deepEqual(updates(payloads[1]!.input), [{ type: 'configuration_update', reasoning: { effort: 'low' } }]);
  assert.deepEqual(updates(payloads[2]!.input).map(item => item.reasoning!.effort), ['low', 'xhigh']);
  assert.deepEqual(updates(payloads[3]!.input).map(item => item.reasoning!.effort), ['low', 'xhigh'], 'an unchanged effort adds nothing');
  // Each update sits immediately before the user message it takes effect on.
  assert.equal(payloads[1]!.input[userIndex(payloads[1]!.input, 'Question 1') - 1]!.type, 'configuration_update');
  assert.equal(payloads[2]!.input[userIndex(payloads[2]!.input, 'Question 2') - 1]!.reasoning!.effort, 'xhigh');
  assert.equal(payloads[2]!.input[userIndex(payloads[2]!.input, 'Question 1') - 1]!.reasoning!.effort, 'low');
  assert.equal(payloads[3]!.input[userIndex(payloads[3]!.input, 'Question 3') - 1]!.role === 'assistant', true, 'no update before an unchanged turn');
  // Replay: every earlier request is a byte-identical prefix of the next.
  for (const [index, payload] of payloads.entries()) {
    noAdjacent(payload.input);
    if (index > 0) assert.equal(JSON.stringify(payload.input.slice(0, payloads[index - 1]!.input.length)), JSON.stringify(payloads[index - 1]!.input));
  }
  // The judge sees the request without the context prefix, and short follow-ups come with the previous request.
  assert.doesNotMatch(h.judgeCalls[1]!.text, /context time/);
  assert.match(h.judgeCalls[1]!.text, /previous_request[\s\S]*Question 0[\s\S]*Question 1/);
  assert.equal(h.judgeCalls[0]!.options?.sessionId, 'agent-platform-judge-auto-effort');
  assert.doesNotMatch(h.judgeCalls[0]!.text, /previous_request/);
  assert.equal(h.captures[0]!.sid, 'agent-private-1');
});

test('plan state survives session disposal and a fresh Runtime, and is deleted with the session', { timeout: 60_000 }, async t => {
  const h = await harness(t);
  h.judgeAnswers.push('medium', 'high', 'low');
  await h.run('agent-private-1', h.body('Question 0', 'auto'));
  await h.run('agent-private-1', h.body('Question 1', 'auto'));
  const file = effortPath(h.home, 'agent-private-1');
  assert(existsSync(file));
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { transitions: unknown[]; applied: string };
  assert.equal(saved.transitions.length, 1);
  await h.restart();
  await h.run('agent-private-1', h.body('Question 2', 'auto'));
  const payloads = h.captures.map(capture => capture.payload);
  assert.deepEqual(payloads.map(payload => payload.reasoning!.effort), [payloads[0]!.reasoning!.effort, payloads[0]!.reasoning!.effort, payloads[0]!.reasoning!.effort]);
  assert.deepEqual(updates(payloads[2]!.input).map(item => item.reasoning!.effort), ['high', 'low']);
  assert.equal(JSON.stringify(payloads[2]!.input.slice(0, payloads[1]!.input.length)), JSON.stringify(payloads[1]!.input), 'replay after restart is byte-identical');
  assert.equal((await h.http('/v1/sessions/agent-private-1', undefined, 'DELETE')).status, 200);
  assert(!existsSync(file));
});

test('fixed-effort sessions keep the cache across an administrator change; other models and plain sessions are untouched', { timeout: 60_000 }, async t => {
  const h = await harness(t);
  await h.run('agent-private-1', h.body('Question 0', 'medium'));
  await h.run('agent-private-1', h.body('Question 1', 'medium'));
  await h.run('agent-private-1', h.body('Question 2', 'high'));
  const fixed = h.captures.map(capture => capture.payload);
  assert.deepEqual(updates(fixed[1]!.input), [], 'a fixed effort without change sends no update');
  assert.deepEqual(updates(fixed[2]!.input).map(item => item.reasoning!.effort), ['high']);
  assert.equal(fixed[2]!.reasoning!.effort, fixed[0]!.reasoning!.effort);
  assert.equal(h.judgeCalls.length, 0, 'fixed efforts never call the judge');
  h.captures.length = 0;
  await h.run('agent-private-2', h.body('Question 0', 'low', 'gpt-5.5-fake'));
  await h.run('agent-private-2', h.body('Question 1', 'high', 'gpt-5.5-fake'));
  const other = h.captures.map(capture => capture.payload);
  assert.deepEqual(other.map(payload => updates(payload.input)), [[], []]);
  assert.notEqual(other[0]!.reasoning!.effort, other[1]!.reasoning!.effort, 'a non-GPT-6 model sends its effort at request level');
  assert(!existsSync(effortPath(h.home, 'agent-private-2')) || JSON.parse(readFileSync(effortPath(h.home, 'agent-private-2'), 'utf8')).base === undefined);
});

test('a model change starts a new baseline', { timeout: 60_000 }, async t => {
  const h = await harness(t);
  await h.run('agent-private-1', h.body('Question 0', 'high'));
  await h.run('agent-private-1', h.body('Question 1', 'low'));
  await h.run('agent-private-1', h.body('Question 2', 'low', 'gpt-6-sol'));
  const payloads = h.captures.map(capture => capture.payload);
  assert.equal(updates(payloads[1]!.input).length, 1);
  assert.deepEqual(updates(payloads[2]!.input), [], 'the history is replayed without stale updates for another model');
  assert.equal(payloads[2]!.model, 'gpt-6-sol');
});

test('an existing session without plan state baselines on the effort its history already used', { timeout: 60_000 }, async t => {
  const h = await harness(t);
  await h.run('agent-private-1', h.body('Question 0', 'medium'));
  await rm(effortPath(h.home, 'agent-private-1'));
  await h.restart();
  h.judgeAnswers.push('xhigh');
  await h.run('agent-private-1', h.body('Question 1', 'auto'));
  const payloads = h.captures.map(capture => capture.payload);
  assert.equal(payloads[1]!.reasoning!.effort, payloads[0]!.reasoning!.effort, 'enabling auto keeps the cached request-level effort');
  assert.deepEqual(updates(payloads[1]!.input).map(item => item.reasoning!.effort), ['xhigh']);
});

test('judge failure, garbage and cancellation fall back to the last applied effort, else high', { timeout: 60_000 }, async t => {
  const h = await harness(t);
  h.judgeAnswers.push('I cannot tell', 'low', new Error('judge exploded'), 'medium', 'no label here');
  const ends = [];
  for (const text of ['Question 0', 'Question 1', 'Question 2', 'Question 3', 'Question 4']) ends.push(await h.run('agent-private-1', h.body(text, 'auto')));
  assert.deepEqual(ends.map(end => end.effort), ['high', 'low', 'low', 'medium', 'medium']);
  // A failed call that consumed nothing records no usage; garbage that did is still accounted.
  assert.equal(ends[2]!.judge_usage, undefined);
  assert.equal((ends[0]!.judge_usage as { total: number }).total >= 0, true);
});

test('steered messages are not re-judged; a subagent is judged once on its task', { timeout: 60_000 }, async t => {
  const h = await harness(t);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  h.replies.push(async () => { entered.resolve(); await gate.promise; return 'first'; });
  h.judgeAnswers.push('high');
  // The first model reply waits until the steering input has been accepted.
  const id = await h.start('agent-private-1', h.body('Question 0', 'auto'));
  await entered.promise;
  const steer = await h.http(`/v1/runs/${id}/steer`, { input_id: 'in-1', prompt: { text: 'Also this', images: [] }, context_prefix: '' });
  assert.equal(steer.status, 200);
  gate.resolve();
  const events = await h.events(id);
  assert.equal(events.at(-1)!.status, 'completed');
  assert.equal(h.judgeCalls.length, 1, 'the steered message is not judged');

  const subagent = (task: string) => h.body(task, 'auto', 'gpt-6.1-sol', { kind: 'subagent', sandbox: { scope_key: 'private:1/delegate/bg-1', workspace_id: 'user-1', sandbox_id: 'sandbox', lifecycle_id: 'life', profile: 'agent', cwd: '/workspace' }, tools: ['read'] });
  h.judgeAnswers.push('xhigh');
  const first = await h.run('agent-private-1-bg-1', subagent('Investigate the intermittent deadlock'));
  const second = await h.run('agent-private-1-bg-1', subagent('Investigate the intermittent deadlock'));
  assert.equal(h.judgeCalls.length, 2, 'one judge call for the whole subagent session');
  assert.equal(first.effort, 'xhigh');
  assert.equal(second.effort, 'xhigh');
  assert.equal(second.judge_usage, undefined);
  assert.doesNotMatch(h.judgeCalls[1]!.text, /previous_request/);
});

test('summarization bypasses the planner; compaction with auto uses the last applied effort and the plan then resets', { timeout: 60_000 }, async t => {
  const h = await harness(t);
  const long = 'Historical question. '.repeat(3_500);
  const body = (text: string, thinking: RunRequest['model']['thinking']) => { const request = h.body(text, thinking); request.model.contextWindow = 128_000; return request; };
  h.judgeAnswers.push('high', 'low', 'low');
  await h.run('agent-private-1', body(long, 'auto'));
  await h.run('agent-private-1', body(`${long} second`, 'auto'));
  await h.run('agent-private-1', body(`${long} third`, 'auto'));
  const file = effortPath(h.home, 'agent-private-1');
  const before = readFileSync(file, 'utf8');
  assert.equal(JSON.parse(before).transitions.length, 1);
  const seen = h.captures.length;
  h.replies.push('A checkpoint summary of the earlier work.');
  const response = await h.http('/v1/sessions/agent-private-1/compact', { model: { id: 'gpt-6.1-sol', thinking: 'auto', contextWindow: 128_000 } });
  assert.equal(response.status, 200);
  const outcome = await response.json() as { compacted: boolean };
  assert.equal(outcome.compacted, true);
  const summaries = h.captures.slice(seen);
  assert(summaries.length >= 1);
  for (const summary of summaries) {
    assert.equal(summary.planned, false, 'Pi summarization requests carry no planner hook');
    assert.deepEqual(updates(summary.payload.input), []);
  }
  assert.equal(readFileSync(file, 'utf8'), before, 'summarization leaves the plan untouched');
  assert.equal(h.judgeCalls.length, 3, 'compaction never calls the judge');
  // History was rewritten: the recorded anchors no longer match, so the next request re-baselines on its own effort.
  h.judgeAnswers.push('xhigh');
  h.captures.length = 0;
  const end = await h.run('agent-private-1', body('After compaction', 'auto'));
  assert.equal(end.effort, 'xhigh');
  const after = h.captures.at(-1)!.payload;
  assert.deepEqual(updates(after.input), []);
  const xhighWire = after.reasoning!.effort;
  assert(xhighWire);
  assert.equal(summaries[0]!.payload.reasoning?.effort, 'low', 'the summary ran at the last applied effort');
  assert.equal(xhighWire, 'xhigh');
});

test('judge timeouts and garbage never throw; the title prompt is bounded and sanitized', async () => {
  const hanging = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ models: [{ id: 'slow-judge' }], tokensPerSecond: 1_000_000 });
  hanging.registerNativeProvider(faux.provider);
  faux.setResponses(Array.from({ length: 4 }, () => (async (_context, options) => { await new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true })); return fauxAssistantMessage('low'); }) as FauxResponseStep));
  const started = Date.now();
  const judgment = await judgeEffort(async () => hanging, { id: 'slow-judge', thinking: 'low' }, { text: 'anything' }, undefined, 50);
  assert.equal(judgment.effort, undefined);
  assert(Date.now() - started < 2_000);
  await assert.rejects(generateTitle(async () => hanging, { id: 'slow-judge', thinking: 'low' }, { text: 'anything' }, undefined, 50), { status: 504 });

  assert.equal(parseEffort('The answer: HIGH.'), 'high');
  assert.equal(parseEffort('xhigh'), 'xhigh');
  assert.equal(parseEffort('medium or low'), 'medium', 'first whole-word label wins');
  assert.equal(parseEffort('highest'), undefined);
  assert.equal(parseEffort('超高'), undefined);
  assert.equal(sanitizeTitle('"Quarterly sales review."'), 'Quarterly sales review');
  assert.equal(sanitizeTitle('标题：「二季度销售复盘。」\n解释'), '二季度销售复盘');
  assert.equal(sanitizeTitle('# **一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十**'), '一二三四五六七八九十一二三四五六七八九十一二三四');
  assert.equal(sanitizeTitle('one two three four five six seven eight nine ten'), 'one two three four five six seven eight');
  assert.equal(sanitizeTitle('```\n```'), '');
});

test('planStableEffort places a change inside a tool loop after the latest tool result and never emits adjacent updates', () => {
  const state: Parameters<typeof planStableEffort>[0] = { transitions: [] };
  const system = { role: 'developer' };
  const userOne = { role: 'user', content: 'one' };
  const call = { type: 'function_call', call_id: 'a' };
  const output = { type: 'function_call_output', call_id: 'a' };
  const answer = { role: 'assistant', content: 'done' };
  assert.equal(planStableEffort(state, [system, userOne], 'high'), 'high');
  const loop = [system, userOne, call, output];
  assert.equal(planStableEffort(state, loop, 'low'), 'high');
  assert.deepEqual(loop.map(item => (item as Item).type ?? (item as Item).role), ['developer', 'user', 'function_call', 'function_call_output', 'configuration_update']);
  const next = [system, userOne, call, output, answer, { role: 'user', content: 'two' }];
  assert.equal(planStableEffort(state, next, 'xhigh'), 'high');
  assert.deepEqual(next.map(item => (item as Item).reasoning?.effort ?? (item as Item).type ?? (item as Item).role), ['developer', 'user', 'function_call', 'function_call_output', 'low', 'assistant', 'xhigh', 'user']);
  noAdjacent(next as Item[]);
  // Going back to the effort in force at that position is a no-op.
  const again = [system, userOne, call, output, answer, { role: 'user', content: 'two' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'three' }];
  assert.equal(planStableEffort(state, again, 'xhigh'), 'high');
  assert.equal(again.filter(item => (item as Item).type === 'configuration_update').length, 2);
  // A rewritten history (compaction) resets the baseline to the request's own effort.
  const compacted = [system, { role: 'user', content: 'summary' }, { role: 'user', content: 'four' }];
  assert.equal(planStableEffort(state, compacted, 'medium'), 'medium');
  assert.equal(compacted.length, 3);
});

test('titles: strict body validation, sanitized result with usage, model failure and judge restrictions', { timeout: 30_000 }, async t => {
  const h = await harness(t);
  const judge = { id: 'gpt-6-luna', thinking: 'low' };
  h.judgeAnswers.push('"季度销售复盘。"');
  const ok = await h.http('/v1/titles', { judge, text: '帮我复盘本季度销售', files: ['销售.xlsx'] });
  assert.equal(ok.status, 200);
  const result = await ok.json() as { title: string; model: string; usage: Record<string, number> };
  assert.equal(result.title, '季度销售复盘');
  assert.equal(result.model, 'gpt-6-luna');
  assert.deepEqual(Object.keys(result.usage).sort(), ['cache_read', 'cache_write', 'input', 'output', 'total']);
  assert.equal(h.judgeCalls[0]!.options?.sessionId, 'agent-platform-judge-title');
  assert.match(h.judgeCalls[0]!.text, /销售\.xlsx/);
  h.judgeAnswers.push(new Error('upstream down'));
  assert.equal((await h.http('/v1/titles', { judge, text: 'hello' })).status, 502);
  h.judgeAnswers.push('   ');
  assert.equal((await h.http('/v1/titles', { judge, text: 'hello' })).status, 502);
  for (const bad of [
    { judge, text: '' }, { judge, text: 'x'.repeat(8001) }, { judge, text: 1 }, { text: 'hello' },
    { judge: { ...judge, thinking: 'auto' }, text: 'hello' }, { judge: { id: '', thinking: 'low' }, text: 'hello' },
    { judge, text: 'hello', files: 'a.txt' }, { judge, text: 'hello', files: Array.from({ length: 21 }, () => 'a') }, { judge, text: 'hello', files: [''] },
  ]) assert.equal((await h.http('/v1/titles', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  assert.equal((await h.http('/v1/titles')).status, 405);
});

test('run and compaction validation: auto needs a judge on runs only, and the judge is never auto', { timeout: 30_000 }, async t => {
  const h = await harness(t);
  const noJudge = h.body('hi', 'auto'); delete noJudge.judge;
  assert.equal((await h.http('/v1/sessions/agent-private-1/runs', noJudge)).status, 400);
  const autoJudge = h.body('hi', 'auto'); autoJudge.judge = { id: 'gpt-6-luna', thinking: 'auto' as never };
  assert.equal((await h.http('/v1/sessions/agent-private-1/runs', autoJudge)).status, 400);
  const response = await h.http('/v1/sessions/agent-private-1/compact', { model: { id: 'gpt-6.1-sol', thinking: 'auto' } });
  assert.equal(response.status, 404, 'auto passes validation for compaction (this session simply does not exist)');
  assert.equal((await h.http('/v1/sessions/agent-private-1/compact', { model: { id: 'gpt-6.1-sol', thinking: 'turbo' } })).status, 400);
});

test('a damaged plan file is ignored and a bad transition never fails a request', { timeout: 30_000 }, async t => {
  const h = await harness(t);
  await h.run('agent-private-1', h.body('Question 0', 'high'));
  const file = effortPath(h.home, 'agent-private-1');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...saved, transitions: [null] }));
  writeFileSync(`${file}.1.tmp`, '{}');
  await h.restart();
  await h.run('agent-private-1', h.body('Question 1', 'low'));
  assert.equal(h.captures.length, 2);
  assert.equal((await h.http('/v1/sessions/agent-private-1', undefined, 'DELETE')).status, 200);
  assert(!existsSync(file) && !existsSync(`${file}.1.tmp`));
});

test('an off turn (wire none) is sent as built and never enters the plan', { timeout: 30_000 }, async t => {
  const h = await harness(t);
  await h.run('agent-private-1', h.body('Question 0', 'medium'));
  await h.run('agent-private-1', h.body('Question 1', 'high'));
  const file = effortPath(h.home, 'agent-private-1');
  const before = readFileSync(file, 'utf8');
  await h.run('agent-private-1', h.body('Question 2', 'off'));
  const off = h.captures[2]!.payload;
  assert.equal(off.reasoning!.effort, 'none');
  assert.deepEqual(updates(off.input), []);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).transitions, JSON.parse(before).transitions);
  await h.run('agent-private-1', h.body('Question 3', 'medium'));
  const next = h.captures[3]!.payload;
  assert.deepEqual(updates(next.input).map(item => item.reasoning!.effort), ['high', 'medium'], 'earlier transitions replay; the off turn left no trace');
  assert.equal(next.reasoning!.effort, h.captures[0]!.payload.reasoning!.effort);
  assert(!readFileSync(file, 'utf8').includes('"none"'));
});

test('without state, the baseline is the level the session last ran at, even after a reopen', { timeout: 30_000 }, async t => {
  const h = await harness(t);
  await h.run('agent-private-1', h.body('Question 0', 'medium'));
  // Changed resources reopen the Pi object on the same journal.
  const changed = h.body('Question 1', 'high'); changed.resources.system_prompt = 'Changed prefix';
  await h.run('agent-private-1', changed);
  await rm(effortPath(h.home, 'agent-private-1'));
  await h.restart();
  h.judgeAnswers.push('high');
  await h.run('agent-private-1', { ...h.body('Question 2', 'auto'), resources: changed.resources });
  const last = h.captures[2]!.payload;
  assert.deepEqual(updates(last.input), [], 'high was already in force');
  assert.equal(last.reasoning!.effort, 'high');
});
