import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "antd";
import { useI18n } from "../../i18n";
import { getApiSessionGeneration } from "../../lib/api";
import { useStore, useStoreHandle } from "../../store/useStore";
import type { AgentPreviewScope, ComputerMode, Message } from "../../types";
import { Glyph, LoadingState, OverlayPanel } from "../ui/fieldwork";
import { ChatPreviewContext } from "./ChatPreviewContext";
import { ComputerScreen } from "./ComputerScreen";
import { deriveComputerSurface, retainComputerSurface, type ComputerSurface } from "./computer";
import { usePreviewAvailability } from "./usePreviewAvailability";
import "./preview.css";

const MemoryPanel=lazy(() => import("../memory/MemoryPanel").then(module => ({default:module.MemoryPanel})));
const SkillsPanel=lazy(() => import("../skills/SkillsPanel").then(module => ({default:module.SkillsPanel})));
const ScheduledTasksPanel=lazy(() => import("../scheduled-tasks/ScheduledTasksPanel").then(module => ({default:module.ScheduledTasksPanel})));
const EMPTY_MESSAGES:Message[]=[];
type Capability="memory"|"skills"|"tasks"|"computer";

type SidebarProps = {scope:AgentPreviewScope|null;canManageSkills?:boolean;children:ReactNode};

export function ChatPreviewSidebar(props: SidebarProps) {
  const store = useStoreHandle();
  const account = useStore(value => `${getApiSessionGeneration()}:${value.user?.id ?? ""}`);
  const scope = props.scope ? `${props.scope.scope_type}:${props.scope.scope_id}` : "";
  const [owner,setOwner] = useState({store,account,scope,generation:0});
  if (owner.store !== store || owner.account !== account || owner.scope !== scope) {
    setOwner({store,account,scope,generation:owner.generation + 1});
  }
  // Remount resource consumers at the identity boundary, before old content can commit.
  return <ScopedChatPreviewSidebar key={owner.generation} {...props} />;
}

