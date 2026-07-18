import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import {
  approveAgentMemoryCandidate,
  clearAgentMemories,
  createAgentMemory,
  deleteAgentMemory,
  exportAgentMemories,
  loadAgentMemories,
  loadAgentMemoryCandidates,
  rejectAgentMemoryCandidate,
  updateAgentMemory,
} from "./memoryActions";

vi.mock("../lib/api", () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

describe("memory actions", () => {
  beforeEach(() => apiMock.mockReset().mockResolvedValue({}));

  it("loads a target-scoped, bounded, searchable memory list", async () => {
    const controller = new AbortController();
    await loadAgentMemories("user", " reply style ", controller.signal);

    expect(apiMock).toHaveBeenCalledWith(
      "/api/private-agent/memories?target=user&limit=500&q=reply+style",
      { signal: controller.signal },
    );
  });

  it("uses explicit methods and owner-scoped resources for memory mutations", async () => {
    const payload = { target: "memory" as const, content: "Run checks before merging.", tags: ["workflow"] };
    await createAgentMemory(payload);
    await updateAgentMemory(9, payload);
    await deleteAgentMemory(9);
    await clearAgentMemories("user");
    await exportAgentMemories();

    expect(apiMock).toHaveBeenNthCalledWith(1, "/api/private-agent/memories", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(apiMock).toHaveBeenNthCalledWith(2, "/api/private-agent/memories/9", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    expect(apiMock).toHaveBeenNthCalledWith(
      3,
      "/api/private-agent/memories/9",
      { method: "DELETE" },
    );
    expect(apiMock).toHaveBeenNthCalledWith(
      4,
      "/api/private-agent/memories?target=user",
      { method: "DELETE" },
    );
    expect(apiMock).toHaveBeenNthCalledWith(5, "/api/private-agent/memories/export");
  });

  it("loads and decides pending memory candidates", async () => {
    const controller = new AbortController();
    await loadAgentMemoryCandidates(controller.signal);
    await approveAgentMemoryCandidate(7);
    await rejectAgentMemoryCandidate(8);

    expect(apiMock).toHaveBeenNthCalledWith(
      1,
      "/api/private-agent/memory-candidates?status=pending&limit=200",
      { signal: controller.signal },
    );
    expect(apiMock).toHaveBeenNthCalledWith(
      2,
      "/api/private-agent/memory-candidates/7/approve",
      { method: "POST" },
    );
    expect(apiMock).toHaveBeenNthCalledWith(
      3,
      "/api/private-agent/memory-candidates/8/reject",
      { method: "POST" },
    );
  });
});
