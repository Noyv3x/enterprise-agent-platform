import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import type {
  AgentPreviewScope,
  AgentSkillCreateRequest,
  AgentSkillPatchRequest,
  AgentSkillResponse,
  AgentSkillsResponse,
  DeleteAgentSkillResponse,
  Id,
} from "../types";

const DEFAULT_SKILL_LIMIT = 200;

export function loadAgentSkills(
  scope: AgentPreviewScope,
  query = "",
  signal?: AbortSignal,
): Promise<AgentSkillsResponse> {
  return api(
    endpoints.agentSkills.path(
      scope.scope_type,
      scope.scope_id,
      query.trim(),
      DEFAULT_SKILL_LIMIT,
    ),
    { signal },
  );
}

export function loadAgentSkill(
  scope: AgentPreviewScope,
  id: Id,
  signal?: AbortSignal,
): Promise<AgentSkillResponse> {
  return api(
    endpoints.agentSkill.path(id, scope.scope_type, scope.scope_id),
    { signal },
  );
}

export function createAgentSkill(
  scope: AgentPreviewScope,
  payload: AgentSkillCreateRequest,
): Promise<AgentSkillResponse> {
  return api(
    endpoints.createAgentSkill.path(scope.scope_type, scope.scope_id),
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function updateAgentSkill(
  scope: AgentPreviewScope,
  id: Id,
  payload: AgentSkillPatchRequest,
): Promise<AgentSkillResponse> {
  return api(
    endpoints.updateAgentSkill.path(id, scope.scope_type, scope.scope_id),
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}

export function deleteAgentSkill(
  scope: AgentPreviewScope,
  id: Id,
): Promise<DeleteAgentSkillResponse> {
  return api(
    endpoints.deleteAgentSkill.path(id, scope.scope_type, scope.scope_id),
    { method: "DELETE" },
  );
}
