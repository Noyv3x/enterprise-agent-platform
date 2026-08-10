// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../i18n";
import { StoreProvider } from "../../../store/StoreProvider";
import type { OAuthProvider } from "../../../types";
import { OAuthProviderCard } from "./OAuthProviderCard";

function renderProvider(provider: OAuthProvider) {
  return render(
    <StoreProvider>
      <I18nProvider>
        <OAuthProviderCard provider={provider} />
      </I18nProvider>
    </StoreProvider>,
  );
}

describe("OAuthProviderCard", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders an unknown future recommended model and the complete catalog count", () => {
    renderProvider({
      id: "openai-codex",
      configured: true,
      active: true,
      default_model: "gpt-future-test",
      models: ["gpt-existing-test", "gpt-future-test", "gpt-compact-test"],
    });

    expect(screen.getByText("Recommended model: gpt-future-test")).toBeInTheDocument();
    expect(screen.getByText("3 available models")).toBeInTheDocument();
  });

  it("does not present a runtime fallback as an account recommendation before OAuth is configured", () => {
    renderProvider({
      id: "openai-codex",
      configured: false,
      default_model: "gpt-future-test",
      models: ["gpt-future-test"],
    });

    expect(screen.getByText("Recommended model: Unavailable")).toBeInTheDocument();
    expect(screen.getByText("Available models: Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/gpt-future-test/)).not.toBeInTheDocument();
  });

  it("shows an empty configured catalog without inventing a recommendation", () => {
    renderProvider({
      id: "xai-oauth",
      configured: true,
      default_model: "stale-runtime-candidate",
      models: [],
    });

    expect(screen.getByText("Recommended model: Unavailable")).toBeInTheDocument();
    expect(screen.getByText("0 available models")).toBeInTheDocument();
    expect(screen.queryByText(/stale-runtime-candidate/)).not.toBeInTheDocument();
  });
});
