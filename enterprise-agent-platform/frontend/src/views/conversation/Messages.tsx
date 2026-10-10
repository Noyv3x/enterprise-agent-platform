import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import { EntityChip } from "../../components/ui/beautiful/atoms/EntityChip";
import { StatusPill } from "../../components/ui/beautiful/atoms/StatusPill";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import StreamingText, { type StreamingAction } from "../../components/ui/beautiful/primitives/StreamingText";
import { intlLocale } from "../../i18n";
import { useWords } from "../../words";
import { AttachmentCards } from "./Attachments";
import { Markdown } from "./Markdown";
import { TaskNoticeRow } from "./Tasks";
import type { LiveRun, Message } from "./types";
import { messageWork, splitLive, workSegments, type WorkTrace } from "./work";
import { WorkView } from "./WorkView";

/** `MEDIA: /workspace/x` lines stay in stored text; the attachment card replaces the ones it delivered. */
export function visibleContent(message: Message): string {
  if (!message.attachments.length) return message.content;
  const names = new Set(message.attachments.map((attachment) => attachment.filename));
  return message.content
    .split("\n")
    .filter((line) => {
      const media = /^\s*MEDIA:\s*(\S.*?)\s*$/.exec(line);
      return !media || !names.has(media[1].split("/").pop() ?? "");
    })
    .join("\n")
    .trim();
}

function authorName(message: Message): string | null {
  const name = message.metadata.author_display_name;
  return typeof name === "string" && name ? name : null;
}

const AUTHOR_COLORS = ["var(--accent)", "var(--orange)", "var(--green)", "var(--red)", "var(--ink-2)"];

function authorColor(message: Message): string {
  const id = typeof message.metadata.author_user_id === "number" ? message.metadata.author_user_id : 0;
  return AUTHOR_COLORS[Math.abs(id) % AUTHOR_COLORS.length];
}

function timeLabel(message: Message): string {
  return new Date(message.created_at).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
}

/** Harness UserBubble; channel messages name their author, and other people's messages sit on the left. Entrance and
 * movement belong to the enclosing Movable. */
export function UserBubble({ message, showAuthor, mine, queuePosition, pending = false, action }: {
  message: Message;
  showAuthor: boolean;
  mine: boolean;
  /** 1-based FIFO position while queued */
  queuePosition?: number;
  pending?: boolean;
  /** a small control beside the status line (withdraw) */
  action?: ReactNode;
}) {
  const w = useWords();
  const content = visibleContent(message);
  const name = showAuthor ? authorName(message) : null;
  let label: string | null = null;
  if (message.metadata.status === "queued") {
    const ahead = queuePosition && queuePosition > 1 ? queuePosition - 1 : 0;
    label = message.metadata.send_mode === "after_turn"
      ? w("Sends after this turn", "本轮结束后发送", "本輪結束後傳送") + (ahead ? w(` · ${ahead} ahead`, ` · 前面还有 ${ahead} 条`, ` · 前面還有 ${ahead} 則`) : "")
      : ahead ? w(`Queued · ${ahead} ahead`, `排队中 · 前面还有 ${ahead} 条`, `排隊中 · 前面還有 ${ahead} 則`) : w("Queued", "排队中", "排隊中");
  } else if (pending) {
    label = w("The agent will see this after its current step", "智能体会在当前步骤结束后看到这条消息", "智慧體會在目前步驟結束後看到這則訊息");
  }
  return (
    <div className={`flex flex-col gap-1.5 ${mine ? "items-end pl-10 sm:pl-24" : "items-start pr-10 sm:pr-24"}`}>
      {name && <EntityChip name={name} color={authorColor(message)} className="mx-0" />}
      {message.attachments.length > 0 && <AttachmentCards attachments={message.attachments} />}
      {content && (
        <div title={timeLabel(message)} className="max-w-full rounded-xl bg-field px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-ink shadow-hairline [overflow-wrap:anywhere]">
          {content}
        </div>
      )}
      {(label || action) && (
        <div className={`flex flex-wrap items-center gap-x-1.5 ${mine ? "justify-end" : ""}`}>
          {label && <span className="text-[12px] text-ink-2">{label}</span>}
          {action}
        </div>
      )}
    </div>
  );
}

/** Renders one user message inside a reply: `pending` while it waits for the agent's current step. */
export type RenderInput = (messageId: number, pending: boolean) => ReactNode;

const NO_MESSAGES: Message[] = [];

/** One agent turn, streaming (`run`) or settled (`message`). The live reply and the persisted message it becomes are
 * this same component under the same key (useConversation `replyKeys`), so the article, its work segments, inputs and
 * answer keep their DOM, disclosure state and entrances when the turn settles. Work segments and the inputs between
 * them are one keyed list: a pending input moves to its delivery boundary as the same node. Inputs sit outside the
 * collapsible work, exactly where the agent received them. */
