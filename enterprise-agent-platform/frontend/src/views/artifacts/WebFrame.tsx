import { useEffect, useMemo, useRef, useState } from "react";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import { useWords } from "../../words";
import type { FeedbackRect, FramePick } from "./feedback";
import { saveFrameStorage, seededFrameUrl } from "./frameStorage";

/** The width a web page is previewed at: the frame's own width, or a tablet or phone viewport. */
export type FrameWidth = "desktop" | "tablet" | "phone";

const VIEWPORT: Record<FrameWidth, number | null> = { desktop: null, tablet: 768, phone: 390 };

/** The sandbox the pages run in (security-and-trust.md § Artifacts): scripts but no same-origin, so the page has an
 * opaque origin and never gets the session; the view route's CSP repeats it for new tabs. */
export const ARTIFACT_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function rectOf(value: unknown): FeedbackRect | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, w, h } = value as Record<string, unknown>;
  return finite(x) && finite(y) && finite(w) && finite(h) && w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Platform's limit for a pick's `selector` and `path` (platform-api.md § Annotate feedback). */
export const PICK_FIELD_MAX = 500;

/** An `eap-pick` message as a FramePick, or null when it is malformed. A selector is cut to PICK_FIELD_MAX; a longer
 * path would name another page once cut, so such a pick is dropped. */
export function framePick(data: Record<string, unknown>): FramePick | null {
  const rect = rectOf(data.rect);
  const viewport = data.viewport as Record<string, unknown> | null | undefined;
  if (!rect || (data.kind !== "element" && data.kind !== "region") || typeof data.path !== "string" || data.path.length > PICK_FIELD_MAX) return null;
  if (!viewport || !finite(viewport.w) || !finite(viewport.h)) return null;
  const text = (key: string, max: number) => (typeof data[key] === "string" ? (data[key] as string).slice(0, max) : undefined);
  return data.kind === "element"
    ? { kind: "element", selector: text("selector", PICK_FIELD_MAX), tag: text("tag", 40), text: text("text", 300), rect, path: data.path, viewport: { w: viewport.w, h: viewport.h } }
    : { kind: "region", rect, path: data.path, viewport: { w: viewport.w, h: viewport.h } };
}

/** A `web`/`site`/`live` page in its sandboxed frame. Tablet and phone widths keep their viewport and scale down to fit
 * a narrower panel.
 *
 * The page runtime talks to the panel by postMessage (frontend.md § Artifacts); only messages whose source is this
 * frame's window count. `inspecting` turns its 圈选 inspector on (re-sent on every load); with `storageKey` the page's
 * localStorage persists across loads. */
export function WebFrame({ src, title, width, inspecting = false, onPick, onInspectExit, storageKey = null }: {
  src: string | null;
  title: string;
  width: FrameWidth;
  inspecting?: boolean;
  onPick?: (pick: FramePick) => void;
  onInspectExit?: () => void;
  storageKey?: string | null;
}) {
  const w = useWords();
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  // The kept storage is read once per URL: later snapshots must not reload the frame.
  const frameSrc = useMemo(() => (src && storageKey ? seededFrameUrl(src, storageKey) : src), [src]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const latest = useRef({ inspecting, onPick, onInspectExit, storageKey });
  latest.current = { inspecting, onPick, onInspectExit, storageKey };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || !event.data || typeof event.data !== "object") return;
      const data = event.data as Record<string, unknown>;
      const current = latest.current;
      if (data.type === "eap-storage") {
        if (current.storageKey) saveFrameStorage(current.storageKey, data.data);
      } else if (data.type === "eap-pick") {
        const pick = current.inspecting ? framePick(data) : null;
        if (pick) current.onPick?.(pick);
      } else if (data.type === "eap-inspect-exit") {
        current.onInspectExit?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** The runtime ignores a repeated state, so every load and every toggle simply sends it. */
  const sendInspect = () => frame.current?.contentWindow?.postMessage({ type: "eap-inspect", on: latest.current.inspecting }, "*");
  useEffect(() => {
    if (loadedSrc) sendInspect();
  }, [inspecting]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewport = VIEWPORT[width];
  // Unmeasured (or wide enough): no scaling.
  const scale = viewport && size.width > 0 && size.width < viewport ? size.width / viewport : 1;
  const framed = viewport !== null;
  return (
    <div ref={box} className={`absolute inset-0 overflow-hidden ${framed ? "bg-inset" : "bg-surface"}`}>
      {src && frameSrc && (
        <iframe
          ref={frame}
          key={src}
          src={frameSrc}
          title={title}
          sandbox={ARTIFACT_SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={() => {
            setLoadedSrc(src);
            sendInspect();
          }}
          className={`absolute top-0 border-0 bg-white ${framed ? "shadow-card" : ""}`}
          style={framed ? {
            width: viewport,
            height: scale < 1 && size.height > 0 ? size.height / scale : "100%",
            left: scale < 1 ? 0 : "50%",
            transform: scale < 1 ? `scale(${scale})` : "translateX(-50%)",
            transformOrigin: "top left",
          } : { left: 0, width: "100%", height: "100%" }}
        />
      )}
      {inspecting && <div aria-hidden className="pointer-events-none absolute inset-0 ring-2 ring-accent ring-inset" />}
      {(!src || loadedSrc !== src) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <LoadingState variant="Dots" label={w("Loading page", "正在加载页面", "正在載入頁面")} />
        </div>
      )}
    </div>
  );
}
