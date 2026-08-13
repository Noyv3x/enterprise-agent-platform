// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { createStore } from "../../lib/store";
import { initialAppState, rootReducer } from "../../store/reducer";
import { StoreContext } from "../../store/StoreProvider";
import { TestUiProviders } from "../../test/TestUiProviders";

const actions = vi.hoisted(() => ({
  createDocument: vi.fn(async () => undefined),
  importKnowledgeDocuments: vi.fn(async () => ({ documents: [] })),
  loadDocuments: vi.fn(async () => undefined),
}));

vi.mock("../../data/knowledgeActions", () => actions);

import { KnowledgeCreateCard } from "./KnowledgeCreateCard";

describe("KnowledgeCreateCard", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("selects multiple supported files and sends one multipart import", async () => {
    const store = createStore(rootReducer, initialAppState);
    const onSaved = vi.fn();
    const { container } = render(
      <StoreContext.Provider value={store}>
        <TestUiProviders>
          <KnowledgeCreateCard onSaved={onSaved} />
        </TestUiProviders>
      </StoreContext.Provider>,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(container.querySelector(".knowledge-import__dropzone")).not.toBeNull();
    expect(container.querySelector(".knowledge-import__drop-icon")).not.toBeNull();
    expect(container.querySelector('[class^="ant-upload-"]')).toBeNull();
    const first = new File(["# One"], "one.md", { type: "text/markdown" });
    const second = new File(["Two"], "two.txt", { type: "text/plain" });
    fireEvent.change(input!, { target: { files: [first, second] } });

    await screen.findByText("2 files selected, 0.0 MiB total");
    fireEvent.click(screen.getByRole("button", { name: "Upload and import" }));

    await waitFor(() => expect(actions.importKnowledgeDocuments).toHaveBeenCalledTimes(1));
    expect(actions.importKnowledgeDocuments).toHaveBeenCalledWith(
      [first, second],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await waitFor(() => expect(actions.loadDocuments).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("retains manual structured entry as an alternate tab", async () => {
    const store = createStore(rootReducer, initialAppState);
    render(
      <StoreContext.Provider value={store}>
        <TestUiProviders><KnowledgeCreateCard /></TestUiProviders>
      </StoreContext.Provider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Manual entry" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Policy" } });
    fireEvent.change(screen.getByLabelText("Content"), { target: { value: "Shared policy" } });
    fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    await waitFor(() => expect(actions.createDocument).toHaveBeenCalledWith({
      title: "Policy",
      source: "",
      summary: "",
      content: "Shared policy",
    }));
  });
});
