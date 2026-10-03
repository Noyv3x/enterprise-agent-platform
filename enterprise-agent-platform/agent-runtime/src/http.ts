import { timingSafeEqual } from 'node:crypto';
import { createServer as nodeCreateServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Runtime } from './runtime.js';

type Service = Pick<Runtime, 'start' | 'steer' | 'events' | 'cancel' | 'cancelSession' | 'compact' | 'delete' | 'history'>;
const tools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_search', 'web_fetch', 'browser', 'schedule', 'mcp'];
const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
function failure(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function validateModel(model: unknown): asserts model is Parameters<Runtime['start']>[1]['model'] {
  if (!object(model) || !text(model.id) || typeof model.thinking !== 'string' || !thinking.includes(model.thinking)) throw failure(400, 'Invalid model');
  for(const key of ['contextWindow','maxTokens']){
    const value=model[key];
    if(value!==undefined&&(typeof value!=='number'||!Number.isSafeInteger(value)||value<1))throw failure(400,`Invalid model ${key}`);
  }
}
function validatePrompt(prompt: unknown): asserts prompt is Parameters<Runtime['start']>[1]['prompt'] {
  if (!object(prompt) || typeof prompt.text !== 'string' || (prompt.images !== undefined && (!Array.isArray(prompt.images) || !prompt.images.every(image => object(image) && text(image.mime) && text(image.data))))) throw failure(400, 'Invalid prompt');
}
function validateSteer(value: unknown): asserts value is Parameters<Runtime['steer']>[1] {
  if (!object(value) || !text(value.input_id) || value.input_id.length > 64) throw failure(400, 'Invalid input_id');
  validatePrompt(value.prompt);
  if (!Array.isArray(value.prompt.images)) throw failure(400, 'Invalid prompt images');
  if (typeof value.context_prefix !== 'string') throw failure(400, 'Invalid context_prefix');
}
function validateRun(value: unknown): asserts value is Parameters<Runtime['start']>[1] {
  if (!object(value) || !['agent', 'chat'].includes(String(value.kind))) throw failure(400, 'Invalid run kind');
  const { sandbox, model, prompt, resources } = value;
  if (!object(sandbox) || !['scope_key', 'workspace_id', 'sandbox_id', 'lifecycle_id', 'cwd'].every(key => text(sandbox[key])) || !['agent', 'chat'].includes(String(sandbox.profile))) throw failure(400, 'Invalid sandbox');
  validateModel(model);
  validatePrompt(prompt);
  if (value.context_prefix !== undefined && typeof value.context_prefix !== 'string') throw failure(400, 'Invalid context_prefix');
  if (!object(resources) || typeof resources.system_prompt !== 'string' || !Array.isArray(resources.skills) || !resources.skills.every(skill => object(skill) && text(skill.name) && typeof skill.description === 'string' && text(skill.path)) || (resources.agents_md !== null && resources.agents_md !== undefined && (!object(resources.agents_md) || !text(resources.agents_md.path) || typeof resources.agents_md.content !== 'string'))) throw failure(400, 'Invalid resources');
  if (!Array.isArray(value.tools) || !value.tools.every(tool => typeof tool === 'string' && tools.includes(tool))) throw failure(400, 'Invalid tools');
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
function body(request: IncomingMessage, maximum: number): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (contentType && contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    request.resume();
    return Promise.reject(failure(415, 'Expected application/json'));
  }
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const chunks: Buffer[] = [];
  let size = 0;
  let rejected = false;
  request.on('data', (chunk: Buffer) => {
    if (rejected) return;
    size += chunk.length;
    if (size > maximum) {
      rejected = true;
      chunks.length = 0;
      reject(failure(413, 'Request body too large'));
    } else chunks.push(chunk);
  });
  request.on('error', reject);
  request.on('aborted', () => reject(failure(400, 'Request aborted')));
  request.on('end', () => {
    if (rejected) return;
    try { resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
    catch { reject(failure(400, 'Invalid JSON body')); }
  });
  return promise;
}
function integer(value: string | null, fallback: number, minimum: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw failure(400, 'Invalid pagination parameter');
  return Number(value);
}
export function createServer(runtime: Service, token: string, maxBodyBytes = 33_554_432) {
  if (!token.trim()) throw new Error('Runtime bearer token is required');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error('Invalid maximum body size');
  const authorization = Buffer.from(`Bearer ${token}`);
  return nodeCreateServer(async (request, response) => {
    try {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        response.setHeader('www-authenticate', 'Bearer');
        throw failure(401, 'Unauthorized');
      }
      const url = new URL(request.url ?? '/', 'http://runtime');
      const method = request.method;
      if (url.pathname === '/health') {
        if (method !== 'GET') { response.setHeader('allow', 'GET'); throw failure(405, 'Method not allowed'); }
        json(response, 200, { status: 'ok', service: 'agent-platform-runtime' });
        return;
      }
      const route = /^\/v1\/(sessions|runs)\/([^/]+)(?:\/(runs|events|steer|cancel|compact|history))?$/.exec(url.pathname);
      if (!route) throw failure(404, 'Not found');
      let id: string;
      try { id = decodeURIComponent(route[2]!); } catch { throw failure(400, 'Invalid identifier'); }
      if (!id || /[\x00-\x1f\x7f]/.test(id)) throw failure(400, 'Invalid identifier');
      const operation = `${route[1]}/${route[3] ?? ''}`;
      const allowed: Record<string, string> = { 'sessions/runs': 'POST', 'sessions/cancel': 'POST', 'sessions/compact': 'POST', 'sessions/': 'DELETE', 'sessions/history': 'GET', 'runs/events': 'GET', 'runs/steer': 'POST', 'runs/cancel': 'POST' };
      if (!allowed[operation]) throw failure(404, 'Not found');
      if (method !== allowed[operation]) { response.setHeader('allow', allowed[operation]); throw failure(405, 'Method not allowed'); }
      switch (operation) {
        case 'sessions/runs': {
          const input = await body(request, maxBodyBytes);
          validateRun(input);
          json(response, 202, await runtime.start(id, input));
          return;
        }
        case 'runs/steer': {
          const input = await body(request, maxBodyBytes);
          validateSteer(input);
          runtime.steer(id, input);
          break;
        }
        case 'runs/events': runtime.events(id, integer(url.searchParams.get('after'), 0, 0), response); return;
        case 'runs/cancel': await runtime.cancel(id); break;
        case 'sessions/cancel': json(response, 200, await runtime.cancelSession(id)); return;
        case 'sessions/compact': {
          const input = await body(request, maxBodyBytes);
          if (!object(input)) throw failure(400, 'Invalid compact request');
          validateModel(input.model);
          json(response, 200, await runtime.compact(id, input.model));
          return;
        }
        case 'sessions/': await runtime.delete(id); break;
        case 'sessions/history': json(response, 200, await runtime.history(id, url.searchParams.get('before') ?? undefined, integer(url.searchParams.get('limit'), 100, 1))); return;
      }
      json(response, 200, { ok: true });
    } catch (error) {
      if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
      const candidate = object(error) ? error.status : undefined;
      const status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
      if (status === 500) console.error('Runtime request failed', error);
      json(response, status, { error: status === 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Request failed' });
    }
  });
}
