import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import type {
  AgentMemoriesExportResponse,
  AgentMemoriesResponse,
  AgentMemoryMutationRequest,
  AgentMemoryMutationResponse,
  AgentMemoryTarget,
  DeleteAgentMemoryResponse,
  Id,
} from "../types";

const DEFAULT_MEMORY_LIMIT = 500;

export function loadAgentMemories(
  target: AgentMemoryTarget,
  query = "",
  signal?: AbortSignal,
): Promise<AgentMemoriesResponse> {
  return api(endpoints.privateAgentMemories.path(target, query.trim(), DEFAULT_MEMORY_LIMIT), { signal });
}

export function createAgentMemory(
  payload: AgentMemoryMutationRequest,
): Promise<AgentMemoryMutationResponse> {
  return api(endpoints.createPrivateAgentMemory.path(), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAgentMemory(
  id: Id,
  payload: AgentMemoryMutationRequest,
): Promise<AgentMemoryMutationResponse> {
  return api(endpoints.updatePrivateAgentMemory.path(id), {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteAgentMemory(
  id: Id,
): Promise<DeleteAgentMemoryResponse> {
  return api(endpoints.deletePrivateAgentMemory.path(id), { method: "DELETE" });
}

export function clearAgentMemories(
  target: AgentMemoryTarget,
): Promise<DeleteAgentMemoryResponse> {
  return api(endpoints.clearPrivateAgentMemories.path(target), { method: "DELETE" });
}

export function exportAgentMemories(): Promise<AgentMemoriesExportResponse> {
  return api(endpoints.exportPrivateAgentMemories.path());
}
