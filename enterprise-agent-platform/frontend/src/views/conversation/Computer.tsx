import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { request } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { StatusPill } from "../../components/ui/beautiful/atoms/StatusPill";
import { EmptyState, Icon, Notice, Select, StepScrubber, TextField } from "../../components/ui/beautiful/controls";
import AgentScreen, { Ico, controlIcon, type WindowTab } from "../../components/ui/beautiful/primitives/AgentScreen";
import GlideMenu from "../../components/ui/beautiful/primitives/GlideMenu";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import { useWords } from "../../words";
import { formatBytes } from "./Attachments";
import { StepContent, stepChrome } from "./ActivityScreen";
import { followedRun, runCalls, stepKind, stepTitle, type RunSteps } from "./computerView";
import { BackgroundTasks } from "./Tasks";
import type { BrowserLease, BrowserTab, LastRun, LiveRun, Message, StepRef, ToolCall, WorkspaceFile } from "./types";
import { errorText } from "./useConversation";

const STATE_POLL_MS = 3000;
const FRAME_DELAY_MS = 1200;
const LEASE_RENEW_MS = 30_000;

/** The agent browser: tabs and lease state, the screenshot frame loop, and takeover with one holder identity per
 * mounted panel (the Platform lease is keyed by it; unmounting hands the browser back). */
