/** A Mermaid diagram: inline in chat Markdown (a card with a 源码 toggle) or filling the artifact panel. */
import { useContext, useEffect, useState } from "react";
import { Icon } from "../../../components/ui/beautiful/controls";
import CodeBlock from "../../../components/ui/beautiful/primitives/CodeBlock";
import { LoaderGrid } from "../../../components/ui/beautiful/primitives/LoadingState";
import { ThemeContext } from "../../../context/ThemeContext";
import { useWords } from "../../../words";
import { DiagramError, renderMermaid, type DiagramTheme } from "./mermaid";
import { useCodeLabels } from "./states";

type Drawn = { source: string; theme: DiagramTheme } & ({ svg: string } | { error: DiagramError });

function DiagramIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-3">
      <rect x="3" y="3.5" width="7" height="5" rx="1.5" /><rect x="14" y="15.5" width="7" height="5" rx="1.5" /><path d="M6.5 8.5v4.5a2.5 2.5 0 0 0 2.5 2.5h5" />
    </svg>
  );
}

export function MermaidDiagram({ source, fill = false }: { source: string; /** fill the artifact panel instead of an inline card */ fill?: boolean }) {
  const w = useWords();
  const labels = useCodeLabels();
  // Markdown also renders outside the app's ThemeProvider (tests, isolated views): read the painted theme there.
  const theme: DiagramTheme = useContext(ThemeContext)?.theme ?? (document.documentElement.classList.contains("dark") ? "dark" : "light");
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let live = true;
    renderMermaid(source, theme).then(
      (svg) => live && setDrawn({ source, theme, svg }),
      (error: DiagramError) => live && setDrawn({ source, theme, error }),
    );
    return () => { live = false; };
  }, [source, theme]);

  // A theme switch keeps the previous drawing until the new one is ready.
  const current = drawn?.source === source && (drawn.theme === theme || "svg" in drawn) ? drawn : null;
  const title = w("Mermaid diagram", "Mermaid 图表", "Mermaid 圖表");

  if (current && "error" in current) {
    return (
      <div className={fill ? "flex h-full min-h-0 flex-col gap-2 p-4" : "w-full space-y-1.5"}>
        <p role="status" className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <Icon name="warning" size={13} className="shrink-0 text-orange-ink" />
          {current.error.reason === "load"
            ? w("The diagram renderer didn't load; showing the source.", "图表渲染组件未能载入，显示源码。", "圖表渲染元件未能載入，顯示原始碼。")
            : current.error.reason === "external"
              ? w("This diagram loads outside images or styles, which aren't shown; showing the source.", "图表引用了外部图片或样式，不予加载，显示源码。", "圖表引用了外部圖片或樣式，不予載入，顯示原始碼。")
              : w("This diagram has a syntax error; showing the source.", "图表语法有误，显示源码。", "圖表語法有誤，顯示原始碼。")}
        </p>
        <div className={fill ? "min-h-0 flex-1" : ""}>
          <CodeBlock fill fillHeight={fill} code={source} filename="mermaid" labels={labels} />
        </div>
      </div>
    );
  }

  const drawing = current ? (
    <div
      className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full"
      // Mermaid output under securityLevel 'strict': labels are encoded and the SVG is sanitized.
      dangerouslySetInnerHTML={{ __html: current.svg }}
    />
  ) : (
    <div role="status" className="flex min-h-30 items-center justify-center gap-2.5 text-[12px] text-ink-2">
      <LoaderGrid />
      {w("Drawing diagram…", "正在绘制图表…", "正在繪製圖表…")}
    </div>
  );

  if (fill) {
    return <figure aria-label={title} className="m-0 h-full min-h-0 overflow-auto p-6">{drawing}</figure>;
  }

  return (
    <figure aria-label={title} className="m-0 w-full overflow-hidden rounded-card bg-surface shadow-card">
      <div className="flex h-11 items-center gap-2 border-b border-line px-4 text-[12.5px]">
        <span className="inline-flex min-w-0 items-center gap-[7px]">
          <DiagramIcon />
          <span className="truncate font-mono leading-none text-ink">mermaid</span>
        </span>
        <button
          type="button"
          aria-pressed={showSource}
          onClick={() => setShowSource((shown) => !shown)}
          className="-mr-1 ml-auto flex h-6 items-center rounded-[6px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink aria-pressed:bg-hover-2 aria-pressed:text-ink touch:h-11"
        >
          {w("Source", "源码", "原始碼")}
        </button>
      </div>
      {showSource ? (
        <pre className="max-h-[480px] overflow-auto px-4 py-3 font-mono text-[12.5px] leading-[1.65] whitespace-pre-wrap text-ink-2" tabIndex={0}>{source}</pre>
      ) : (
        <div className="max-h-[640px] overflow-auto px-4 py-4" tabIndex={0}>{drawing}</div>
      )}
    </figure>
  );
}
