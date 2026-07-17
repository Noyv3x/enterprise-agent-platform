import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import type {
  AgentScheduleResponse,
  AgentScheduleRunsResponse,
  AgentScheduleRunNowResponse,
  AgentSchedulesResponse,
  DeleteAgentScheduleResponse,
  Id,
} from "../types";

export function loadAgentSchedules(signal?: AbortSignal): Promise<AgentSchedulesResponse> {
  return api(endpoints.privateSchedules.path(), { signal });
}

export function loadAgentSchedule(id: Id, signal?: AbortSignal): Promise<AgentScheduleResponse> {
  return api(endpoints.privateSchedule.path(id), { signal });
}

export function loadAgentScheduleRuns(
  id: Id,
  limit = 20,
  beforeId?: Id,
  signal?: AbortSignal,
): Promise<AgentScheduleRunsResponse> {
  return api(endpoints.privateScheduleRuns.path(id, limit, beforeId), { signal });
}

export function pauseAgentSchedule(id: Id): Promise<AgentScheduleResponse> {
  return api(endpoints.pausePrivateSchedule.path(id), { method: "POST" });
}

export function resumeAgentSchedule(id: Id): Promise<AgentScheduleResponse> {
  return api(endpoints.resumePrivateSchedule.path(id), { method: "POST" });
}

export function runAgentScheduleNow(id: Id): Promise<AgentScheduleRunNowResponse> {
  return api(endpoints.runPrivateScheduleNow.path(id), { method: "POST" });
}

export function deleteAgentSchedule(id: Id): Promise<DeleteAgentScheduleResponse> {
  return api(endpoints.deletePrivateSchedule.path(id), { method: "DELETE" });
}
