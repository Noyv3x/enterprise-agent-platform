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
