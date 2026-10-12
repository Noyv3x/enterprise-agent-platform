import { useContext } from "react";
import type { ArtifactFeedback } from "../../api";
import { Icon } from "../../components/ui/beautiful/controls";
import { CONTEXT_CHIP } from "../../components/ui/beautiful/primitives/ContextCards";
import { useWords } from "../../words";
import { ArtifactsContext } from "./ArtifactCards";
import { feedbackLabel } from "./feedback";

/** A sent message's 圈选反馈 in its bubble: one chip per item that opens the artifact at that version (a live preview
 * at its page). */
export function FeedbackChips({ items, align }: { items: ArtifactFeedback[]; align: "start" | "end" }) {
  const w = useWords();
  const opener = useContext(ArtifactsContext);
  return (
    <ul aria-label={w("Feedback on artifacts", "作品反馈", "作品回饋")} className={`flex max-w-full flex-wrap gap-1.5 ${align === "end" ? "justify-end" : ""}`}>
      {items.map((item, index) => {
        const label = feedbackLabel(item, w);
        return (
          <li key={index} className="max-w-full">
            <button
              type="button"
              disabled={!opener}
              title={item.text ? `${label}\n${item.text}` : label}
              aria-label={w(`Open ${label}`, `打开 ${label}`, `開啟 ${label}`)}
              onClick={() => opener?.open(item.artifact_id, item.version ?? 0)}
              className={`${CONTEXT_CHIP} max-w-full disabled:opacity-60`}
            >
              <Icon name={item.kind === "quote" ? "quote" : "annotate"} size={13} className="shrink-0 text-accent-ink" />
              <span className="truncate">{label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
