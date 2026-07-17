import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteAgentSchedule,
  loadAgentSchedule,
  loadAgentScheduleRuns,
  loadAgentSchedules,
  pauseAgentSchedule,
  resumeAgentSchedule,
  runAgentScheduleNow,
} from "./scheduleActions";
import { api } from "../lib/api";

vi.mock("../lib/api", () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

describe("schedule actions", () => {
  beforeEach(() => apiMock.mockReset().mockResolvedValue({}));

  it("reads the owner-scoped list, detail, and paginated history", async () => {
    const controller = new AbortController();
    await loadAgentSchedules(controller.signal);
    await loadAgentSchedule(9, controller.signal);
    await loadAgentScheduleRuns(9, 20, 31, controller.signal);

    expect(apiMock).toHaveBeenNthCalledWith(1, "/api/private-agent/schedules", { signal: controller.signal });
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/private-agent/schedules/9", { signal: controller.signal });
    expect(apiMock).toHaveBeenNthCalledWith(
      3,
      "/api/private-agent/schedules/9/runs?limit=20&before_id=31",
      { signal: controller.signal },
    );
  });

  it("uses explicit state-changing methods for every management action", async () => {
    await pauseAgentSchedule(9);
    await resumeAgentSchedule(9);
    await runAgentScheduleNow(9);
    await deleteAgentSchedule(9);

    expect(apiMock).toHaveBeenNthCalledWith(1, "/api/private-agent/schedules/9/pause", { method: "POST" });
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/private-agent/schedules/9/resume", { method: "POST" });
    expect(apiMock).toHaveBeenNthCalledWith(3, "/api/private-agent/schedules/9/run-now", { method: "POST" });
    expect(apiMock).toHaveBeenNthCalledWith(4, "/api/private-agent/schedules/9", { method: "DELETE" });
  });
});
