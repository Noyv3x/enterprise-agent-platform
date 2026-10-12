import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { Icon } from "../../components/ui/beautiful/controls";
import { useWords } from "../../words";
import { QUOTE_MAX } from "./feedback";

/** Quoting for the text kinds' 圈选: while `active`, selecting text inside shows 引用到对话 under the selection. */
export function QuoteLayer({ active, onQuote, children }: { active: boolean; onQuote: (text: string) => void; children: ReactNode }) {
  const w = useWords();
  const box = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    if (!active) {
      setAnchor(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      const node = box.current;
      const selection = document.getSelection();
      const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
      const text = selection?.toString().trim() ?? "";
      if (!node || !range || !text || !node.contains(range.commonAncestorContainer)) {
        setAnchor(null);
        return;
      }
      const outer = node.getBoundingClientRect();
      // jsdom has no layout for ranges; the button then sits at the top.
      const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
      const x = rect ? rect.left + rect.width / 2 - outer.left : outer.width / 2;
      const y = rect ? rect.bottom - outer.top + 8 : 8;
      setAnchor({ x: Math.min(Math.max(x, 72), Math.max(outer.width - 72, 72)), y: Math.min(Math.max(y, 8), Math.max(outer.height - 52, 8)), text });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const node = box.current;
    document.addEventListener("selectionchange", schedule);
    node?.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      node?.removeEventListener("scroll", schedule, true);
    };
  }, [active]);

  return (
    <div ref={box} className={`relative h-full min-h-0 ${active ? "selection:bg-accent-tint" : ""}`}>
      {children}
      {anchor && (
        <div className="absolute z-10 -translate-x-1/2" style={{ left: anchor.x, top: anchor.y, animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <Button
            variant="primary"
            size="xs"
            className="shadow-raised touch:h-11"
            // Keeps the selection while the button takes the press.
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onQuote(anchor.text.slice(0, QUOTE_MAX));
              document.getSelection()?.removeAllRanges();
              setAnchor(null);
            }}
          >
            <Icon name="quote" size={13} />
            {w("Quote in chat", "引用到对话", "引用到對話")}
          </Button>
        </div>
      )}
    </div>
  );
}
