import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Tooltip } from "antd";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import { useStore } from "../../store/useStore";
import type { AgentPreviewScope, ComputerMode, Message } from "../../types";
import { Icon } from "../common/Icon";
import { Spinner } from "../common/Spinner";
import { ChatPreviewContext } from "./ChatPreviewContext";
import { ComputerScreen } from "./ComputerScreen";
import { deriveComputerSurface, latestComputerStep } from "./computer";
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

type SidePanelKind = "memory" | "skills" | "tasks" | "computer";

const EMPTY_MESSAGES: Message[] = [];

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
  const { state, refresh } = usePreviewAvailability(scope);
  const status = useStore((storeState) => {
    if (!scope) return null;
    return scope.scope_type === "private"
      ? storeState.agentStatuses.private
      : storeState.agentStatuses.channels[String(scope.scope_id)] || null;
  });
  const messages = useStore((storeState) => {
    if (!scope) return EMPTY_MESSAGES;
    return scope.scope_type === "private" ? storeState.privateMessages : storeState.messages;
  });
  const computerSurface = useMemo(
    () => deriveComputerSurface({ status, messages, availability: state }),
    [messages, state, status],
  );
  const [openPreview, setOpenPreview] = useState<SidePanelKind | null>(null);
  const [browserIntentPending, setBrowserIntentPending] = useState(false);
  const [browserControlRequestId, setBrowserControlRequestId] = useState(0);
  const [browserIntentScopeKey, setBrowserIntentScopeKey] = useState("");
  const memoryButton = useRef<HTMLButtonElement>(null);
  const skillsButton = useRef<HTMLButtonElement>(null);
  const tasksButton = useRef<HTMLButtonElement>(null);
  const computerButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousOpen = useRef<SidePanelKind | null>(null);
  const browserControlSequence = useRef(0);
  const fullWidthPreview = useMediaQuery("(max-width: 520px)");
  const scopeKey = scope ? `${scope.scope_type}:${scope.scope_id}` : "";
  const browserIntentCurrent = Boolean(scopeKey) && browserIntentScopeKey === scopeKey;
  const browserIntentVisible = browserIntentCurrent && browserIntentPending;
  const currentBrowserControlRequestId = browserIntentCurrent
    ? browserControlRequestId
    : 0;
  const computerActive = Boolean(scope) && (
    computerSurface.visible
    || browserIntentVisible
    || (state.loading && Boolean(latestComputerStep(status) || status?.computer))
  );
  const memoryActive = scope?.scope_type === "private";
  const skillsActive = !!scope;
  const tasksActive = scope?.scope_type === "private";
  const hasPreviews = memoryActive || skillsActive || tasksActive || computerActive;
  const visiblePreview = (
    (openPreview === "memory" && memoryActive)
    || (openPreview === "skills" && skillsActive)
    || (openPreview === "tasks" && tasksActive)
    || (openPreview === "computer" && computerActive)
  ) ? openPreview : null;
  const mobilePreviewOpen = fullWidthPreview && visiblePreview !== null;
  const computerMode: ComputerMode | null = browserIntentVisible
    ? (computerSurface.mode || "browser")
    : computerSurface.mode;
  const screenSurface = useMemo(
    () => (browserIntentVisible
      ? { ...computerSurface, visible: true, mode: computerMode }
      : computerSurface),
    [browserIntentVisible, computerMode, computerSurface],
  );
  const latestTerminal = latestComputerStep(status);

  useEffect(() => {
    setOpenPreview(null);
    setBrowserIntentPending(false);
    setBrowserControlRequestId(0);
    setBrowserIntentScopeKey("");
    browserControlSequence.current = 0;
  }, [scopeKey]);

  useEffect(() => {
    if (openPreview === "computer" && !computerActive) {
      setOpenPreview(null);
      setBrowserControlRequestId(0);
      setBrowserIntentScopeKey("");
    }
    if (openPreview === "tasks" && !tasksActive) setOpenPreview(null);
    if (openPreview === "memory" && !memoryActive) setOpenPreview(null);
    if (openPreview === "skills" && !skillsActive) setOpenPreview(null);
  }, [computerActive, memoryActive, openPreview, skillsActive, tasksActive]);

  useEffect(() => {
    if (state.browserActive && browserIntentPending && browserIntentCurrent) {
      setBrowserIntentPending(false);
    }
  }, [browserIntentCurrent, browserIntentPending, state.browserActive]);

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
        : computerButton.current;
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      else document.querySelector<HTMLElement>(".composer textarea")?.focus();
    });
  }, [openPreview]);

  useEffect(() => {
    if (!mobilePreviewOpen) return;
    const frame = requestAnimationFrame(() => closeButton.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [mobilePreviewOpen, visiblePreview]);

  const closePreview = useCallback(() => {
    setOpenPreview(null);
    setBrowserIntentPending(false);
    setBrowserControlRequestId(0);
    setBrowserIntentScopeKey("");
  }, []);

  const openComputer = useCallback((mode?: ComputerMode) => {
    setOpenPreview("computer");
    if (mode !== "browser") {
      setBrowserIntentPending(false);
      setBrowserControlRequestId(0);
      setBrowserIntentScopeKey("");
    }
    void mode;
  }, []);

  const openBrowserAssist = useCallback(() => {
    const requestId = ++browserControlSequence.current;
    setBrowserIntentPending(true);
    setBrowserIntentScopeKey(scopeKey);
    setOpenPreview("computer");
    setBrowserControlRequestId(requestId);
  }, [scopeKey]);

  const togglePreview = useCallback((kind: SidePanelKind) => {
    setOpenPreview((current) => current === kind ? null : kind);
    setBrowserIntentPending(false);
    setBrowserControlRequestId(0);
    setBrowserIntentScopeKey("");
  }, []);

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
      : t("computer.title");
  const drawerDescription = visiblePreview === "memory"
    ? t("memory.description")
    : visiblePreview === "skills"
      ? t("skills.description")
    : visiblePreview === "tasks"
      ? t("scheduledTasks.description")
      : t("computer.description");
  const drawerIcon = visiblePreview === "memory"
    ? "library"
    : visiblePreview === "skills"
      ? "sparkles"
    : visiblePreview === "tasks"
      ? "calendar"
      : "computer";
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
    return (
      <ComputerScreen
        scope={scope}
        surface={screenSurface}
        availabilityError={state.error}
        onRetryAvailability={refresh}
        latestTerminalStep={latestTerminal}
        browserControlRequestId={currentBrowserControlRequestId || undefined}
      />
    );
  }, [
    canManageSkills,
    computerSurface,
    screenSurface,
    currentBrowserControlRequestId,
    latestTerminal,
    refresh,
    scope,
    scopeKey,
    state.error,
    t,
    visiblePreview,
  ]);

  const previewContext = useMemo(() => ({
    scope,
    browserDrawerOpen: visiblePreview === "computer" && computerMode === "browser",
    computerDrawerOpen: visiblePreview === "computer",
    computerMode,
    computerSurface,
    openComputer,
    openBrowserAssist,
  }), [
    computerMode,
    computerSurface,
    openBrowserAssist,
    openComputer,
    scope,
    visiblePreview,
  ]);

  return (
    <div className={cx("chat-workspace", visiblePreview && "has-preview")}>
      <ChatPreviewContext.Provider value={previewContext}>
        <div
          className="chat"
          inert={mobilePreviewOpen}
          aria-hidden={mobilePreviewOpen || undefined}
        >
          {children}
        </div>
      </ChatPreviewContext.Provider>
      {hasPreviews ? (
        <nav
          className="chat-preview__rail"
          aria-label={t("preview.sidebarLabel")}
          inert={mobilePreviewOpen}
          aria-hidden={mobilePreviewOpen || undefined}
        >
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
                onClick={() => togglePreview("memory")}
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
                onClick={() => togglePreview("skills")}
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
                onClick={() => togglePreview("tasks")}
              />
            </Tooltip>
          ) : null}
          {computerActive ? (
            <Tooltip title={t("computer.show")} placement="left">
              <Button
                ref={computerButton}
                className={cx("chat-preview__toggle", visiblePreview === "computer" && "is-active")}
                type="text"
                shape="circle"
                aria-label={t("computer.show")}
                aria-controls="chat-side-panel"
                aria-expanded={visiblePreview === "computer"}
                icon={(
                  <Badge className="chat-preview__live-badge" classNames={{ indicator: "chat-preview__live-indicator" }} dot={computerSurface.live || state.browserActive || state.runningTerminalCount > 0}>
                    <Icon name="computer" size={19} />
                  </Badge>
                )}
                onClick={() => togglePreview("computer")}
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
                ref={closeButton}
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
