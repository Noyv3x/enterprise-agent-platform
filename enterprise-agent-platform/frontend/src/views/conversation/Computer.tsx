import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { request } from "../../api";
import { BuiIcon, Button } from "../../components/ui/beautiful";
import { BrowserControlBar, ComputerPanel, DataRegion, EmptyState, Glyph, ResourceList, ResourceRow, SectionIndex } from "../../components/ui/fieldwork";
import { useWords } from "../../words";
import { formatBytes } from "./Attachments";
import type { BrowserLease, BrowserTab, WorkspaceFile } from "./types";
import { errorText } from "./useConversation";

const STATE_POLL_MS = 3000;
const FRAME_DELAY_MS = 1200;
const LEASE_RENEW_MS = 30_000;

function BrowserView() {
  const w = useWords();
  // One takeover identity per mounted panel; the Platform lease is keyed by it.
  const holderId = useRef(crypto.randomUUID());
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [lease, setLease] = useState<BrowserLease | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [frame, setFrame] = useState(0);
  const [address, setAddress] = useState("");
  const [typed, setTyped] = useState("");

  const refresh = useCallback(async () => {
    try {
      const state = await request<{ tabs: BrowserTab[]; lease: BrowserLease | null }>("/api/browser");
      setTabs(state.tabs);
      setLease(state.lease);
      if (!state.lease) setHolding(false);
      setSelected((current) => (current && state.tabs.some((tab) => tab.tabId === current) ? current : state.tabs[state.tabs.length - 1]?.tabId ?? null));
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

  const acquire = async () => {
    setPending(true);
    setError("");
    try {
      const result = await request<{ lease: BrowserLease }>("/api/browser/lease", { method: "POST", body: leaseBody });
      setLease(result.lease);
      setHolding(true);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(false);
    }
  };

  const release = async () => {
    setPending(true);
    setError("");
    try {
      await request("/api/browser/lease", { method: "DELETE", body: leaseBody });
      setHolding(false);
      setLease(null);
    } catch (reason) {
      setError(errorText(reason));
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

  const tab = tabs.find((item) => item.tabId === selected) ?? null;
  const controlledElsewhere = lease !== null && !holding;
  return (
    <div className="cv-browser">
      <BrowserControlBar
        danger={controlledElsewhere}
        status={holding ? w("You are controlling the browser", "你正在控制浏览器", "你正在控制瀏覽器")
          : controlledElsewhere ? w("A person is controlling the browser", "有人正在控制浏览器", "有人正在控制瀏覽器")
            : w("The agent is using the browser", "浏览器由智能体使用", "瀏覽器由智慧體使用")}
        description={holding ? w("The agent waits until you hand control back.", "交还控制前，智能体会等待。", "交還控制前，智慧體會等待。")
          : w("Take control to sign in or finish a step yourself.", "需要登录或亲自操作时，可接管浏览器。", "需要登入或親自操作時，可接管瀏覽器。")}
        action={holding
          ? <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => void release()}>{w("Hand back to agent", "交还给智能体", "交還給智慧體")}</Button>
          : <Button type="button" variant="primary" size="sm" disabled={pending} onClick={() => void acquire()}>{w("Take control", "接管浏览器", "接管瀏覽器")}</Button>}
      />
      {error && <div className="cv-error-text cv-pad" role="alert">{error}</div>}
      {tabs.length > 1 && (
        <label className="cv-pad cv-field">
          <span className="wf-eyebrow">{w("Tab", "标签页", "分頁")}</span>
          <select className="cv-select" value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>
            {tabs.map((item) => <option key={item.tabId} value={item.tabId}>{item.title || item.url}</option>)}
          </select>
        </label>
      )}
      {holding && (
        <div className="cv-browser-inputs cv-pad">
          <form className="wf-field-row" onSubmit={(event) => {
            event.preventDefault();
            if (!address.trim()) return;
            void act(tab ? "navigate" : "new_tab", tab ? { tab_id: tab.tabId, url: address.trim() } : { url: address.trim() });
          }}>
            <input className="cv-text-input" aria-label={w("Address", "网址", "網址")} placeholder="https://" value={address} onChange={(event) => setAddress(event.target.value)} />
            <Button type="submit" variant="secondary" size="sm">{w("Open", "打开", "開啟")}</Button>
          </form>
          {tab && (
            <form className="wf-field-row" onSubmit={(event) => {
              event.preventDefault();
              if (!typed) return;
              // No element ref is known to a human; keyboard mode types into whatever the last click focused.
              void act("type", { tab_id: tab.tabId, text: typed, mode: "keyboard" }).then(() => setTyped(""));
            }}>
              <input className="cv-text-input" aria-label={w("Text to type", "要输入的文字", "要輸入的文字")} placeholder={w("Click a field, then type here", "先点击输入框，再在此输入", "先點擊輸入框，再在此輸入")} value={typed} onChange={(event) => setTyped(event.target.value)} />
              <Button type="submit" variant="secondary" size="sm">{w("Type", "输入", "輸入")}</Button>
              <Button type="button" variant="quiet" size="sm" onClick={() => void act("press", { tab_id: tab.tabId, key: "Enter" })}>Enter</Button>
              <Button type="button" variant="quiet" size="sm" onClick={() => void act("scroll", { tab_id: tab.tabId, direction: "up", amount: 500 })}>{w("Scroll up", "向上滚动", "向上捲動")}</Button>
              <Button type="button" variant="quiet" size="sm" onClick={() => void act("scroll", { tab_id: tab.tabId, direction: "down", amount: 500 })}>{w("Scroll down", "向下滚动", "向下捲動")}</Button>
            </form>
          )}
        </div>
      )}
      {tab ? (
        <div className="cv-screen" data-controlling={holding ? "" : undefined}>
          <img
            src={`/api/browser/screenshot?tab_id=${encodeURIComponent(tab.tabId)}&frame=${frame}`}
            alt={tab.title || tab.url}
            onClick={click}
            // The next frame is requested only after this one settles, so a slow browser never queues requests.
            onLoad={() => window.setTimeout(() => setFrame((value) => value + 1), FRAME_DELAY_MS)}
            onError={() => window.setTimeout(() => setFrame((value) => value + 1), FRAME_DELAY_MS * 3)}
          />
          <div className="cv-screen-meta wf-mono">{tab.url}</div>
        </div>
      ) : loaded ? (
        <EmptyState compact title={w("No page is open", "没有打开的网页", "沒有開啟的網頁")}
          description={w("The browser appears here when the agent opens a page, or take control and open one yourself.", "智能体打开网页后会显示在这里；也可以接管后自己打开。", "智慧體開啟網頁後會顯示在這裡；也可以接管後自行開啟。")} />
      ) : null}
    </div>
  );
}

function FilesView() {
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
  return (
    <div className="cv-files">
      <nav className="cv-crumbs" aria-label={w("Folder", "文件夹", "資料夾")}>
        <button type="button" className="cv-link-button" onClick={() => setPath("")}>{w("Workspace", "工作区", "工作區")}</button>
        {parts.map((part, index) => (
          <span key={index}>
            <span aria-hidden="true"> / </span>
            <button type="button" className="cv-link-button" aria-current={index === parts.length - 1 ? "page" : undefined} onClick={() => setPath(parts.slice(0, index + 1).join("/"))}>{part}</button>
          </span>
        ))}
        <Button type="button" variant="quiet" size="xs" className="cv-push" onClick={() => setReload((value) => value + 1)}>{w("Refresh", "刷新", "重新整理")}</Button>
      </nav>
      <DataRegion
        state={error && !files ? "error" : files === null ? "loading" : files.length ? "ready" : "empty"}
        loadingLabel={w("Loading files…", "正在加载文件…", "正在載入檔案…")}
        error={error || undefined}
        retry={<Button type="button" variant="secondary" size="sm" onClick={() => setReload((value) => value + 1)}>{w("Retry", "重试", "重試")}</Button>}
        empty={<EmptyState compact title={w("This folder is empty", "此文件夹为空", "此資料夾為空")} description={w("Files the agent creates in its workspace appear here.", "智能体在工作区创建的文件会显示在这里。", "智慧體在工作區建立的檔案會顯示在這裡。")} />}
      >
        <ResourceList label={w("Workspace files", "工作区文件", "工作區檔案")}>
          {(files ?? []).map((file) => file.is_dir ? (
            <ResourceRow key={file.path} leading={<BuiIcon size={14}><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></BuiIcon>} title={file.name} onSelect={() => setPath(file.path)} selectLabel={`${w("Open folder", "打开文件夹", "開啟資料夾")} ${file.name}`} />
          ) : (
            <ResourceRow key={file.path} leading={<Glyph name="file" size={14} />} title={file.name} meta={formatBytes(file.size_bytes)}
              actions={<a href={`/api/workspace/download?path=${encodeURIComponent(file.path)}`} download={file.name} aria-label={`${w("Download", "下载", "下載")} ${file.name}`}><Glyph name="download" size={16} /></a>} />
          ))}
        </ResourceList>
      </DataRegion>
    </div>
  );
}

/** Personal AI computer: live browser with human takeover, and the workspace file tree. */
export function Computer({ onClose }: { onClose: () => void }) {
  const w = useWords();
  const [view, setView] = useState<"browser" | "files">("browser");
  return (
    <ComputerPanel
      expanded
      title={w("Computer", "电脑", "電腦")}
      modeLabel={view === "browser" ? w("Browser", "浏览器", "瀏覽器") : w("Files", "文件", "檔案")}
      actions={
        <>
          <SectionIndex
            label={w("Computer view", "电脑视图", "電腦檢視")}
            activeKey={view}
            onSelect={(key) => setView(key === "files" ? "files" : "browser")}
            groups={[{ key: "views", label: null, items: [
              { key: "browser", label: w("Browser", "浏览器", "瀏覽器"), icon: <Glyph name="browser" size={14} /> },
              { key: "files", label: w("Files", "文件", "檔案"), icon: <Glyph name="file" size={14} /> },
            ] }]}
          />
          <Button type="button" variant="quiet" size="sm" className="cv-icon-button" aria-label={w("Close computer", "关闭电脑面板", "關閉電腦面板")} onClick={onClose}>
            <Glyph name="close" size={16} />
          </Button>
        </>
      }
    >
      {view === "browser" ? <BrowserView /> : <FilesView />}
    </ComputerPanel>
  );
}
