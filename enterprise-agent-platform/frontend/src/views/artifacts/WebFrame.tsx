import { useEffect, useRef, useState } from "react";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import { useWords } from "../../words";

/** The width a web page is previewed at: the frame's own width, or a tablet or phone viewport. */
export type FrameWidth = "desktop" | "tablet" | "phone";

const VIEWPORT: Record<FrameWidth, number | null> = { desktop: null, tablet: 768, phone: 390 };

/** The sandbox the pages run in (security-and-trust.md § Artifacts): scripts but no same-origin, so the page has an
 * opaque origin and never gets the session; the view route's CSP repeats it for new tabs. */
export const ARTIFACT_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

/** A `web`/`site` artifact in its sandboxed frame. Tablet and phone widths keep their viewport and scale down to fit a
 * narrower panel. */
export function WebFrame({ src, title, width }: { src: string | null; title: string; width: FrameWidth }) {
  const w = useWords();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const viewport = VIEWPORT[width];
  // Unmeasured (or wide enough): no scaling.
  const scale = viewport && size.width > 0 && size.width < viewport ? size.width / viewport : 1;
  const framed = viewport !== null;
  return (
    <div ref={box} className={`absolute inset-0 overflow-hidden ${framed ? "bg-inset" : "bg-surface"}`}>
      {src && (
        <iframe
          key={src}
          src={src}
          title={title}
          sandbox={ARTIFACT_SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedSrc(src)}
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
      {(!src || loadedSrc !== src) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <LoadingState variant="Dots" label={w("Loading page", "正在加载页面", "正在載入頁面")} />
        </div>
      )}
    </div>
  );
}
