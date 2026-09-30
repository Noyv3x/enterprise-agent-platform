import { lstat, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from './http.js';
import { migrateSessions } from './migration.js';
import { Runtime } from './runtime.js';

async function secret(name: string, defaultFile: string): Promise<string> {
  const direct = process.env[name];
  const configuredFile = process.env[`${name}_FILE`];
  if (direct !== undefined && configuredFile) throw new Error(`${name} and ${name}_FILE cannot both be set`);
  let value = direct;
  if (value === undefined) {
    const file = configuredFile ?? defaultFile;
    if (!(await lstat(file)).isFile()) throw new Error(`${name}_FILE must name a regular secret file`);
    value = await readFile(file, 'utf8');
  }
  value = value.trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
}
function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
async function main(): Promise<void> {
  const home = process.env.AGENT_RUNTIME_HOME ?? '/var/lib/agent-platform/runtime';
  const port = positiveInteger('AGENT_RUNTIME_PORT', 8766);
  if (port > 65535) throw new Error('AGENT_RUNTIME_PORT must be at most 65535');
  const maximum = positiveInteger('AGENT_RUNTIME_MAX_BODY_BYTES', 33_554_432);
  const [token, platformToken, executorToken] = await Promise.all([
    secret('AGENT_RUNTIME_TOKEN', '/run/secrets/agent-platform/agent-runtime-token'),
    secret('AGENT_PLATFORM_INTERNAL_TOKEN', '/run/secrets/agent-platform/agent-tool-token'),
    secret('AGENT_MANAGER_EXECUTOR_TOKEN', '/run/secrets/agent-platform/manager-executor-token'),
  ]);
  await migrateSessions(home);
  const runtime = new Runtime({
    home,
    platformUrl: process.env.AGENT_PLATFORM_INTERNAL_URL ?? 'http://platform:8765',
    platformToken,
    executorSocket: process.env.AGENT_MANAGER_EXECUTOR_SOCKET ?? '/run/agent-platform-manager/manager.sock',
    executorToken,
    skillsDirectory: process.env.AGENT_RUNTIME_SKILLS_DIRECTORY ?? '/app/skills',
  });
  const server = createServer(runtime, token, maximum);
  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 40_000);
    deadline.unref();
    const closed = once(server, 'close');
    server.close();
    try {
      await runtime.close();
      server.closeAllConnections();
      await closed;
    } catch (error) {
      console.error('Runtime shutdown failed', error);
      process.exitCode = 1;
      server.closeAllConnections();
    } finally { clearTimeout(deadline); }
  }
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  server.listen(port, process.env.AGENT_RUNTIME_HOST ?? '0.0.0.0');
  try { await once(server, 'listening'); }
  catch (error) { await runtime.close(); throw error; }
  console.log(`Agent Platform Runtime listening on port ${port}`);
}
main().catch(error => { console.error('Runtime startup failed', error); process.exitCode = 1; });
