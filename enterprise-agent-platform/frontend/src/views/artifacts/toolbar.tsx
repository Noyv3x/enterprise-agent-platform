/** Toolbar pieces the artifact viewer, the file view and the live preview share: the flat panel rows (the side panel's
 * flush spec: hairline-separated rows, the screen full-bleed below them), icon buttons, 放大, and the 圈选 toggle and
 * hint. */
import { useState } from "react";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { Icon } from "../../components/ui/beautiful/controls";
import { useWords } from "../../words";
import type { ArtifactKind } from "../../api";
import { MAX_FEEDBACK, type FeedbackInput, type FeedbackSink } from "./feedback";

export const ICON_BUTTON = "primitive-icon-button shrink-0 text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink aria-disabled:pointer-events-none aria-disabled:opacity-40 touch:size-11";

/** A flat row above the screen. The first row starts with the back control, so it sits closer to the edge. */
export const PANEL_ROW = "flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-page px-3 py-2";
export const PANEL_HEAD = "flex min-h-11 min-w-0 shrink-0 items-center gap-2 border-b border-line bg-page py-1 pr-1.5 pl-1.5";

/** The screen under the rows: full-bleed, no frame. */
export const PANEL_SCREEN = "relative flex min-h-[320px] flex-1 flex-col bg-surface";

/** The page address above a web screen, as the computer's toolbar shows it. */
export function AddressRow({ address }: { address: string }) {
  return (
    <div className="flex min-h-7 shrink-0 items-center border-b border-line bg-page px-3">
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2" title={address}>{address}</span>
    </div>
  );
}

/* maximize-2, as the computer window's open control */
export const EXPAND_ICON = <><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>;

/** Pages, sites and live previews pick elements; the text kinds quote. */
export const ANNOTATABLE: Partial<Record<ArtifactKind, "page" | "text">> = { web: "page", site: "page", live: "page", markdown: "text", code: "text", table: "text" };

/** 圈选 on or off, and what the last pick did: `ok` added it, otherwise MAX_FEEDBACK already wait. */
export function useAnnotate(feedback: FeedbackSink | null) {
  const [on, setOn] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; seq: number } | null>(null);
  const add = (input: FeedbackInput) => {
    if (!feedback) return;
    const ok = feedback.add(input);
    setNote((current) => ({ ok, seq: (current?.seq ?? 0) + 1 }));
  };
  return { on, setOn, note, add };
}

export function AnnotateToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const w = useWords();
  return (
    <Button
      variant="quiet"
      size="xs"
      aria-pressed={on}
      title={w("Point at something to give the AI feedback on it", "圈出要修改的地方，反馈给 AI", "圈出要修改的地方，回饋給 AI")}
      onClick={() => onChange(!on)}
      className={`touch:h-11 ${on ? "bg-accent-tint text-accent-ink hover:bg-accent-tint" : "text-ink-2"}`}
    >
      <Icon name="annotate" size={14} />
      {w("Annotate", "圈选", "圈選")}
    </Button>
  );
}

/** Under the toolbar while 圈选 is on: how to pick (a page) or quote (text kinds), what was added, and 完成. */
export function AnnotateStrip({ page, feedback, note, onDone }: {
  page: boolean;
  feedback: FeedbackSink;
  note: { ok: boolean; seq: number } | null;
  onDone: () => void;
}) {
  const w = useWords();
  const hint = page
    ? w("Click an element, or hold Shift and drag to select a region", "点选元素，或按住 Shift 拖动框选区域", "點選元素，或按住 Shift 拖動框選區域")
    : w("Select text, then choose Quote in chat", "选中文字，再点「引用到对话」", "選取文字，再點「引用到對話」");
  const { count } = feedback;
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent-tint py-1 pr-1.5 pl-3 text-[12.5px] text-ink" style={{ animation: "fade-in 200ms ease-out both" }}>
      {/* The hint keeps a readable width; on a phone the status and actions wrap below it. */}
      <span className="flex min-w-[min(100%,15rem)] flex-1 items-center gap-2">
        <Icon name="annotate" size={14} className="shrink-0 text-accent-ink" />
        <span className="min-w-0">{hint}</span>
      </span>
      <span role="status" aria-live="polite" aria-label={w("Feedback status", "反馈状态", "回饋狀態")} className="text-[12px] font-medium text-accent-ink empty:hidden">
        {note && !note.ok ? (
          <span key={note.seq} className="text-ink">{w(`${MAX_FEEDBACK} notes already wait: send or remove some first`, `已有 ${MAX_FEEDBACK} 条反馈，请先发送或移除`, `已有 ${MAX_FEEDBACK} 則回饋，請先傳送或移除`)}</span>
        ) : note && count > 0 ? (
          <span key={note.seq} style={{ animation: "fade-in 200ms ease-out both" }}>{w(`Added to the message (${count}/${MAX_FEEDBACK})`, `已加入对话（${count}/${MAX_FEEDBACK}）`, `已加入對話（${count}/${MAX_FEEDBACK}）`)}</span>
        ) : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {feedback.toComposer && count > 0 && (
          <Button size="xs" className="touch:h-11" onClick={feedback.toComposer}>{w("Write feedback", "去写意见", "去寫意見")}</Button>
        )}
        <Button variant="quiet" size="xs" className="touch:h-11" onClick={onDone}>{w("Done", "完成", "完成")}</Button>
      </span>
    </div>
  );
}
