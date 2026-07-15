import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import type { AgentPreviewScope } from "../../types";
import { Icon } from "../common/Icon";
import { BrowserPreviewView } from "./BrowserPreviewView";
import { TerminalPreviewView } from "./TerminalPreviewView";
import { usePreviewAvailability } from "./usePreviewAvailability";

type PreviewKind = "browser" | "terminal";

interface ChatPreviewSidebarProps {
  scope: AgentPreviewScope | null;
  children: ReactNode;
}

export function ChatPreviewSidebar({ scope, children }: ChatPreviewSidebarProps) {
  const { t } = useI18n();
  const { state } = usePreviewAvailability(scope);
  const [openPreview, setOpenPreview] = useState<PreviewKind | null>(null);
  const browserButton = useRef<HTMLButtonElement>(null);
  const terminalButton = useRef<HTMLButtonElement>(null);
  const previousOpen = useRef<PreviewKind | null>(null);
  const scopeKey = scope ? `${scope.scope_type}:${scope.scope_id}` : "";
  const browserActive = !!scope && state.browserActive;
  const terminalCount = scope ? state.runningTerminalCount : 0;
  const terminalActive = terminalCount > 0;
  const hasPreviews = browserActive || terminalActive;
  const visiblePreview = (
    (openPreview === "browser" && browserActive)
    || (openPreview === "terminal" && terminalActive)
  ) ? openPreview : null;

  useEffect(() => {
    setOpenPreview(null);
  }, [scopeKey]);

  useEffect(() => {
    if (openPreview === "browser" && !browserActive) setOpenPreview(null);
    if (openPreview === "terminal" && !terminalActive) setOpenPreview(null);
  }, [browserActive, openPreview, terminalActive]);

  useEffect(() => {
    const wasOpen = previousOpen.current;
    previousOpen.current = openPreview;
    if (!wasOpen || openPreview) return;
    const trigger = wasOpen === "browser" ? browserButton.current : terminalButton.current;
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      else document.querySelector<HTMLElement>(".composer textarea")?.focus();
    });
  }, [openPreview]);

  const closePreview = useCallback(() => setOpenPreview(null), []);

  useEffect(() => {
    if (!openPreview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePreview();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closePreview, openPreview]);

  const drawerTitle = visiblePreview === "browser"
    ? t("browserPreview.title")
    : t("terminalPreview.title");
  const drawerDescription = visiblePreview === "browser"
    ? t("browserPreview.description")
    : t("terminalPreview.description");
  const drawerIcon = visiblePreview === "browser" ? "browser" : "terminal";
  const drawer = useMemo(() => {
    if (!scope || !visiblePreview) return null;
    return visiblePreview === "browser"
      ? <BrowserPreviewView scope={scope} />
      : <TerminalPreviewView scope={scope} />;
  }, [scope, visiblePreview]);

  return (
    <div className={cx("chat-workspace", visiblePreview && "has-preview")}>
      <div className="chat">{children}</div>
      {hasPreviews ? (
        <nav className="chat-preview__rail" aria-label={t("preview.sidebarLabel")}>
          {browserActive ? (
            <button
              ref={browserButton}
              className={cx("chat-preview__toggle", visiblePreview === "browser" && "is-active")}
              type="button"
              aria-label={t("preview.openBrowser")}
              aria-controls="chat-preview-drawer"
              aria-expanded={visiblePreview === "browser"}
              title={t("preview.openBrowser")}
              onClick={() => setOpenPreview((current) => current === "browser" ? null : "browser")}
            >
              <Icon name="browser" size={19} />
              <span className="dot dot--pulse" aria-hidden="true" />
            </button>
          ) : null}
          {terminalActive ? (
            <button
              ref={terminalButton}
              className={cx("chat-preview__toggle", visiblePreview === "terminal" && "is-active")}
              type="button"
              aria-label={t("preview.openTerminals", { count: terminalCount })}
              aria-controls="chat-preview-drawer"
              aria-expanded={visiblePreview === "terminal"}
              title={t("preview.openTerminals", { count: terminalCount })}
              onClick={() => setOpenPreview((current) => current === "terminal" ? null : "terminal")}
            >
              <Icon name="terminal" size={19} />
              <span className="chat-preview__count" aria-hidden="true">{terminalCount}</span>
            </button>
          ) : null}
        </nav>
      ) : null}
      {visiblePreview && drawer ? (
        <aside
          className="chat-preview__drawer"
          id="chat-preview-drawer"
          aria-label={drawerTitle}
        >
          <header className="chat-preview__header">
            <div className="chat-preview__heading">
              <span className="chat-preview__heading-icon"><Icon name={drawerIcon} size={18} /></span>
              <span>
                <strong>{drawerTitle}</strong>
                <small>{drawerDescription}</small>
              </span>
            </div>
            <button
              className="icon-btn"
              type="button"
              aria-label={t("preview.close")}
              title={t("preview.close")}
              onClick={closePreview}
            >
              <Icon name="close" />
            </button>
          </header>
          <div className="chat-preview__body">{drawer}</div>
        </aside>
      ) : null}
    </div>
  );
}
