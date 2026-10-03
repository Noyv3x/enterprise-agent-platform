import { EntityChip } from "../../components/ui/beautiful/atoms/EntityChip";
import { StatusPill } from "../../components/ui/beautiful/atoms/StatusPill";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import StreamingText, { type StreamingAction } from "../../components/ui/beautiful/primitives/StreamingText";
import { intlLocale } from "../../i18n";
import { useWords } from "../../words";
import { AttachmentCards } from "./Attachments";
import { Markdown } from "./Markdown";
import type { LiveRun, Message } from "./types";
import { messageWork, splitLive } from "./work";
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

/** Harness UserBubble; channel messages name their author, and other people's messages sit on the left. */
export function UserBubble({ message, showAuthor, mine, queuePosition }: {
  message: Message;
  showAuthor: boolean;
  mine: boolean;
  /** 1-based FIFO position while queued */
  queuePosition?: number;
}) {
  const w = useWords();
  const content = visibleContent(message);
  const name = showAuthor ? authorName(message) : null;
  const status = message.metadata.status;
  return (
    <div
      className={`flex flex-col gap-1.5 ${mine ? "items-end pl-10 sm:pl-24" : "items-start pr-10 sm:pr-24"}`}
      style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {name && <EntityChip name={name} color={authorColor(message)} className="mx-0" />}
      {message.attachments.length > 0 && <AttachmentCards attachments={message.attachments} />}
      {content && (
        <div title={timeLabel(message)} className="max-w-full rounded-xl bg-field px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-ink shadow-hairline [overflow-wrap:anywhere]">
          {content}
        </div>
      )}
      {status === "queued" && (
        <span className="text-[12px] text-ink-2">
          {queuePosition && queuePosition > 1
            ? w(`Queued · ${queuePosition - 1} ahead`, `排队中 · 前面还有 ${queuePosition - 1} 条`, `排隊中 · 前面還有 ${queuePosition - 1} 則`)
            : w("Queued", "排队中", "排隊中")}
        </span>
      )}
    </div>
  );
}

/** A finished (or stopped) agent reply: its work trace, the answer, files, and the action row. */
export function AssistantMessage({ message }: { message: Message }) {
  const w = useWords();
  const content = visibleContent(message);
  const trace = messageWork(message);
  const status = message.metadata.status;
  const error = typeof message.metadata.error === "string" ? message.metadata.error : "";
  const stopped = status === "interrupted" || status === "cancelled";
  const actions: StreamingAction[] = [];
  if (content) {
    actions.push({
      key: "copy", icon: "copy", label: w("Copy reply", "复制回复", "複製回覆"), doneLabel: w("Copied", "已复制", "已複製"),
      onClick: () => navigator.clipboard.writeText(message.content),
    });
  }
  return (
    <article className="flex min-w-0 flex-col gap-2" aria-label={w("Agent reply", "智能体回复", "智慧體回覆")} style={{ animation: "fade-up 450ms cubic-bezier(0.23,1,0.32,1) both" }}>
      {trace && <WorkView trace={trace} working={false} run={message.id} />}
      <StreamingText
        streaming={false}
        actions={actions}
        status={stopped ? (
          <>
            <StatusPill tone={status === "interrupted" ? "orange" : "neutral"} className="h-5.5 text-[12px]">
              {status === "interrupted" ? w("Interrupted", "已中断", "已中斷") : w("Stopped", "已停止", "已停止")}
            </StatusPill>
            {error && <span className="text-[12px] text-ink-2 [overflow-wrap:anywhere]">{error}</span>}
          </>
        ) : undefined}
      >
        {content ? <Markdown content={content} /> : undefined}
      </StreamingText>
      {message.attachments.length > 0 && <AttachmentCards attachments={message.attachments} />}
    </article>
  );
}

/** The reply streaming right now: live work (open, shimmering) above the answer with its caret. */
export function LiveReply({ run }: { run: LiveRun }) {
  const w = useWords();
  const { work, answer } = splitLive(run.items);
  const notice = run.notice === "retry" ? w("Connection hiccup, retrying", "连接波动，正在重试", "連線不穩，正在重試")
    : run.notice === "compaction" ? w("Compacting context", "正在压缩上下文", "正在壓縮上下文") : null;
  return (
    <article className="flex min-w-0 flex-col gap-2" aria-label={w("Reply in progress", "回复生成中", "回覆產生中")} aria-busy="true">
      {work.length > 0 && (
        <WorkView trace={{ items: work, startedAt: run.startedAt, endedAt: null, truncated: false, omitted: 0 }} working={!answer} run="live" />
      )}
      {answer && (
        <StreamingText streaming>
          <Markdown content={answer} streaming />
        </StreamingText>
      )}
      {(notice || (!work.length && !answer)) && (
        <div className="flex min-h-6 items-center">
          <LoadingState variant="Dots" label={notice ?? w("Thinking", "思考中", "思考中")} since={run.startedAt} />
        </div>
      )}
    </article>
  );
}

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

export function SystemLine({ message }: { message: Message }) {
  return <p className="text-center text-[12px] text-ink-2">{message.content}</p>;
}
