// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../../../i18n";
import { createStore } from "../../../lib/store";
import { initialAppState, rootReducer } from "../../../store/reducer";
import { StoreContext } from "../../../store/StoreProvider";
import { TestUiProviders } from "../../../test/TestUiProviders";

const actions = vi.hoisted(() => ({
  saveKnowledgeConfig: vi.fn(async () => undefined),
  reindexKnowledge: vi.fn(async () => undefined),
}));

vi.mock("../../../data/adminActions", () => actions);

import { KnowledgeEmbeddingConfig } from "./KnowledgeEmbeddingConfig";

function renderConfig({ configured = true }: { configured?: boolean } = {}) {
  const store = createStore(rootReducer, initialAppState);
  store.dispatch({
    type: "SET_KNOWLEDGE_CONFIG",
    payload: {
      config: {
        base_url: "https://embeddings.example.test/v1",
        model: "embed-current",
        dimensions: 1536,
        batch_size: 32,
        credential_configured: configured,
        credential_masked: configured ? "sk-••••89" : "",
      },
    },
  });
  store.dispatch({
    type: "SET_KNOWLEDGE_STATUS",
    payload: {
      state: configured ? "ready" : "disabled",
      active_generation_id: configured ? 7 : null,
      indexed_documents: configured ? 8 : 0,
      total_documents: 8,
      pending_documents: 0,
      failed_documents: 0,
    },
  });
  render(
    <StoreContext.Provider value={store}>
      <TestUiProviders><KnowledgeEmbeddingConfig /></TestUiProviders>
    </StoreContext.Provider>,
  );
  return store;
}

describe("KnowledgeEmbeddingConfig", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps the API key write-only and submits the narrow embedding contract", async () => {
    renderConfig();

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("8 / 8")).toBeInTheDocument();
    const apiKey = screen.getByLabelText("API key");
    expect(apiKey).toHaveValue("");
    expect(apiKey).toHaveAttribute("placeholder", "Keep unchanged");
    expect(screen.getByText(/Configured as sk-••••89/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Embedding model"), {
      target: { value: "embed-next" },
    });
    fireEvent.change(apiKey, { target: { value: "secret-next" } });
    const save = screen.getByRole("button", { name: "Verify and save" });
    expect(save).toBeEnabled();
    fireEvent.submit(save.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(actions.saveKnowledgeConfig).toHaveBeenCalledWith(
        expect.anything(),
        {
          base_url: "https://embeddings.example.test/v1",
          model: "embed-next",
          dimensions: 1536,
          batch_size: 32,
          api_key: "secret-next",
        },
      );
    });
  });

  it("requires configured credentials before offering a rebuild", () => {
    renderConfig({ configured: false });

    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("A valid API key is required to enable the knowledge base."))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rebuild index" })).toBeDisabled();
    const save = screen.getByRole("button", { name: "Verify and save" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "  new-key  " } });
    expect(save).toBeEnabled();
  });

  it("asks for confirmation before scheduling a full rebuild", async () => {
    const user = userEvent.setup();
    renderConfig();

    await user.click(screen.getByRole("button", { name: "Rebuild index" }));
    expect(screen.getByText("Rebuild the entire knowledge index?")).toBeInTheDocument();
    const confirms = screen.getAllByRole("button", { name: "Rebuild index" });
    await user.click(confirms[confirms.length - 1]);

    expect(actions.reindexKnowledge).toHaveBeenCalledWith(expect.anything());
  });
});
