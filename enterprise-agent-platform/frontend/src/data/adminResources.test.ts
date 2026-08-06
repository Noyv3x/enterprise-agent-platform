import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPageId } from "../types";

const loads = vi.hoisted(() => ({
  updates: vi.fn(async () => undefined),
  agentRuntime: vi.fn(async () => undefined),
  branding: vi.fn(async () => undefined),
  knowledge: vi.fn(async () => undefined),
  messages: vi.fn(async () => undefined),
  oauth: vi.fn(async () => undefined),
  groups: vi.fn(async () => undefined),
  runtime: vi.fn(async () => undefined),
  secrets: vi.fn(async () => undefined),
  security: vi.fn(async () => undefined),
  telegram: vi.fn(async () => undefined),
  tokens: vi.fn(async () => undefined),
  users: vi.fn(async () => undefined),
}));

vi.mock("./loaders", () => ({
  loadAutoUpdateConfig: loads.updates,
  loadAgentRuntimeConfig: loads.agentRuntime,
  loadBrandingConfig: loads.branding,
  loadKnowledgeAdmin: loads.knowledge,
  loadMessageAudit: loads.messages,
  loadOAuthProviders: loads.oauth,
  loadPermissionGroups: loads.groups,
  loadRuntime: loads.runtime,
  loadSecrets: loads.secrets,
  loadSecurityConfig: loads.security,
  loadTelegramConfig: loads.telegram,
  loadTokenUsage: loads.tokens,
  loadUsers: loads.users,
}));

import { loadAdminPage } from "./adminResources";

const pages: AdminPageId[] = [
  "accounts", "tokens", "messages", "agent-runtime", "telegram", "branding", "updates",
  "security", "runtime", "knowledge", "secrets",
];

describe("administration page resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses one precise loader set for every page", async () => {
    const expected: Record<AdminPageId, string[]> = {
      accounts: ["users", "groups", "oauth", "agentRuntime"],
      tokens: ["tokens"],
      messages: ["messages"],
      "agent-runtime": ["agentRuntime", "oauth"],
      telegram: ["telegram"],
      branding: ["branding"],
      updates: ["updates"],
      security: ["security", "updates"],
      runtime: ["runtime"],
      knowledge: ["knowledge"],
      secrets: ["secrets"],
    };

    for (const page of pages) {
      vi.clearAllMocks();
      await loadAdminPage({} as never, page);
      const invoked = Object.entries(loads)
        .filter(([, loader]) => loader.mock.calls.length > 0)
        .map(([name]) => name)
        .sort();
      expect(invoked, page).toEqual([...expected[page]].sort());
    }
  });
});
