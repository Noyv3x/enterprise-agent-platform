import { request, type McpPromptList } from "../../api";

const pending = new Map<string, Promise<McpPromptList>>();

/** The MCP prompts and connector labels of a conversation scope (`GET /api/mcp/prompts?scope=`: `private`, `chat`,
 * `chat-<id>` or `channel-<id>`). The composer and the conversation ask for it together; they share one request. */
export function loadMcpCatalog(scope: string): Promise<McpPromptList> {
  let promise = pending.get(scope);
  if (!promise) {
    promise = request<McpPromptList>(`/api/mcp/prompts?scope=${encodeURIComponent(scope)}`).finally(() => pending.delete(scope));
    pending.set(scope, promise);
  }
  return promise;
}
