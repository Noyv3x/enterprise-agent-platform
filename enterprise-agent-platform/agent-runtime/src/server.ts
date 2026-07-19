import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { RunCoordinator } from "./run-coordinator.js";
import type { ApprovalDecision, RunInputRequest, RunRequest, RuntimeConfig, RuntimeEvent } from "./types.js";
import { errorMessage, safeEqual } from "./utils.js";

const VERSION = "0.1.0";
const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled", "run.needs_review"]);

export interface RuntimeServer {
  server: Server;
  coordinator: RunCoordinator;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createRuntimeServer(config: RuntimeConfig, coordinator = new RunCoordinator({ config })): RuntimeServer {
  const server = createServer((request, response) => {
    void route(config, coordinator, request, response).catch((error) => {
      if (closesConnection(error)) {
        response.shouldKeepAlive = false;
        if (!response.headersSent) response.setHeader("connection", "close");
      }
      if (!response.headersSent) json(response, statusForError(error), { error: errorMessage(error) });
      else response.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return {
    server,
    coordinator,
    async listen() {
      await mkdir(config.home, { recursive: true, mode: 0o700 });
      return await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : config.port;
          resolvePromise({ host: config.host, port });
        });
      });
    },
    async close() {
      coordinator.shutdown();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    },
  };
}

async function route(config: RuntimeConfig, coordinator: RunCoordinator, request: IncomingMessage, response: ServerResponse): Promise<void> {
  applySecurityHeaders(response);
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  authorize(config, request);
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, {
      status: "ok",
      service: "ubitech-agent-runtime",
      version: VERSION,
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/runs") {
    const body = await readJson<RunRequest>(request, config.maxBodyBytes, config.requestBodyTimeoutMs);
    const run = coordinator.createRun(body);
    json(response, 202, { run_id: run.id, status: run.status, events_url: `/v1/runs/${run.id}/events` });
    return;
  }

  const runMatch = /^\/v1\/runs\/([^/]+)(?:\/(events|approval|cancel|input))?$/.exec(url.pathname);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]!);
    const action = runMatch[2];
    const run = coordinator.getRun(runId);
    if (!run) throw httpError(404, "Run not found");
    if (request.method === "GET" && !action) {
      json(response, 200, publicRun(run));
      return;
    }
    if (request.method === "GET" && action === "events") {
      const headerSequence = Number.parseInt(String(request.headers["last-event-id"] || "0"), 10);
      const querySequence = Number.parseInt(url.searchParams.get("after") || "0", 10);
      streamEvents(response, coordinator.getJournal(runId)!, Math.max(Number.isFinite(headerSequence) ? headerSequence : 0, Number.isFinite(querySequence) ? querySequence : 0));
      return;
    }
    if (request.method === "POST" && action === "input") {
      const body = await readJson<RunInputRequest>(
        request,
        config.maxBodyBytes,
        config.requestBodyTimeoutMs,
      );
      const accepted = await coordinator.submitInput(runId, body);
      json(response, accepted.state === "injected" ? 200 : 202, accepted);
      return;
    }
    if (request.method === "POST" && action === "approval") {
      const body = await readJson<Record<string, unknown>>(
        request,
        config.maxBodyBytes,
        config.requestBodyTimeoutMs,
      );
      if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "Invalid approval request");
      const allowedKeys = new Set(["approval_id", "decision"]);
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
        throw httpError(400, "Approval request accepts only approval_id and decision");
      }
      if (body.approval_id !== undefined && (typeof body.approval_id !== "string" || !body.approval_id.trim())) {
        throw httpError(400, "approval_id must be a non-empty string when provided");
      }
      const decision = body.decision as ApprovalDecision | undefined;
      if (!decision || !["once", "session", "always", "deny"].includes(decision)) throw httpError(400, "Invalid approval decision");
      const approvalId = body.approval_id as string | undefined;
      await coordinator.respondApproval(runId, approvalId, decision);
      json(response, 200, { run_id: runId, approval_id: approvalId ?? null, decision, resolved: true });
      return;
    }
    if (request.method === "POST" && action === "cancel") {
      const cancelled = coordinator.cancel(runId);
      json(response, 202, { run_id: runId, status: cancelled.status });
      return;
    }
    throw httpError(405, "Method not allowed");
  }

  if (request.method === "POST" && url.pathname === "/v1/scopes/cleanup") {
    const body = await readJson<{ scope_key?: string; lifecycle_id?: string; delete_sessions?: boolean }>(
      request,
      config.maxBodyBytes,
      config.requestBodyTimeoutMs,
    );
    if (typeof body.scope_key !== "string" || !body.scope_key.trim() || body.scope_key.length > 512) {
      throw httpError(400, "scope_key must be a non-empty string of at most 512 characters");
    }
    if (body.lifecycle_id !== undefined && (typeof body.lifecycle_id !== "string" || body.lifecycle_id.length > 512)) {
      throw httpError(400, "lifecycle_id must be a string of at most 512 characters");
    }
    if (body.delete_sessions !== undefined && typeof body.delete_sessions !== "boolean") {
      throw httpError(400, "delete_sessions must be a boolean");
    }
    const cancelled = await coordinator.cleanupScope(body.scope_key, body.lifecycle_id, body.delete_sessions ?? false);
    json(response, 200, { scope_key: body.scope_key, cancelled_runs: cancelled, sessions_deleted: body.delete_sessions ?? false });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/scopes/processes") {
    const allowedQuery = new Set(["scope_key", "lifecycle_id"]);
    if ([...url.searchParams.keys()].some((key) => !allowedQuery.has(key))) {
      throw httpError(400, "Process preview accepts only scope_key and lifecycle_id");
    }
    const scopeKeys = url.searchParams.getAll("scope_key");
    const lifecycleIds = url.searchParams.getAll("lifecycle_id");
    const scopeKey = scopeKeys.length === 1 ? scopeKeys[0]!.trim() : "";
    const lifecycleId = lifecycleIds.length === 1 ? lifecycleIds[0]!.trim() : "";
    if (!scopeKey || scopeKey.length > 512) {
      throw httpError(400, "scope_key must be a non-empty string of at most 512 characters");
    }
    if (!lifecycleId || lifecycleId.length > 512) {
      throw httpError(400, "lifecycle_id must be a non-empty string of at most 512 characters");
    }
    json(response, 200, { processes: coordinator.processes.preview(scopeKey, lifecycleId) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/scopes/process-summary") {
    const allowedQuery = new Set(["scope_key", "lifecycle_id"]);
    if ([...url.searchParams.keys()].some((key) => !allowedQuery.has(key))) {
      throw httpError(400, "Process summary accepts only scope_key and lifecycle_id");
    }
    const scopeKeys = url.searchParams.getAll("scope_key");
    const lifecycleIds = url.searchParams.getAll("lifecycle_id");
    const scopeKey = scopeKeys.length === 1 ? scopeKeys[0]!.trim() : "";
    const lifecycleId = lifecycleIds.length === 1 ? lifecycleIds[0]!.trim() : "";
    if (!scopeKey || scopeKey.length > 512) {
      throw httpError(400, "scope_key must be a non-empty string of at most 512 characters");
    }
    if (!lifecycleId || lifecycleId.length > 512) {
      throw httpError(400, "lifecycle_id must be a non-empty string of at most 512 characters");
    }
    json(response, 200, coordinator.processes.previewSummary(scopeKey, lifecycleId));
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/processes/update-blockers") {
    if ([...url.searchParams.keys()].length > 0) {
      throw httpError(400, "Update blocker summary does not accept query parameters");
    }
    json(response, 200, coordinator.processes.updateBlockerSummary());
    return;
  }

  throw httpError(404, "Not found");
}

function streamEvents(response: ServerResponse, journal: NonNullable<ReturnType<RunCoordinator["getJournal"]>>, after: number): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  response.write(": connected\n\n");
  let unsubscribe = (): void => undefined;
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": heartbeat\n\n");
  }, 15_000);
  heartbeat.unref();
  const send = (event: RuntimeEvent): void => {
    if (response.writableEnded) return;
    response.write(`id: ${event.sequence}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (TERMINAL_EVENTS.has(event.type)) {
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    }
  };
  unsubscribe = journal.subscribe(after, send);
  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function authorize(config: RuntimeConfig, request: IncomingMessage): void {
  if (!config.bearerToken) return;
  const authorization = request.headers.authorization || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied || !safeEqual(supplied, config.bearerToken)) throw httpError(401, "Unauthorized");
}

async function readJson<T>(request: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<T> {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw httpError(415, "Content-Type must be application/json");
  return await new Promise<T>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      request.pause();
      fail(httpError(408, "Request body deadline exceeded", true));
    }, timeoutMs);
    timer.unref();

    const cleanup = (): void => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        request.pause();
        fail(httpError(413, "Request body too large", true));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
        settled = true;
        cleanup();
        resolvePromise(parsed);
      } catch {
        fail(httpError(400, "Invalid JSON body"));
      }
    };
    const onError = (): void => fail(httpError(400, "Request body stream failed", true));
    const onAborted = (): void => fail(httpError(400, "Request body was aborted", true));

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function publicRun(run: NonNullable<ReturnType<RunCoordinator["getRun"]>>): Record<string, unknown> {
  return {
    run_id: run.id,
    status: run.status,
    created_at: new Date(run.createdAt).toISOString(),
    updated_at: new Date(run.updatedAt).toISOString(),
    session_id: run.request.session_id,
    scope_key: run.request.scope_key,
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(body)}\n`);
}

interface HttpError extends Error {
  statusCode: number;
  closeConnection?: boolean;
}

function httpError(statusCode: number, message: string, closeConnection = false): HttpError {
  return Object.assign(new Error(message), { statusCode, ...(closeConnection ? { closeConnection: true } : {}) });
}

function statusForError(error: unknown): number {
  return typeof error === "object" && error !== null && "statusCode" in error ? Number((error as HttpError).statusCode) : 500;
}

function closesConnection(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as HttpError).closeConnection === true;
}

export async function startRuntimeServer(config = loadConfig()): Promise<RuntimeServer> {
  const runtime = createRuntimeServer(config);
  const address = await runtime.listen();
  process.stdout.write(`${JSON.stringify({ event: "ready", host: address.host, port: address.port, pid: process.pid })}\n`);
  const shutdown = async (): Promise<void> => {
    await runtime.close().catch((error) => process.stderr.write(`${errorMessage(error)}\n`));
    process.exitCode = 0;
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return runtime;
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  startRuntimeServer().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
