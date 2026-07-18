import type { GatewayToolRequest, GatewayToolResponse, JsonObject, RunRequest } from "./types.js";
import { errorMessage, throwIfAborted } from "./utils.js";

export class PlatformGateway {
  private readonly defaultUrl: string | undefined;
  private readonly defaultToken: string | undefined;

  constructor(defaultUrl?: string, defaultToken?: string) {
    this.defaultUrl = defaultUrl;
    this.defaultToken = defaultToken;
  }

  get configured(): boolean {
    return Boolean(this.defaultUrl);
  }

  async invoke(
    request: RunRequest,
    runId: string,
    tool: GatewayToolRequest["tool"],
    action: string,
    arguments_: JsonObject,
    signal?: AbortSignal,
  ): Promise<GatewayToolResponse> {
    throwIfAborted(signal);
    const { baseUrl, token } = this.connection(request);
    if (!baseUrl) throw new Error(`Platform gateway is not configured for ${tool}`);
    const owner = ownerUserId(request);
    const sourceMessageId = sourceMessageIdFor(request);
    const body: GatewayToolRequest = {
      tool,
      action,
      arguments: arguments_,
      context: {
        run_id: runId,
        scope_key: request.scope_key,
        lifecycle_id: request.lifecycle_id,
        session_id: request.session_id,
        workspace: request.workspace,
        ...(owner === undefined ? {} : { owner_user_id: owner }),
        ...(sourceMessageId === undefined ? {} : { source_message_id: sourceMessageId }),
      },
    };
    const target = gatewayTarget(baseUrl, body);
    let response: Response;
    try {
      const init: RequestInit = {
        method: target.method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      };
      if (target.body !== undefined) init.body = JSON.stringify(target.body);
      if (signal) init.signal = signal;
      response = await fetch(target.url, init);
    } catch (error) {
      throw new Error(`Platform ${tool} gateway failed: ${errorMessage(error)}`);
    }
    const text = await response.text();
    let payload: GatewayToolResponse;
    try {
      payload = text ? JSON.parse(text) as GatewayToolResponse : {};
    } catch {
      payload = { content: text };
    }
    if (!response.ok) throw new Error(payload.error || payload.content || `Platform ${tool} gateway returned HTTP ${response.status}`);
    if (!payload.content) payload.content = JSON.stringify(payload.data ?? payload, null, 2);
    return payload;
  }

  async token(request: RunRequest, provider: string, signal?: AbortSignal): Promise<string | undefined> {
    const { baseUrl, token } = this.connection(request);
    if (!baseUrl) return undefined;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ provider, scope_key: request.scope_key }),
    };
    if (signal) init.signal = signal;
    const response = await fetch(`${baseUrl}/api/agent/tools/credentials/resolve`, init);
    if (!response.ok) return undefined;
    const result = await response.json() as { access_token?: string };
    return result.access_token;
  }

  private connection(request: RunRequest): { baseUrl: string | undefined; token: string | undefined } {
    // Never combine an untrusted run-level URL with the sidecar's platform
    // token. A configured managed URL is authoritative. The run-level token may
    // replace only the credential sent to that fixed URL so an administrator
    // can rotate the platform tool token without restarting the sidecar.
    if (this.defaultUrl) {
      return {
        baseUrl: this.defaultUrl.replace(/\/$/, ""),
        token: request.gateway?.token || this.defaultToken,
      };
    }
    return {
      baseUrl: request.gateway?.base_url?.replace(/\/$/, ""),
      token: request.gateway?.token,
    };
  }
}