function ScopedChatPreviewSidebar({scope,canManageSkills=true,children}: SidebarProps) {
  const {t}=useI18n();
  const {state,refresh}=usePreviewAvailability(scope);
  const status=useStore(value => !scope ? null : scope.scope_type === "private" ? value.agentStatuses.private : value.agentStatuses.channels[String(scope.scope_id)] || null);
  const messages=useStore(value => !scope ? EMPTY_MESSAGES : scope.scope_type === "private" ? value.privateMessages : value.messages);
  const currentSurface=useMemo(() => deriveComputerSurface({status,messages,availability:state}),[status,messages,state]);
  const scopeKey=scope ? `${scope.scope_type}:${scope.scope_id}` : "";
  const [selection,setSelection]=useState<{scope:string;kind:Capability}|null>(null);
  const [intent,setIntent]=useState<{scope:string;request:number;pending:boolean}|null>(null);
  const [work,setWork]=useState<{
    status: typeof status;
    live: boolean;
    observed: ComputerSurface | null;
    runIds: string[];
    dismissed: boolean;
  }>(() => ({status:null,live:false,observed:null,runIds:[],dismissed:false}));
  // A platform task ID is provisional until the runtime assigns its canonical run ID.
  // Adoption is not new work; queued/idle -> live and distinct identified runs are.
  if (work.status !== status) {
    const runId=currentSurface.runId;
    const previousId=work.observed?.runId || "";
    const identifiedNewRun=Boolean(runId && previousId && runId !== previousId
      && !work.runIds.includes(runId) && !(previousId.startsWith(`${scopeKey}:`) && !runId.startsWith(`${scopeKey}:`)));
    const newWork=currentSurface.live && (!work.live || identifiedNewRun);
    const runIds=newWork ? runId ? [runId] : []
      : runId && currentSurface.live && !work.runIds.includes(runId) ? [...work.runIds,runId] : work.runIds;
    const observedSurface=!newWork && !currentSurface.mode && work.observed ? work.observed : currentSurface;
    setWork({
      status,
      live:currentSurface.live,
      observed:currentSurface.live ? {...observedSurface,runId:runId || (newWork ? "" : previousId)} : work.observed,
      runIds,
      dismissed:newWork ? false : work.dismissed,
    });
  }
  const surface=useMemo(() => currentSurface.live ? currentSurface
    : work.observed ? retainComputerSurface(work.observed,work.runIds,messages,state) : currentSurface,
  [currentSurface,work.observed,work.runIds,messages,state]);
  const sequence=useRef(0);
  const opener=useRef<HTMLElement|null>(null);
  const computerCloseIcon = useRef<HTMLSpanElement|null>(null);
  const computerPane=useRef<HTMLElement|null>(null);
  const focusFrame=useRef<number|null>(null);
  const intentCurrent=intent?.scope === scopeKey;
  const pending=Boolean(intentCurrent && intent?.pending);
  const computerActive=Boolean(scope && (surface.visible || pending));
  const privateScope=scope?.scope_type === "private";
  const selected=selection?.scope === scopeKey ? selection.kind : null;
  const visible=selected === "computer" ? computerActive ? selected : null : selected === "skills" ? scope ? selected : null : privateScope ? selected : null;
  const mode:ComputerMode|null=pending ? surface.mode || "browser" : surface.mode;
  const screenSurface=useMemo(() => {
    const visibleSurface=pending ? {...surface,visible:true,mode,unavailable:false} : surface;
    const presentFailed = ["failed", "error", "cancelled"].includes(String(visibleSurface.present?.status || "").trim().toLowerCase());
    if (visibleSurface.live && mode === "present" && !state.presentAvailable && !presentFailed) return {...visibleSurface,present:{...visibleSurface.present,status:"running"}};
    return visibleSurface;
  },[surface,pending,mode,state.presentAvailable]);
  useEffect(() => {
    if (!pending) return;
    const request = intent?.request;
    const timer = window.setTimeout(() => {
      setIntent(current => current?.scope === scopeKey && current.request === request ? null : current);
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [pending, intent?.request, scopeKey]);
  const restoreFocus=useCallback(() => {
    const target=opener.current;
    opener.current=null;
    if (focusFrame.current != null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current=requestAnimationFrame(() => {
      focusFrame.current=null;
      const valid=target?.isConnected && !target.matches(":disabled") && !target.closest("[hidden], [inert], [aria-hidden='true']");
      (valid ? target : document.querySelector<HTMLElement>("[data-composer-input]"))?.focus({preventScroll:true});
    });
  },[]);
  const close=useCallback(() => {
    setSelection(null);
    setIntent(null);
    restoreFocus();
  },[restoreFocus]);
  useEffect(() => {
    setSelection(null);
    setIntent(null);
    sequence.current=0;
    opener.current=null;
    return () => {
      if (focusFrame.current != null) cancelAnimationFrame(focusFrame.current);
    };
  },[scopeKey]);
  useLayoutEffect(() => {
    if (visible === "computer" && !computerPane.current?.contains(document.activeElement)) {
      computerCloseIcon.current?.closest<HTMLButtonElement>("button")?.focus({preventScroll:true});
    }
  },[visible,scopeKey]);
  useEffect(() => {if (intentCurrent && state.browserActive) setIntent(value => value ? {...value,pending:false} : null);},[intentCurrent,state.browserActive]);
  useEffect(() => {if (selected && !visible) close();},[selected,visible,close]);
  const open=useCallback((kind:Capability,trigger?:HTMLElement|null) => {
    if (focusFrame.current != null) cancelAnimationFrame(focusFrame.current);
    opener.current=trigger || null;
    setSelection({scope:scopeKey,kind});
    setIntent(null);
  },[scopeKey]);
  const openComputer=useCallback((_mode?:ComputerMode,trigger?:HTMLElement|null) => open("computer",trigger),[open]);
  const openBrowserAssist=useCallback((trigger?:HTMLElement|null) => {open("computer",trigger);setIntent({scope:scopeKey,request:++sequence.current,pending:true});},[scopeKey,open]);
  const dismissComputerPip=useCallback(() => {
    setWork(current => ({...current,dismissed:true}));
    document.querySelector<HTMLElement>("[data-composer-input]")?.focus({preventScroll:true});
  },[]);
  const capabilityActions = useMemo(() => scope ? (
    <>
      {computerActive ? <Button aria-label={t("computer.show")} aria-expanded={visible === "computer"} onClick={event => openComputer(undefined,event.currentTarget)}>{t("computer.title")}</Button> : null}
      {privateScope ? <Button aria-label={t("memory.open")} aria-expanded={visible === "memory"} onClick={event => open("memory",event.currentTarget)}>{t("memory.title")}</Button> : null}
      <Button aria-label={t("skills.open")} aria-expanded={visible === "skills"} onClick={event => open("skills",event.currentTarget)}>{t("skills.title")}</Button>
      {privateScope ? <Button aria-label={t("scheduledTasks.open")} aria-expanded={visible === "tasks"} onClick={event => open("tasks",event.currentTarget)}>{t("scheduledTasks.title")}</Button> : null}
    </>
  ) : null, [scope, t, computerActive, visible, openComputer, privateScope, open]);
  const computerPipDismissed=!work.observed || work.dismissed;
  const context=useMemo(() => ({scope,capabilityActions,browserDrawerOpen:visible === "computer" && mode === "browser",computerDrawerOpen:visible === "computer",computerMode:mode,computerSurface:screenSurface,openComputer,openBrowserAssist,computerPipDismissed,dismissComputerPip}),[scope,capabilityActions,visible,mode,screenSurface,openComputer,openBrowserAssist,computerPipDismissed,dismissComputerPip]);
  const title=visible === "memory" ? t("memory.title") : visible === "skills" ? t("skills.title") : visible === "tasks" ? t("scheduledTasks.title") : t("computer.title");
  const computerScreen=visible === "computer" && scope ? <ComputerScreen key={scopeKey} scope={scope} surface={screenSurface} availabilityError={state.error} onRetryAvailability={refresh} browserControlRequestId={intentCurrent ? intent?.request : undefined} /> : null;
  const minimizeAction=<Button type="text" aria-label={t("computer.minimize")} title={t("computer.minimize")} onClick={close} icon={<span ref={computerCloseIcon}><Glyph name="close" /></span>} />;
  return <ChatPreviewContext.Provider value={context}>
    <div className={`wf-chat-capabilities${computerScreen ? " wf-chat-capabilities--computer" : ""}`}>
      <div className="wf-chat-capability-content">{children}</div>
      {computerScreen ? <aside ref={computerPane} className="wf-computer-dock" aria-label={t("computer.title")} onKeyDown={event => {
        if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}>
        <header className="wf-computer-dock-header"><h2>{t("computer.title")}</h2>{minimizeAction}</header>
        <div className="wf-computer-dock-body">{computerScreen}</div>
      </aside> : null}
    </div>
    <OverlayPanel open={Boolean(visible && visible !== "computer")} onClose={close} title={title} size="wide" closeLabel={t("preview.close")}>
      <Suspense fallback={<LoadingState label={t("computer.loading")} />}>
        {visible === "memory" ? <MemoryPanel key={scopeKey} /> : visible === "skills" && scope ? <SkillsPanel key={scopeKey} scope={scope} canManage={canManageSkills} /> : visible === "tasks" ? <ScheduledTasksPanel key={scopeKey} /> : null}
      </Suspense>
    </OverlayPanel>
  </ChatPreviewContext.Provider>;
}
