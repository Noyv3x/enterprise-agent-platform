import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Tooltip } from "antd";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import type { AgentPreviewScope } from "../../types";
import { Icon } from "../common/Icon";
import { Spinner } from "../common/Spinner";
import { BrowserPreviewView } from "./BrowserPreviewView";
import { TerminalPreviewView } from "./TerminalPreviewView";
import { usePreviewAvailability } from "./usePreviewAvailability";
import "./preview.css";

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
const SkillsPanel = lazy(() =>
  import("../skills/SkillsPanel").then((module) => ({
    default: module.SkillsPanel,
  })),
);

type SidePanelKind = "memory" | "skills" | "tasks" | "browser" | "terminal";

interface ChatPreviewSidebarProps {
  scope: AgentPreviewScope | null;
  canManageSkills?: boolean;
  children: ReactNode;
}

export function ChatPreviewSidebar({
  scope,
  canManageSkills = true,
  children,
}: ChatPreviewSidebarProps) {
  const { t } = useI18n();
  const { state } = usePreviewAvailability(scope);
  const [openPreview, setOpenPreview] = useState<SidePanelKind | null>(null);
  const memoryButton = useRef<HTMLButtonElement>(null);
  const skillsButton = useRef<HTMLButtonElement>(null);
  const tasksButton = useRef<HTMLButtonElement>(null);
  const browserButton = useRef<HTMLButtonElement>(null);
  const terminalButton = useRef<HTMLButtonElement>(null);
  const previousOpen = useRef<SidePanelKind | null>(null);
  const scopeKey = scope ? `${scope.scope_type}:${scope.scope_id}` : "";
  const browserActive = !!scope && state.browserActive;
  const terminalCount = scope ? state.runningTerminalCount : 0;
  const terminalActive = terminalCount > 0;
  const memoryActive = scope?.scope_type === "private";
  const skillsActive = !!scope;
  const tasksActive = scope?.scope_type === "private";
  const hasPreviews = memoryActive || skillsActive || tasksActive || browserActive || terminalActive;
  const visiblePreview = (
    (openPreview === "memory" && memoryActive)
    || (openPreview === "skills" && skillsActive)
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
    if (openPreview === "skills" && !skillsActive) setOpenPreview(null);
  }, [browserActive, memoryActive, openPreview, skillsActive, tasksActive, terminalActive]);

  useEffect(() => {
    const wasOpen = previousOpen.current;
    previousOpen.current = openPreview;
    if (!wasOpen || openPreview) return;
    const trigger = wasOpen === "memory"
      ? memoryButton.current
      : wasOpen === "skills"
        ? skillsButton.current
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
    : visiblePreview === "skills"
      ? t("skills.title")
    : visiblePreview === "tasks"
      ? t("scheduledTasks.title")
      : visiblePreview === "browser"
        ? t("browserPreview.title")
        : t("terminalPreview.title");
  const drawerDescription = visiblePreview === "memory"
    ? t("memory.description")
    : visiblePreview === "skills"
      ? t("skills.description")
    : visiblePreview === "tasks"
      ? t("scheduledTasks.description")
      : visiblePreview === "browser"
        ? t("browserPreview.description")
        : t("terminalPreview.description");
  const drawerIcon = visiblePreview === "memory"
    ? "library"
    : visiblePreview === "skills"
      ? "sparkles"
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
    if (visiblePreview === "skills") {
      return (
        <Suspense
          fallback={(
            <div className="skills-loading" role="status">
              <Spinner size={20} />
              <span>{t("skills.loading")}</span>
            </div>
          )}
        >
          <SkillsPanel
            key={scopeKey}
            scope={scope}
            canManage={canManageSkills}
          />
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
  }, [canManageSkills, scope, t, visiblePreview]);

  return (
    <div className={cx("chat-workspace", visiblePreview && "has-preview")}>
      <div className="chat">{children}</div>
      {hasPreviews ? (
        <nav className="chat-preview__rail" aria-label={t("preview.sidebarLabel")}>
          {memoryActive ? (
            <Tooltip title={t("memory.open")} placement="left">
              <Button
                ref={memoryButton}
                className={cx("chat-preview__toggle", visiblePreview === "memory" && "is-active")}
                type="text"
                shape="circle"
                aria-label={t("memory.open")}
                aria-controls="chat-side-panel"
                aria-expanded={visiblePreview === "memory"}
                icon={<Icon name="library" size={19} />}
                onClick={() => setOpenPreview((current) => current === "memory" ? null : "memory")}
              />
            </Tooltip>
          ) : null}
          {skillsActive ? (
            <Tooltip title={t("skills.open")} placement="left">
              <Button
                ref={skillsButton}
                className={cx("chat-preview__toggle", visiblePreview === "skills" && "is-active")}
                type="text"
                shape="circle"
                aria-label={t("skills.open")}
                aria-controls="chat-side-panel"
                aria-expanded={visiblePreview === "skills"}
                icon={<Icon name="sparkles" size={19} />}
                onClick={() => setOpenPreview((current) => current === "skills" ? null : "skills")}
              />
            </Tooltip>
          ) : null}
          {tasksActive ? (
            <Tooltip title={t("scheduledTasks.open")} placement="left">
              <Button
                ref={tasksButton}
                className={cx("chat-preview__toggle", visiblePreview === "tasks" && "is-active")}
                type="text"
                shape="circle"
                aria-label={t("scheduledTasks.open")}
                aria-controls="chat-side-panel"
                aria-expanded={visiblePreview === "tasks"}
                icon={<Icon name="calendar" size={19} />}
                onClick={() => setOpenPreview((current) => current === "tasks" ? null : "tasks")}
              />
            </Tooltip>
          ) : null}
          {browserActive ? (
            <Tooltip title={t("preview.openBrowser")} placement="left">
              <Button
                ref={browserButton}
                className={cx("chat-preview__toggle", visiblePreview === "browser" && "is-active")}
                type="text"
                shape="circle"
                aria-label={t("preview.openBrowser")}
                aria-controls="chat-side-panel"
                aria-expanded={visiblePreview === "browser"}
                icon={(
                  <Badge className="chat-preview__live-badge" classNames={{ indicator: "chat-preview__live-indicator" }} dot>
                    <Icon name="browser" size={19} />
                  </Badge>
                )}
                onClick={() => setOpenPreview((current) => current === "browser" ? null : "browser")}
              />
            </Tooltip>
          ) : null}
          {terminalActive ? (
            <Tooltip title={t("preview.openTerminals", { count: terminalCount })} placement="left">
              <Button
                ref={terminalButton}
                className={cx("chat-preview__toggle", visiblePreview === "terminal" && "is-active")}
                type="text"
                shape="circle"
                aria-label={t("preview.openTerminals", { count: terminalCount })}
                aria-controls="chat-side-panel"
                aria-expanded={visiblePreview === "terminal"}
                icon={(
                  <Badge
                    className="chat-preview__terminal-badge"
                    classNames={{ indicator: "chat-preview__terminal-indicator" }}
                    count={terminalCount}
                    size="small"
                  >
                    <Icon name="terminal" size={19} />
                  </Badge>
                )}
                onClick={() => setOpenPreview((current) => current === "terminal" ? null : "terminal")}
              />
            </Tooltip>
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
            <Tooltip title={t("preview.close")}>
              <Button
                className="chat-preview__close"
                type="text"
                shape="circle"
                aria-label={t("preview.close")}
                icon={<Icon name="close" />}
                onClick={closePreview}
              />
            </Tooltip>
          </header>
          <div className="chat-preview__body">{drawer}</div>
        </aside>
      ) : null}
    </div>
  );
}