export const Reply = memo(function Reply({ message, run, inserted = NO_MESSAGES, renderInput, starting = false, enter = false }: {
  /** the persisted reply */
  message?: Message;
  /** the streaming reply, while there is no persisted message */
  run?: LiveRun;
  /** live only: messages absorbed into this turn */
  inserted?: Message[];
  renderInput: RenderInput;
  starting?: boolean;
  /** play the entrance on mount: a reply that arrived already settled, after the first page */
  enter?: boolean;
}) {
  const w = useWords();
  const [entrance] = useState(enter);
  const persisted = useMemo(() => (message ? messageWork(message) : null), [message]);
  const items = run?.items;
  const live = useMemo(() => (items ? splitLive(items) : null), [items]);
  const startedAt = run?.startedAt ?? null;
  const trace = useMemo<WorkTrace | null>(() => (message ? persisted
    : live?.work.length ? { items: live.work, startedAt, endedAt: null, truncated: false, omitted: 0 } : null), [message, persisted, live, startedAt]);
  const segments = useMemo(() => (trace ? workSegments(trace) : []), [trace]);

  const working = !message && !live?.answer;
  const rows: ReactNode[] = [];
  segments.forEach((segment, index) => {
    if (segment.trace.items.length > 0 || segment.trace.truncated) {
      rows.push(<WorkView key={`work-${segment.key}`} trace={segment.trace} working={working && index === segments.length - 1} run={message ? message.id : "live"} />);
    }
    if (segment.input !== null) rows.push(<Fragment key={`input-${segment.input}`}>{renderInput(segment.input, false)}</Fragment>);
  });

  if (message) {
    const content = visibleContent(message);
    const status = message.metadata.status;
    const error = typeof message.metadata.error === "string" ? message.metadata.error : "";
    const actions: StreamingAction[] = content ? [{
      key: "copy", icon: "copy", label: w("Copy reply", "复制回复", "複製回覆"), doneLabel: w("Copied", "已复制", "已複製"),
      onClick: () => navigator.clipboard.writeText(message.content),
    }] : [];
    rows.push(
      <StreamingText
        key="answer"
        streaming={false}
        actions={actions}
        status={status === "interrupted" || status === "cancelled" ? (
          <>
            <StatusPill tone={status === "interrupted" ? "orange" : "neutral"} className="h-5.5 text-[12px]">
              {status === "interrupted" ? w("Interrupted", "已中断", "已中斷") : w("Stopped", "已停止", "已停止")}
            </StatusPill>
            {error && <span className="text-[12px] text-ink-2 [overflow-wrap:anywhere]">{error}</span>}
          </>
        ) : undefined}
      >
        {content ? <Markdown content={content} /> : undefined}
      </StreamingText>,
    );
    if (message.attachments.length > 0) rows.push(<AttachmentCards key="files" attachments={message.attachments} />);
  } else if (run && live) {
    if (live.answer) {
      rows.push(
        <StreamingText key="answer" streaming>
          <Markdown content={live.answer} streaming />
        </StreamingText>,
      );
    }
    const notice = run.notice === "retry" ? w("Connection hiccup, retrying", "连接波动，正在重试", "連線不穩，正在重試")
      : run.notice === "compaction" ? w("Compacting context", "正在压缩上下文", "正在壓縮上下文") : null;
    if (notice || (!live.work.length && !live.answer)) {
      rows.push(
        <div key="status" className="flex min-h-6 items-center">
          <LoadingState variant="Dots" label={notice ?? (starting ? w("Starting", "正在开始", "正在開始") : w("Thinking", "思考中", "思考中"))} since={run.startedAt} />
        </div>,
      );
    }
    const delivered = new Set(live.work.flatMap((item) => (item.type === "input" ? [item.messageId] : [])));
    for (const input of inserted) {
      if (!delivered.has(input.id)) rows.push(<Fragment key={`input-${input.id}`}>{renderInput(input.id, input.metadata.delivery !== "delivered")}</Fragment>);
    }
  }

  return (
    <article
      className="flex min-w-0 flex-col gap-2"
      aria-label={message ? w("Agent reply", "智能体回复", "智慧體回覆") : w("Reply in progress", "回复生成中", "回覆產生中")}
      aria-busy={message ? undefined : true}
      style={entrance ? { animation: "fade-up 450ms cubic-bezier(0.23,1,0.32,1) both" } : undefined}
    >
      {rows}
    </article>
  );
});

/** Waiting for the first event of an accepted message: queued behind other work, or starting. */
export function PendingReply({ since, queued }: { since: number; queued: boolean }) {
  const w = useWords();
  return (
    <div className="flex min-h-6 items-center" style={{ animation: "fade-in 200ms ease-out both" }}>
      <LoadingState
        variant="Dots"
        since={since}
        label={queued ? w("Waiting in queue", "排队等待中", "排隊等待中") : w("Starting", "正在开始", "正在開始")}
      />
    </div>
  );
}

/** A system message: a background task notice (hidden once the Platform skipped it), else a centered line. */
export function SystemLine({ message }: { message: Message }) {
  if (message.metadata.kind === "task_notice") return message.metadata.skipped === true ? null : <TaskNoticeRow message={message} />;
  return <p className="text-center text-[12px] text-ink-2">{message.content}</p>;
}
