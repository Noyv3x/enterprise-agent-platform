import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/ui/beautiful";
import { ConversationEmpty, ConversationJump, ConversationLayout, Glyph, LoadingState, Notice, PageHeader } from "../components/ui/fieldwork";
import { useWords } from "../words";
import { Composer } from "./conversation/Composer";
import { Computer } from "./conversation/Computer";
import { LiveRunView, MessageView } from "./conversation/Messages";
import { errorText, useConversation } from "./conversation/useConversation";
import "./conversation/conversation.css";

const NEAR_BOTTOM_PX = 48;

export interface ConversationProps {
  /** `private`, `channel-<id>` or `chat-<uuid>` (API route form). */
  scope: string;
  title?: ReactNode;
  /** Extra header controls, e.g. the chat model picker. */
  actions?: ReactNode;
  /** Called after each finished agent run (chat titles may change). */
  onRunEnd?: () => void;
  /** False for read-only viewers (e.g. channel readers without chat permission): no composer or conversation mutations. */
  canSend?: boolean;
}

function ConversationScope({ scope, title, actions, onRunEnd, canSend = true }: ConversationProps) {
  const w = useWords();
  const conversation = useConversation(scope, onRunEnd);
  const [computerOpen, setComputerOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [working, setWorking] = useState<"compact" | "reset" | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const thread = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const restoreFrom = useRef<number | null>(null);

  const { messages, live } = conversation;
  // Follow new output while the reader is at the bottom; keep the reading position when older history is prepended.
  useLayoutEffect(() => {
    const node = thread.current;
    if (!node) return;
    if (restoreFrom.current !== null) {
      node.scrollTop += node.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
    } else if (pinned.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages, live, conversation.phase]);

  const loadOlder = async () => {
    setLoadingOlder(true);
    restoreFrom.current = thread.current?.scrollHeight ?? null;
    try {
      await conversation.loadOlder();
    } catch (reason) {
      restoreFrom.current = null;
      setNotice({ tone: "danger", text: errorText(reason) });
    } finally {
      setLoadingOlder(false);
    }
  };

  const run = async (kind: "compact" | "reset") => {
    setWorking(kind);
    setNotice(null);
    setConfirmingReset(false);
    try {
      if (kind === "compact") await conversation.compact();
      else await conversation.reset();
      pinned.current = true;
      if (kind === "reset") setNotice({ tone: "success", text: w("Conversation reset", "对话已重置", "對話已重置") });
    } catch (reason) {
      setNotice({ tone: "danger", text: errorText(reason) });
    } finally {
      setWorking(null);
    }
  };

  const personal = scope === "private";
  const resettable = canSend && !scope.startsWith("chat-");
  const defaultTitle = personal ? w("Personal AI", "个人 AI", "個人 AI")
    : scope.startsWith("chat-") ? w("Chat", "对话", "對話") : w("Channel", "频道", "頻道");
  const header = (
    <PageHeader
      title={title ?? defaultTitle}
      actions={
        <>
          {actions}
          {canSend && (
            <Button type="button" variant="quiet" size="sm" disabled={working !== null || conversation.compactBusy || conversation.phase !== "ready"} onClick={() => void run("compact")}
              title={w("Summarize older turns so long conversations stay fast", "总结较早的对话，让长对话保持流畅", "總結較早的對話，讓長對話保持流暢")}>
              {w("Compact context", "压缩上下文", "壓縮上下文")}
            </Button>
          )}
          {resettable && (
            <Button type="button" variant="quiet" size="sm" disabled={working !== null || conversation.busy} aria-expanded={confirmingReset} onClick={() => setConfirmingReset(true)}>
              {w("Reset", "重置", "重置")}
            </Button>
          )}
          {personal && (
            <Button type="button" variant={computerOpen ? "ghost" : "quiet"} size="sm" aria-pressed={computerOpen} onClick={() => setComputerOpen(!computerOpen)}>
              <Glyph name="browser" size={16} />
              {w("Computer", "电脑", "電腦")}
            </Button>
          )}
        </>
      }
    />
  );

  let body: ReactNode;
  if (conversation.phase === "loading") {
    body = <LoadingState label={w("Loading conversation…", "正在加载对话…", "正在載入對話…")} />;
  } else if (conversation.phase === "error") {
    body = <Notice tone="danger" title={w("The conversation could not be loaded", "无法加载对话", "無法載入對話")}
      action={<Button type="button" variant="secondary" size="sm" onClick={() => void conversation.reload()}>{w("Retry", "重试", "重試")}</Button>}>
      {conversation.error}
    </Notice>;
  } else {
    body = (
      <>
        {conversation.compaction && (
          <div role="status" aria-label={w("Context compaction", "上下文压缩", "上下文壓縮")}>
            <Notice
              tone={conversation.compaction.status === "interrupted" ? "warning"
                : conversation.compactBusy ? "info" : "success"}
              title={{
                queued: w("Queued", "已排队", "已排隊"),
                compacting: w("Compacting", "正在压缩", "正在壓縮"),
                done: w("Done", "已完成", "已完成"),
                nothing_to_compact: w("Nothing to compact", "无需压缩", "無需壓縮"),
                interrupted: w("Interrupted", "已中断", "已中斷"),
                cancelled: w("Cancelled", "已取消", "已取消"),
              }[conversation.compaction.status]}
            >
              {conversation.compaction.status === "queued"
                ? w("Context compaction will run after earlier queued work. New messages queue behind it.", "上下文压缩将在先前排队的任务完成后开始。新消息将排在其后。", "上下文壓縮將在先前排隊的任務完成後開始。新訊息將排在其後。")
                : conversation.compaction.reason === "too_small"
                  ? w("The conversation is too short to compact.", "对话较短，无需压缩。", "對話較短，無需壓縮。")
                  : null}
              {conversation.compaction.error}
            </Notice>
          </div>
        )}
        {conversation.nextBefore !== null && (
          <div className="cv-older">
            <Button type="button" variant="quiet" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {w("Load earlier messages", "加载更早的消息", "載入更早的訊息")}
            </Button>
          </div>
        )}
        {messages.length === 0 && !live && (
          <ConversationEmpty
            title={personal ? w("What should we work on?", "今天要做什么？", "今天要做什麼？") : w("Start the conversation", "开始对话", "開始對話")}
            description={personal
              ? w("Your agent has its own workspace and browser. Ask it to research, write files, or run code; attach documents it should read.", "你的智能体拥有独立的工作区和浏览器。可以让它查资料、写文件、运行代码，也可以附上需要它阅读的文档。", "你的智慧體擁有獨立的工作區和瀏覽器。可以讓它查資料、寫檔案、執行程式，也可以附上需要它閱讀的文件。")
              : w("Messages and files you send here are answered by the agent. Attach documents for it to read.", "在这里发送的消息和文件会由智能体回复。可以附上需要它阅读的文档。", "在這裡傳送的訊息和檔案會由智慧體回覆。可以附上需要它閱讀的文件。")}
          />
        )}
        {messages.map((message) => <MessageView key={message.id} message={message} showAuthor={scope.startsWith("channel-")} />)}
        {live && <LiveRunView run={live} />}
      </>
    );
  }

  const layout = (
    <ConversationLayout
      header={header}
      notice={confirmingReset ? (
        <Notice tone="warning" title={w("Reset this conversation?", "重置此对话？", "重置此對話？")}
          action={
            <div className="wf-actions">
              <Button type="button" variant="primary" size="xs" disabled={working !== null} onClick={() => void run("reset")}>{w("Reset conversation", "重置对话", "重置對話")}</Button>
              <Button type="button" variant="quiet" size="xs" onClick={() => setConfirmingReset(false)}>{w("Cancel", "取消", "取消")}</Button>
            </div>
          }>
          {w("The agent starts a fresh session and no longer remembers this conversation's history. This cannot be undone.", "智能体将开始新的会话，不再记得此对话的历史。此操作无法撤销。", "智慧體將開始新的工作階段，不再記得此對話的歷史。此操作無法復原。")}
        </Notice>
      ) : notice ? <Notice tone={notice.tone} title={notice.text}
        action={<Button type="button" variant="quiet" size="xs" onClick={() => setNotice(null)}>{w("Dismiss", "关闭", "關閉")}</Button>} /> : undefined}
      threadRef={thread}
      threadLabel={w("Conversation", "对话", "對話")}
      onThreadScroll={(event) => {
        const node = event.currentTarget;
        const near = node.scrollHeight - node.scrollTop - node.clientHeight <= NEAR_BOTTOM_PX;
        pinned.current = near;
        setAtBottom(near);
      }}
      floatingActions={atBottom ? undefined : (
        <ConversationJump label={w("Jump to latest", "回到最新", "回到最新")} onClick={() => {
          const node = thread.current;
          if (node) node.scrollTop = node.scrollHeight;
        }} />
      )}
      composer={conversation.phase !== "ready" ? null
        : canSend ? <Composer scope={scope} busy={conversation.busy} onSend={conversation.send} onCancel={conversation.cancel} />
          : <Notice tone="info" title={w("You can read this conversation but not post in it", "你可以查看此对话，但不能发言", "你可以檢視此對話，但不能發言")} />}
    >
      {body}
    </ConversationLayout>
  );

  if (!personal || !computerOpen) return layout;
  return (
    <div className="cv-with-computer">
      {layout}
      <aside className="cv-computer" aria-label={w("Computer", "电脑", "電腦")}>
        <Computer onClose={() => setComputerOpen(false)} />
      </aside>
    </div>
  );
}

/** One agent conversation: personal AI, a channel, or a standard chat. State resets per scope. */
export function Conversation(props: ConversationProps) {
  return <ConversationScope key={props.scope} {...props} />;
}
