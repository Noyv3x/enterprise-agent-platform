import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { AgentPreviewScope, AgentSkillCreateRequest } from "../types";
import {
  createAgentSkill,
  deleteAgentSkill,
  loadAgentSkill,
  loadAgentSkills,
  updateAgentSkill,
} from "./skillActions";

vi.mock("../lib/api", () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);
const scope: AgentPreviewScope = { scope_type: "channel", scope_id: "12" };

describe("skill actions", () => {
  beforeEach(() => apiMock.mockReset().mockResolvedValue({}));

  it("loads a bounded, searchable list for the exact Agent scope", async () => {
    const controller = new AbortController();
    await loadAgentSkills(scope, " code review ", controller.signal);

    expect(apiMock).toHaveBeenCalledWith(
      "/api/agent-skills?scope_type=channel&scope_id=12&limit=200&q=code+review",
      { signal: controller.signal },
    );
  });

  it("loads one scoped Skill before editing", async () => {
    const controller = new AbortController();
    await loadAgentSkill(scope, "review-code", controller.signal);

    expect(apiMock).toHaveBeenCalledWith(
      "/api/agent-skills/review-code?scope_type=channel&scope_id=12",
      { signal: controller.signal },
    );
  });

  it("uses explicit methods and preserves scope on every mutation", async () => {
    const payload: AgentSkillCreateRequest = {
      name: "review-code",
      description: "Review code consistently.",
      instructions: "# Review\n\nRun the checks.",
      category: "development",
      version: "1.0.0",
      tags: ["review", "quality"],
      enabled: true,
    };

    await createAgentSkill(scope, payload);
    await updateAgentSkill(scope, "review-code", { ...payload, name: "review-changes" });
    await updateAgentSkill(scope, "review-code", { enabled: false });
    await deleteAgentSkill(scope, "review-code");

    expect(apiMock).toHaveBeenNthCalledWith(
      1,
      "/api/agent-skills?scope_type=channel&scope_id=12",
      { method: "POST", body: JSON.stringify(payload) },
    );
    expect(apiMock).toHaveBeenNthCalledWith(
      2,
      "/api/agent-skills/review-code?scope_type=channel&scope_id=12",
      {
        method: "PATCH",
        body: JSON.stringify({ ...payload, name: "review-changes" }),
      },
    );
    expect(apiMock).toHaveBeenNthCalledWith(
      3,
      "/api/agent-skills/review-code?scope_type=channel&scope_id=12",
      { method: "PATCH", body: JSON.stringify({ enabled: false }) },
    );
    expect(apiMock).toHaveBeenNthCalledWith(
      4,
      "/api/agent-skills/review-code?scope_type=channel&scope_id=12",
      { method: "DELETE" },
    );
  });
});