function gatewayTarget(baseUrl: string, request: GatewayToolRequest): { method: "GET" | "POST"; url: string; body?: JsonObject } {
  const arguments_ = request.tool === "memory"
    ? authoritativeMemoryArguments(request)
    : request.arguments;
  const flattened: JsonObject = {
    ...arguments_,
    scope_key: request.context.scope_key,
    lifecycle_id: request.context.lifecycle_id,
    session_id: request.context.session_id,
    run_id: request.context.run_id,
  };
  if (request.tool === "memory") {
    if (["search", "read", "list"].includes(request.action)) {
      return {
        method: "POST",
        url: `${baseUrl}/api/agent/tools/memory/search`,
        body: { ...flattened, action: request.action },
      };
    }
    const aliases: Record<string, string> = { store: "add", delete: "remove", forget: "remove" };
    return {
      method: "POST",
      url: `${baseUrl}/api/agent/tools/memory`,
      body: { ...flattened, action: aliases[request.action] ?? request.action },
    };
  }
  if (request.tool === "session") {
    const requestedSession = request.arguments.session_id;
    return {
      method: "POST",
      url: `${baseUrl}/api/agent/tools/session/search`,
      body: {
        ...flattened,
        action: request.action,
        ...(request.action === "read" && typeof requestedSession === "string"
          ? { session_id: requestedSession }
          : {}),
      },
    };
  }
  if (request.tool === "knowledge") {
    if (["read", "document", "get"].includes(request.action)) {
      const documentId = request.arguments.document_id ?? request.arguments.id;
      if (typeof documentId !== "number" && typeof documentId !== "string") throw new Error("knowledge read requires document_id");
      return { method: "GET", url: `${baseUrl}/api/agent/tools/knowledge/documents/${encodeURIComponent(String(documentId))}` };
    }
    const query = new URLSearchParams();
    if (request.arguments.query !== undefined) query.set("q", String(request.arguments.query));
    if (request.arguments.limit !== undefined) query.set("limit", String(request.arguments.limit));
    return { method: "GET", url: `${baseUrl}/api/agent/tools/knowledge/search?${query}` };
  }
  return { method: "POST", url: `${baseUrl}/internal/agent/tools/${request.tool}`, body: request as unknown as JsonObject };
}

function authoritativeMemoryArguments(request: GatewayToolRequest): JsonObject {
  const owner = request.context.owner_user_id;
  const result: JsonObject = { ...request.arguments };
  delete result.owner_user_id;
  if (owner !== undefined) result.owner_user_id = owner;
  if (Array.isArray(request.arguments.operations)) {
    result.operations = request.arguments.operations.map((operation) => {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) return operation;
      const normalized: JsonObject = { ...(operation as JsonObject) };
      delete normalized.owner_user_id;
      if (owner !== undefined) normalized.owner_user_id = owner;
      delete normalized.source_run_id;
      delete normalized.source_message_id;
      delete normalized.source_message_key;
      delete normalized.source_type;
      delete normalized.candidate_hash;
      const operationAction = typeof normalized.action === "string" ? normalized.action : request.action;
      if (!["search", "read", "list"].includes(operationAction)) {
        normalized.source_run_id = request.context.run_id;
        normalized.source_type = "tool";
        if (request.context.source_message_id !== undefined) {
          normalized.source_message_id = request.context.source_message_id;
        }
      }
      return normalized;
    });
  }
  if (!["search", "read", "list"].includes(request.action)) {
    result.source_run_id = request.context.run_id;
    result.source_type = "tool";
    if (request.context.source_message_id !== undefined) {
      result.source_message_id = request.context.source_message_id;
    } else {
      delete result.source_message_id;
    }
    delete result.source_message_key;
  } else {
    delete result.source_run_id;
    delete result.source_message_id;
    delete result.source_message_key;
    delete result.source_type;
    delete result.candidate_hash;
  }
  delete result.candidate_hash;
  return result;
}

export function ownerUserId(request: RunRequest): number | undefined {
  const actor = request.metadata?.actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) return undefined;
  const value = (actor as Record<string, unknown>).id;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function sourceMessageIdFor(request: RunRequest): number | undefined {
  const explicit = request.metadata?.source_message_id;
  if (typeof explicit === "number" && Number.isSafeInteger(explicit) && explicit > 0) {
    return explicit;
  }
  return undefined;
}
