import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import type { AgentPreviewScope } from "../../types";
import { Icon } from "../common/Icon";
import { Spinner } from "../common/Spinner";
import { BrowserPreviewView } from "./BrowserPreviewView";
import { TerminalPreviewView } from "./TerminalPreviewView";
import { usePreviewAvailability } from "./usePreviewAvailability";

const ScheduledTasksPanel = lazy(() =>
  import("../scheduled-tasks/ScheduledTasksPanel").then((module) => ({
    default: module.ScheduledTasksPanel,
  })),
);
const MemoryPanel = lazy(() =>
  import("../memory/MemoryPanel").then((module) => ({
    default: module.MemoryPanel,
  })),
);

type SidePanelKind = "memory" | "tasks" | "browser" | "terminal";

interface ChatPreviewSidebarProps {
  scope: AgentPreviewScope | null;
  children: ReactNode;
}

export function ChatPreviewSidebar({ scope, children }: ChatPreviewSidebarProps) {
  const { t } = useI18n();
  const { state } = usePreviewAvailability(scope);
  const [openPreview, setOpenPreview] = useState<SidePanelKind | null>(null);
  const memoryButton = useRef<HTMLButtonElement>(null);
  const tasksButton = useRef<HTMLButtonElement>(null);
  const browserButton = useRef<HTMLButtonElement>(null);
  const terminalButton = useRef<HTMLButtonElement>(null);
  const previousOpen = useRef<SidePanelKind | null>(null);
  const scopeKey = scope ? `${scope.scope_type}:${scope.scope_id}` : "";
  const browserActive = !!scope && state.browserActive;
  const terminalCount = scope ? state.runningTerminalCount : 0;
  const terminalActive = terminalCount > 0;
  const memoryActive = scope?.scope_type === "private";
  const tasksActive = scope?.scope_type === "private";
  const hasPreviews = memoryActive || tasksActive || browserActive || terminalActive;
  const visiblePreview = (
    (openPreview === "memory" && memoryActive)
    || (openPreview === "tasks" && tasksActive)
    || (openPreview === "browser" && browserActive)
    || (openPreview === "terminal" && terminalActive)
  ) ? openPreview : null;

  useEffect(() => {
    setOpenPreview(null);
  }, [scopeKey]);

  useEffect(() => {
    if (openPreview === "browser" && !browserActive) setOpenPreview(null);
    if (openPreview === "terminal" && !terminalActive) setOpenPreview(null);
    if (openPreview === "tasks" && !tasksActive) setOpenPreview(null);
    if (openPreview === "memory" && !memoryActive) setOpenPreview(null);
  }, [browserActive, memoryActive, openPreview, tasksActive, terminalActive]);

  useEffect(() => {
    const wasOpen = previousOpen.current;
    previousOpen.current = openPreview;
    if (!wasOpen || openPreview) return;
    const trigger = wasOpen === "memory"
      ? memoryButton.current
      : wasOpen === "tasks"
        ? tasksButton.current
        : wasOpen === "browser"
          ? browserButton.current
          : terminalButton.current;
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

  const drawerTitle = visiblePreview === "memory"
    ? t("memory.title")
    : visiblePreview === "tasks"
      ? t("scheduledTasks.title")
      : visiblePreview === "browser"
        ? t("browserPreview.title")
        : t("terminalPreview.title");
  const drawerDescription = visiblePreview === "memory"
    ? t("memory.description")
    : visiblePreview === "tasks"
      ? t("scheduledTasks.description")
      : visiblePreview === "browser"
        ? t("browserPreview.description")
        : t("terminalPreview.description");
  const drawerIcon = visiblePreview === "memory"
    ? "library"
    : visiblePreview === "tasks"
      ? "calendar"
      : visiblePreview === "browser"
        ? "browser"
        : "terminal";
  const drawer = useMemo(() => {
    if (!scope || !visiblePreview) return null;
    if (visiblePreview === "memory") {
      return (
        <Suspense
          fallback={(
            <div className="memory-loading" role="status">
              <Spinner size={20} />
              <span>{t("memory.loading")}</span>
            </div>
          )}
        >
          <MemoryPanel key={scopeKey} />
        </Suspense>
      );
    }
    if (visiblePreview === "tasks") {
      return (
        <Suspense
          fallback={(
            <div className="schedule-panel__loading" role="status">
              <Spinner size={20} />
              <span>{t("scheduledTasks.loading")}</span>
            </div>
          )}
        >
          <ScheduledTasksPanel />
        </Suspense>
      );
    }
    return visiblePreview === "browser" ? <BrowserPreviewView scope={scope} /> : <TerminalPreviewView scope={scope} />;
  }, [scope, t, visiblePreview]);

  return (
    <div className={cx("chat-workspace", visiblePreview && "has-preview")}>
      <div className="chat">{children}</div>
      {hasPreviews ? (
        <nav className="chat-preview__rail" aria-label={t("preview.sidebarLabel")}>
          {memoryActive ? (
            <button
              ref={memoryButton}
              className={cx("chat-preview__toggle", visiblePreview === "memory" && "is-active")}
              type="button"
              aria-label={t("memory.open")}
              aria-controls="chat-side-panel"
              aria-expanded={visiblePreview === "memory"}
              title={t("memory.open")}
              onClick={() => setOpenPreview((current) => current === "memory" ? null : "memory")}
            >
              <Icon name="library" size={19} />
            </button>
          ) : null}
          {tasksActive ? (
            <button
              ref={tasksButton}
              className={cx("chat-preview__toggle", visiblePreview === "tasks" && "is-active")}
              type="button"
              aria-label={t("scheduledTasks.open")}
              aria-controls="chat-side-panel"
              aria-expanded={visiblePreview === "tasks"}
              title={t("scheduledTasks.open")}
              onClick={() => setOpenPreview((current) => current === "tasks" ? null : "tasks")}
            >
              <Icon name="calendar" size={19} />
            </button>
          ) : null}
          {browserActive ? (
            <button
              ref={browserButton}
              className={cx("chat-preview__toggle", visiblePreview === "browser" && "is-active")}
              type="button"
              aria-label={t("preview.openBrowser")}
              aria-controls="chat-side-panel"
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
              aria-controls="chat-side-panel"
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
          id="chat-side-panel"
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