function useAgentBrowser() {
  const holderId = useRef(crypto.randomUUID());
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [lease, setLease] = useState<BrowserLease | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [heldSince, setHeldSince] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [frame, setFrame] = useState(0);
  const frameTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(frameTimer.current), []);
  // Tabs seen so far: a tab opened later is shown as soon as it appears (the window follows the AI).
  const known = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await request<{ tabs: BrowserTab[]; lease: BrowserLease | null }>("/api/browser");
      const opened = known.current ? state.tabs.filter((tab) => !known.current?.has(tab.tabId)) : [];
      known.current = new Set(state.tabs.map((tab) => tab.tabId));
      setTabs(state.tabs);
      setLease(state.lease);
      if (!state.lease) setHolding(false);
      setSelected((current) => opened.length ? opened[opened.length - 1].tabId
        : current && state.tabs.some((tab) => tab.tabId === current) ? current : state.tabs[state.tabs.length - 1]?.tabId ?? null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), STATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const leaseBody = JSON.stringify({ holder_id: holderId.current });
  useEffect(() => {
    if (!holding) return;
    const timer = window.setInterval(() => {
      request("/api/browser/lease", { method: "POST", body: leaseBody }).catch((reason: unknown) => {
        setHolding(false);
        setError(errorText(reason));
      });
    }, LEASE_RENEW_MS);
    return () => window.clearInterval(timer);
  }, [holding, leaseBody]);

  const holdingRef = useRef(holding);
  holdingRef.current = holding;
  useEffect(() => () => {
    // Leaving the panel hands the browser back to the agent.
    if (holdingRef.current) void request("/api/browser/lease", { method: "DELETE", body: leaseBody }).catch(() => undefined);
  }, [leaseBody]);

  /** Resolves true once this panel holds the browser. */
  const acquire = async (): Promise<boolean> => {
    setPending(true);
    setError("");
    try {
      const result = await request<{ lease: BrowserLease }>("/api/browser/lease", { method: "POST", body: leaseBody });
      setLease(result.lease);
      setHolding(true);
      setHeldSince(Date.now());
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setPending(false);
    }
  };

  /** Resolves true once the browser is handed back. */
  const release = async (): Promise<boolean> => {
    setPending(true);
    setError("");
    try {
      await request("/api/browser/lease", { method: "DELETE", body: leaseBody });
      setHolding(false);
      setHeldSince(null);
      setLease(null);
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setPending(false);
    }
  };

  const act = async (action: string, args: Record<string, unknown>) => {
    setError("");
    try {
      const result = await request<{ content: string; is_error: boolean }>("/api/browser/action", {
        method: "POST",
        body: JSON.stringify({ holder_id: holderId.current, action, arguments: args }),
      });
      if (result.is_error) setError(result.content);
      if (action === "new_tab") void refresh();
      setFrame((value) => value + 1);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const click = (event: MouseEvent<HTMLImageElement>) => {
    if (!holding || !selected) return;
    const image = event.currentTarget;
    const box = image.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // The screenshot is the viewport at natural size; scale the click back to page pixels.
    const x = Math.round(((event.clientX - box.left) * image.naturalWidth) / box.width);
    const y = Math.round(((event.clientY - box.top) * image.naturalHeight) / box.height);
    void act("click", { tab_id: selected, x, y });
  };

  // The next frame is requested only after this one settles, so a slow browser never queues requests.
  const nextFrame = (delay: number) => {
    window.clearTimeout(frameTimer.current);
    frameTimer.current = window.setTimeout(() => setFrame((value) => value + 1), delay);
  };

  const tab = tabs.find((item) => item.tabId === selected) ?? null;
  return {
    tabs, tab, setSelected, loaded, holding, heldSince, pending, error, acquire, release, act, click, nextFrame,
    controlledElsewhere: lease !== null && !holding,
    src: tab ? `/api/browser/screenshot?tab_id=${encodeURIComponent(tab.tabId)}&frame=${frame}` : null,
  };
}

/** The expanded viewer's row: browser errors, the tab to watch (no takeover needed), and while a person holds the
 * browser the address, typing, key and scroll controls; then the playback bar. */
function ViewerInputs({ tabs, tab, onSelectTab, holding, error, act, playback }: {
  /** choosable tabs; empty when the window is not showing the live browser */
  tabs: BrowserTab[];
  tab: BrowserTab | null;
  onSelectTab: (tabId: string) => void;
  holding: boolean;
  error: string;
  act: (action: string, args: Record<string, unknown>) => Promise<void>;
  playback: ReactNode;
}) {
  const w = useWords();
  const [address, setAddress] = useState("");
  const [typed, setTyped] = useState("");
  return (
    <div className="flex flex-col gap-2 px-1.5 pb-1">
      {error && <p role="alert" className="text-[12.5px] text-red-ink">{error}</p>}
      {(tabs.length > 1 || holding) && (
        <div className="flex flex-wrap items-center gap-2">
          {tabs.length > 1 && (
            <Select
              aria-label={w("Tab", "标签页", "分頁")}
              size="sm"
              className="w-44"
              value={tab?.tabId ?? ""}
              onChange={(value: string) => onSelectTab(value)}
              options={tabs.map((item) => ({ value: item.tabId, label: item.title || item.url }))}
            />
          )}
          {holding && <form className="flex min-w-[240px] flex-1 items-center gap-1.5" onSubmit={(event) => {
            event.preventDefault();
            if (!address.trim()) return;
            void act(tab ? "navigate" : "new_tab", tab ? { tab_id: tab.tabId, url: address.trim() } : { url: address.trim() });
          }}>
            <TextField size="sm" className="flex-1" aria-label={w("Address", "网址", "網址")} placeholder="https://" value={address} onChange={(event) => setAddress(event.target.value)} />
            <Button type="submit" variant="secondary" size="sm" className="touch:h-11">{w("Open", "打开", "開啟")}</Button>
          </form>}
        </div>
      )}
      {holding && tab && (
        <form className="flex flex-wrap items-center gap-1.5" onSubmit={(event) => {
          event.preventDefault();
          if (!typed) return;
          // No element ref is known to a human; keyboard mode types into whatever the last click focused.
          void act("type", { tab_id: tab.tabId, text: typed, mode: "keyboard" }).then(() => setTyped(""));
        }}>
          <TextField size="sm" className="min-w-[200px] flex-1" aria-label={w("Text to type", "要输入的文字", "要輸入的文字")} placeholder={w("Click a field on the screen, then type here", "先点击画面中的输入框，再在此输入", "先點擊畫面中的輸入框，再在此輸入")} value={typed} onChange={(event) => setTyped(event.target.value)} />
          <Button type="submit" variant="secondary" size="sm" className="touch:h-11">{w("Type", "输入", "輸入")}</Button>
          <Button type="button" variant="quiet" size="sm" className="touch:h-11" onClick={() => void act("press", { tab_id: tab.tabId, key: "Enter" })}>Enter</Button>
          <Button type="button" variant="quiet" size="sm" className="touch:h-11" onClick={() => void act("scroll", { tab_id: tab.tabId, direction: "up", amount: 500 })}>{w("Scroll up", "向上滚动", "向上捲動")}</Button>
          <Button type="button" variant="quiet" size="sm" className="touch:h-11" onClick={() => void act("scroll", { tab_id: tab.tabId, direction: "down", amount: 500 })}>{w("Scroll down", "向下滚动", "向下捲動")}</Button>
        </form>
      )}
      {playback}
    </div>
  );
}

const folderIcon = <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />;
const fileIcon = <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>;
const ROW = "relative z-10 flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-[8px] px-1.5 py-1.5 text-left text-[13px] text-ink touch:min-h-11";

/** Workspace file list with folder navigation and authorized downloads. */
function WorkspaceFiles() {
  const w = useWords();
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    // A slow listing for a folder the user already left must not replace the current one.
    let current = true;
    setFiles(null);
    setError("");
    request<{ files: WorkspaceFile[] }>(`/api/workspace/files?path=${encodeURIComponent(path)}`)
      .then((result) => { if (current) setFiles(result.files); })
      .catch((reason: unknown) => { if (current) setError(errorText(reason)); });
    return () => { current = false; };
  }, [path, reload]);

  const parts = path ? path.split("/") : [];
  const crumb = "rounded-[6px] px-1 py-0.5 text-[12.5px] transition-colors duration-100 hover:bg-hover hover:text-ink touch:min-h-11";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center gap-1">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-ink-2" aria-label={w("Folder", "文件夹", "資料夾")}>
          <button type="button" className={`${crumb} font-semibold ${parts.length ? "text-ink-2" : "text-ink"}`} aria-current={parts.length ? undefined : "page"} onClick={() => setPath("")}>
            {w("Workspace", "工作区", "工作區")}
          </button>
          {parts.map((part, index) => (
            <span key={index} className="flex min-w-0 items-center gap-0.5">
              <span aria-hidden className="text-ink-3">/</span>
              <button type="button" className={`${crumb} truncate ${index === parts.length - 1 ? "text-ink" : ""}`} aria-current={index === parts.length - 1 ? "page" : undefined} onClick={() => setPath(parts.slice(0, index + 1).join("/"))}>{part}</button>
            </span>
          ))}
        </nav>
        <button type="button" aria-label={w("Refresh files", "刷新文件", "重新整理檔案")} title={w("Refresh files", "刷新文件", "重新整理檔案")} onClick={() => setReload((value) => value + 1)}
          className="primitive-icon-button shrink-0 text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink touch:size-11">
          <Ico size={14} path={<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />} />
        </button>
      </div>
      {error && !files ? (
        <Notice tone="danger" title={w("Files could not be listed", "无法列出文件", "無法列出檔案")}
          action={<Button variant="secondary" size="sm" onClick={() => setReload((value) => value + 1)}>{w("Retry", "重试", "重試")}</Button>}>
          {error}
        </Notice>
      ) : files === null ? (
        <LoadingState variant="Dots" label={w("Loading files", "正在加载文件", "正在載入檔案")} className="py-2" />
      ) : files.length === 0 ? (
        <EmptyState icon={<Ico size={15} sw={1.8} path={folderIcon} />} title={w("This folder is empty", "此文件夹为空", "此資料夾為空")}
          description={w("Files the agent creates in its workspace appear here.", "智能体在工作区创建的文件会显示在这里。", "智慧體在工作區建立的檔案會顯示在這裡。")} />
      ) : (
        <GlideMenu className="-mx-1.5 flex flex-col" rowSelector="[data-menu-row]">
          <ul aria-label={w("Workspace files", "工作区文件", "工作區檔案")}>
            {files.map((file) => (
              <li key={file.path}>
                {file.is_dir ? (
                  <button type="button" data-menu-row className={ROW} onClick={() => setPath(file.path)} aria-label={`${w("Open folder", "打开文件夹", "開啟資料夾")} ${file.name}`}>
                    <span className="text-ink-3"><Ico size={15} sw={1.8} path={folderIcon} /></span>
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <span className="text-ink-3"><Ico size={13} path={<path d="M9 6l6 6-6 6" />} /></span>
                  </button>
                ) : (
                  <a data-menu-row className={ROW} href={`/api/workspace/download?path=${encodeURIComponent(file.path)}`} download={file.name}
                    aria-label={`${w("Download", "下载", "下載")} ${file.name}`}>
                    <span className="text-ink-3"><Ico size={15} sw={1.8} path={fileIcon} /></span>
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <span className="shrink-0 font-mono text-[11.5px] text-ink-2 tabular-nums">{formatBytes(file.size_bytes)}</span>
                    <span className="text-ink-3"><Icon name="download" size={14} /></span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        </GlideMenu>
      )}
    </div>
  );
}

/** The workspace file list behind a disclosure (collapsed by default, listed only once opened), in its own scroll. */
function FilesDisclosure() {
  const w = useWords();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex shrink-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 hover:text-ink touch:min-h-11"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }} aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
        {w("Workspace files", "工作区文件", "工作區檔案")}
      </button>
      {open && (
        <div id={id} className="-mx-1.5 mt-1 max-h-64 overflow-y-auto overscroll-contain px-1.5">
          <WorkspaceFiles />
        </div>
      )}
    </div>
  );
}

function running(call: ToolCall | null): boolean {
  return call?.status === "preparing" || call?.status === "running";
}

/** Previous/next, the step scrubber, the position, and Live or Back to live/latest. */
function PlaybackBar({ steps, index, onSeek, following, live, onBack, disabled }: {
  steps: readonly ToolCall[];
  index: number;
  onSeek: (index: number) => void;
  following: boolean;
  /** a run is live (labels Back to live instead of Back to latest) */
  live: boolean;
  onBack: () => void;
  disabled: boolean;
}) {
  const w = useWords();
  const count = steps.length;
  const stepping = !disabled && count > 1;
  const nav = "primitive-icon-button shrink-0 text-ink-2 transition-colors duration-100 enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-40 touch:size-11";
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1">
      <button type="button" aria-label={w("Previous step", "上一步", "上一步")} className={nav} disabled={!stepping || index <= 0} onClick={() => onSeek(index - 1)}>
        <Ico size={15} path={<path d="M15 18l-6-6 6-6" />} />
      </button>
      <button type="button" aria-label={w("Next step", "下一步", "下一步")} className={nav} disabled={!stepping || index >= count - 1} onClick={() => onSeek(index + 1)}>
        <Ico size={15} path={<path d="M9 6l6 6-6 6" />} />
      </button>
      <StepScrubber
        className="flex-1"
        count={count}
        value={index}
        onChange={onSeek}
        disabled={!stepping}
        label={w("Step", "步骤", "步驟")}
        valueText={(at) => {
          const title = stepTitle(steps[at], w);
          return w(`Step ${at + 1} of ${count}: ${title}`, `第 ${at + 1} 步，共 ${count} 步：${title}`, `第 ${at + 1} 步，共 ${count} 步：${title}`);
        }}
      />
      <span aria-hidden className="shrink-0 px-1 font-mono text-[12px] text-ink-2 tabular-nums">{count ? index + 1 : 0} / {count}</span>
      {following ? (
        live && <StatusPill tone="green" className="h-5.5 shrink-0 text-[12px]">{w("Live", "实时", "即時")}</StatusPill>
      ) : (
        <Button variant="secondary" size="sm" className="shrink-0 touch:h-11" disabled={disabled} onClick={onBack}>
          {live ? w("Back to live", "回到实时", "回到即時") : w("Back to latest step", "回到最新一步", "回到最新一步")}
        </Button>
      )}
    </div>
  );
}

/** A step chosen in the conversation ("View in computer"); `n` grows with every request. */
export interface ComputerFocus {
  step: StepRef;
  n: number;
}

/** Personal AI computer panel body: one window following the AI step by step, its description and status, the
 * playback bar, browser takeover, the background tasks and the workspace files. Fills the height its container
 * gives it. */
export function ComputerBody({ live, lastRun, messages, focus }: {
  live: LiveRun | null;
  lastRun: LastRun | null;
  messages: readonly Message[];
  focus: ComputerFocus | null;
}) {
  const w = useWords();
  const browser = useAgentBrowser();
  const [open, setOpen] = useState(false);

  // Null follows the AI; a step reviews it and holds until Back to live.
  const [selection, setSelection] = useState<StepRef | null>(focus?.step ?? null);
  let reviewed = selection;
  const [focusSeen, setFocusSeen] = useState(focus?.n ?? 0);
  if (focus && focus.n !== focusSeen) {
    setFocusSeen(focus.n);
    reviewed = focus.step;
    setSelection(reviewed);
  }
  // A reviewed live run keeps resolving after it ends, by the reply message it became.
  const liveKey = live?.startedAt ?? null;
  const [seenLive, setSeenLive] = useState(liveKey);
  if (liveKey !== seenLive) {
    setSeenLive(liveKey);
    if (seenLive !== null && reviewed?.run === "live") {
      const callId = reviewed.callId;
      reviewed = lastRun?.calls.some((call) => call.id === callId) ? { run: lastRun.messageId, callId } : null;
      setSelection(reviewed);
    }
  }

  const followed = useMemo(() => followedRun(live, lastRun, messages), [live, lastRun, messages]);
  let shown: RunSteps | null = followed;
  let index = followed ? followed.calls.length - 1 : -1;
  if (reviewed) {
    const calls = runCalls(reviewed.run, live, lastRun, messages);
    const callId = reviewed.callId;
    const at = calls ? calls.findIndex((call) => call.id === callId) : -1;
    if (calls && at >= 0) {
      shown = { run: reviewed.run, calls, current: followed?.run === reviewed.run && followed.current };
      index = at;
    } else {
      // The step is gone (history reset or reloaded away): follow again.
      reviewed = null;
      setSelection(null);
    }
  }
  const following = reviewed === null;
  const { holding } = browser;
  const call = shown && index >= 0 ? shown.calls[index] : null;
  // The live browser: while a person holds it, when there is no step, or for the current run's newest browser step.
  const liveBrowser = holding || !call || (call.name === "browser" && !!shown?.current && index === shown.calls.length - 1);

  // Only state changes are announced; streamed text never is.
  const last = followed ? followed.calls[followed.calls.length - 1] : undefined;
  const previous = useRef<{ id: string; status: ToolCall["status"] } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const before = previous.current;
    if (last && before?.id === last.id && (before.status === "preparing" || before.status === "running") && (last.status === "done" || last.status === "error")) {
      const shell = stepKind(last.name) === "shell";
      setAnnouncement(last.status === "error" ? (shell ? w("Command failed", "命令失败", "命令失敗") : w("Step failed", "步骤失败", "步驟失敗"))
        : shell ? w("Command finished", "命令已完成", "命令已完成") : w("Step finished", "步骤已完成", "步驟已完成"));
    }
    previous.current = last ? { id: last.id, status: last.status } : null;
  }, [last, w]);

  const pill = "h-5.5 shrink-0 text-[12px]";
  const status = holding ? <StatusPill tone="red" className={pill}>{w("You're in control", "你正在控制", "你正在控制")}</StatusPill>
    : liveBrowser && browser.controlledElsewhere ? <StatusPill tone="orange" className={pill}>{w("Someone else is in control", "他人正在控制", "他人正在控制")}</StatusPill>
      : running(call) ? <StatusPill tone="accent" className={pill}>{w("Working", "工作中", "工作中")}</StatusPill>
        : following && live ? <StatusPill tone="accent" className={pill}>{w("Thinking", "思考中", "思考中")}</StatusPill>
          : call?.status === "error" ? <StatusPill tone="red" className={pill}>{w("Failed", "失败", "失敗")}</StatusPill>
            : call?.status === "cancelled" ? <StatusPill className={pill}>{w("Stopped", "已停止", "已停止")}</StatusPill>
              : call ? <StatusPill tone="green" className={pill}>{w("Done", "已完成", "已完成")}</StatusPill>
                : <StatusPill className={pill}>{w("Idle", "空闲", "閒置")}</StatusPill>;

  const { tab } = browser;
  const browserName = tab?.title || tab?.url || w("Browser", "浏览器", "瀏覽器");
  const name = holding || !call ? browserName : stepTitle(call, w);
  // The step rendered in the window (null: the live browser).
  const step = liveBrowser || !call || !shown ? null : { calls: shown.calls, call };
  let tabs: WindowTab[];
  let address: string | null;
  if (step) {
    const chrome = stepChrome(step.call, w);
    tabs = [{ id: step.call.id, label: chrome.tab }];
    address = chrome.address;
  } else {
    tabs = browser.tabs.length ? browser.tabs.map((item) => ({ id: item.tabId, label: item.title || item.url })) : [{ id: "browser", label: w("Browser", "浏览器", "瀏覽器") }];
    address = tab?.url ?? null;
  }

  const seek = (at: number) => {
    const target = shown?.calls[at];
    if (shown && target) setSelection({ run: shown.run, callId: target.id });
  };
  const playback = (
    <PlaybackBar
      steps={shown?.calls ?? []}
      index={Math.max(0, index)}
      onSeek={seek}
      following={following}
      live={live !== null}
      onBack={() => setSelection(null)}
      disabled={holding}
    />
  );

  const takeControl = (
    <Button variant="secondary" size="sm" className="gap-1 pl-1.5 touch:h-11" disabled={browser.pending} onClick={() => void browser.acquire().then((held) => held && setOpen(true))}>
      <Ico size={15} path={controlIcon} />
      {w("Take control", "接管浏览器", "接管瀏覽器")}
    </Button>
  );
  const handBack = (
    <button
      type="button"
      disabled={browser.pending}
      // Handing back resumes following.
      onClick={() => void browser.release().then((released) => released && setSelection(null))}
      className="inline-flex h-[27px] items-center gap-1.5 rounded-full bg-red pl-2.5 pr-3 text-[13px] font-medium leading-none text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] transition-[transform,filter] duration-150 ease-out hover:brightness-95 active:scale-[0.96] disabled:opacity-50 touch:h-11"
    >
      <span className="size-2.5 rounded-[2px] bg-white" />
      {w("Hand back to agent", "交还给智能体", "交還給智慧體")}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <AgentScreen
        className="min-h-[300px] flex-1"
        agentName={name}
        status={status}
        tabs={tabs}
        activeTab={liveBrowser ? tab?.tabId : undefined}
        onTabChange={liveBrowser ? browser.setSelected : undefined}
        address={address}
        loading={liveBrowser && !browser.loaded}
        streamSrc={liveBrowser ? browser.src : null}
        screen={step ? <StepContent calls={step.calls} index={index} /> : undefined}
        viewerScreen={step ? <StepContent calls={step.calls} index={index} viewer /> : undefined}
        empty={w("No page is open. The browser appears here when the agent opens one; take control to open one yourself.", "没有打开的网页。智能体打开网页后会显示在这里；也可以接管后自己打开。", "沒有開啟的網頁。智慧體開啟網頁後會顯示在這裡；也可以接管後自行開啟。")}
        open={open}
        onOpenChange={setOpen}
        controlling={holding}
        controlSince={browser.heldSince}
        controls={holding ? handBack : takeControl}
        inputs={
          <ViewerInputs
            tabs={liveBrowser ? browser.tabs : []}
            tab={tab}
            onSelectTab={browser.setSelected}
            holding={holding}
            error={browser.error}
            act={browser.act}
            playback={playback}
          />
        }
        onScreenClick={browser.click}
        onFrameLoad={() => browser.nextFrame(FRAME_DELAY_MS)}
        onFrameError={() => browser.nextFrame(FRAME_DELAY_MS * 3)}
        labels={{
          open: w("Expand", "展开", "展開"),
          collapse: w("Collapse", "收起", "收起"),
          connecting: w("Connecting to the agent's browser", "正在连接智能体的浏览器", "正在連線智慧體的瀏覽器"),
          screen: tab ? `${w("Browser screen", "浏览器画面", "瀏覽器畫面")}: ${tab.title || tab.url}` : w("Browser screen", "浏览器画面", "瀏覽器畫面"),
          tabs: w("Browser tabs", "浏览器标签页", "瀏覽器分頁"),
          window: w("Computer screen", "电脑画面", "電腦畫面"),
        }}
      />
      {playback}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {holding ? handBack : takeControl}
        <span className="text-[12px] text-ink-2">
          {holding ? w("The agent waits until you hand control back.", "交还控制前，智能体会等待。", "交還控制前，智慧體會等待。")
            : w("Take control to sign in or finish a step yourself.", "需要登录或亲自操作时，可接管浏览器。", "需要登入或親自操作時，可接管瀏覽器。")}
        </span>
      </div>
      {browser.error && !open && <p role="alert" className="shrink-0 px-0.5 text-[12.5px] text-red-ink">{browser.error}</p>}
      <BackgroundTasks />
      <FilesDisclosure />
      <div role="status" className="sr-only">{announcement}</div>
    </div>
  );
}
