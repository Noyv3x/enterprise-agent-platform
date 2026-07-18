import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import type {
  AgentMemoriesExportResponse,
  AgentMemoriesResponse,
  AgentMemoryCandidateDecisionResponse,
  AgentMemoryCandidatesResponse,
  AgentMemoryMutationRequest,
  AgentMemoryMutationResponse,
  AgentMemoryTarget,
  DeleteAgentMemoryResponse,
  Id,
} from "../types";

const DEFAULT_MEMORY_LIMIT = 500;
const DEFAULT_CANDIDATE_LIMIT = 200;

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

export function loadAgentMemoryCandidates(
  signal?: AbortSignal,
): Promise<AgentMemoryCandidatesResponse> {
  return api(endpoints.privateAgentMemoryCandidates.path("pending", DEFAULT_CANDIDATE_LIMIT), { signal });
}

export function approveAgentMemoryCandidate(
  id: Id,
): Promise<AgentMemoryCandidateDecisionResponse> {
  return api(endpoints.approvePrivateAgentMemoryCandidate.path(id), { method: "POST" });
}

export function rejectAgentMemoryCandidate(
  id: Id,
): Promise<AgentMemoryCandidateDecisionResponse> {
  return api(endpoints.rejectPrivateAgentMemoryCandidate.path(id), { method: "POST" });
}
