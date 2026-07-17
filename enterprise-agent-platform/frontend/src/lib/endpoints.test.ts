import { describe, expect, it } from "vitest";
import { endpoints } from "./endpoints";

describe("Telegram link challenge endpoint", () => {
  it("uses the same private-agent resource for create, read, and delete", () => {
    expect(endpoints.privateTelegram).toMatchObject({ method: "GET" });
    expect(endpoints.updatePrivateTelegram).toMatchObject({ method: "PUT" });
    expect(endpoints.deletePrivateTelegram).toMatchObject({ method: "DELETE" });
    expect(endpoints.privateTelegram.path()).toBe("/api/private-agent/telegram");
    expect(endpoints.updatePrivateTelegram.path()).toBe("/api/private-agent/telegram");
    expect(endpoints.deletePrivateTelegram.path()).toBe("/api/private-agent/telegram");
  });
});

describe("Agent runtime configuration endpoint", () => {
  it("uses the neutral runtime resource for reads and writes", () => {
    expect(endpoints.agentRuntimeConfig).toMatchObject({ method: "GET" });
    expect(endpoints.updateAgentRuntimeConfig).toMatchObject({ method: "PUT" });
    expect(endpoints.agentRuntimeConfig.path()).toBe("/api/system/agent-runtime/config");
    expect(endpoints.updateAgentRuntimeConfig.path()).toBe("/api/system/agent-runtime/config");
  });
});

describe("read-only Agent preview endpoints", () => {
  it("encodes scope and optional browser tab without exposing path fragments", () => {
    expect(endpoints.previewStatus.path("private", "user 7")).toBe(
      "/api/agent-previews/status?scope_type=private&scope_id=user+7",
    );
    expect(endpoints.browserPreview.path("private", "user 7", "tab/1")).toBe(
      "/api/agent-previews/browser?scope_type=private&scope_id=user+7&tab_id=tab%2F1",
    );
    expect(endpoints.terminalPreviews.path("channel", 4)).toBe(
      "/api/agent-previews/terminals?scope_type=channel&scope_id=4",
    );
  });
});

describe("private Agent schedule endpoints", () => {
  it("uses owner-scoped resources and bounded run-history queries", () => {
    expect(endpoints.privateSchedules.path()).toBe("/api/private-agent/schedules");
    expect(endpoints.privateSchedule.path(9)).toBe("/api/private-agent/schedules/9");
    expect(endpoints.privateScheduleRuns.path(9, 20)).toBe(
      "/api/private-agent/schedules/9/runs?limit=20",
    );
    expect(endpoints.privateScheduleRuns.path(9, 20, 31)).toBe(
      "/api/private-agent/schedules/9/runs?limit=20&before_id=31",
    );
    expect(endpoints.pausePrivateSchedule.path(9)).toBe("/api/private-agent/schedules/9/pause");
    expect(endpoints.resumePrivateSchedule.path(9)).toBe("/api/private-agent/schedules/9/resume");
    expect(endpoints.runPrivateScheduleNow.path(9)).toBe("/api/private-agent/schedules/9/run-now");
    expect(endpoints.deletePrivateSchedule.path(9)).toBe("/api/private-agent/schedules/9");
  });
});
