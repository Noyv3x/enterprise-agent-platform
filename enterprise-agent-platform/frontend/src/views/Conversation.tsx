import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/ui/beautiful/atoms/Button";
import { StatusPill } from "../components/ui/beautiful/atoms/StatusPill";
import { ConfirmDialog, Icon, Menu, NavigationButton, Notice, Sheet, WindowAside, useShell, type MenuItem } from "../components/ui/beautiful/controls";
import LoadingState from "../components/ui/beautiful/primitives/LoadingState";
import type { PromptModel } from "../components/ui/beautiful/primitives/PromptBar";
import { useWords } from "../words";
import { Composer, type ComposerCommand } from "./conversation/Composer";
import { ComputerBody } from "./conversation/Computer";
import { AssistantMessage, LiveReply, PendingReply, SystemLine, UserBubble } from "./conversation/Messages";
import type { Compaction, Message } from "./conversation/types";
import { errorText, useConversation } from "./conversation/useConversation";

/** Reader within this distance of the bottom keeps following new output (harness value). */
const STICK_PX = 120;

export interface ConversationModel {
  models: PromptModel[];
  value: string;
  onChange: (model: string) => Promise<unknown>;
  /** e.g. the current model is no longer allowed */
  notice?: ReactNode;
  /** sending is blocked until the notice is resolved */
  blocked?: boolean;
}

export interface ConversationProps {
  /** `private`, `channel-<id>` or `chat-<uuid>` (API route form). */
  scope: string;
  title?: ReactNode;
  /** quiet text next to the title, e.g. the chat model */
  meta?: ReactNode;
  /** extra header controls */
  actions?: ReactNode;
  /** extra rows for the header menu (chat rename/delete) */
  menuItems?: MenuItem[];
  /** chat model picker in the composer */
  model?: ConversationModel;
  /** Called after each finished agent run (chat titles may change). */
  onRunEnd?: () => void;
  /** False for read-only viewers (e.g. channel readers without chat permission): no composer or conversation mutations. */
  canSend?: boolean;
  /** the signed-in user: their channel messages sit on the right */
  userId?: number;
  /** greets the user in the empty state */
  userName?: string;
}


/** Where the manual compaction sits in the loaded thread: after a message id, at the start (it preceded every
 * message), at the end (queued, place not known yet), or nowhere (settled without a recorded place, placed in
 * history not loaded yet, or its history was reset away). */
function compactionPlacement(compaction: Compaction | null, messages: Message[], oldestLoaded: boolean): number | "start" | "end" | null {
  if (!compaction) return null;
  const anchor = compaction.after_message_id;
  if (anchor === undefined) return compaction.status === "queued" || compaction.status === "compacting" ? "end" : null;
  if (anchor === null) return oldestLoaded ? "start" : null;
  let after: number | null = null;
  for (const message of messages) if (message.id <= anchor) after = message.id;
  return after;
}

function CompactionRow({ compaction }: { compaction: Compaction }) {
  const w = useWords();
  const settled = {
    done: { icon: "check" as const, text: w("Context compacted — older turns are summarized", "上下文已压缩，较早的对话已总结", "上下文已壓縮，較早的對話已總結") },
    nothing_to_compact: { icon: "check" as const, text: w("Nothing to compact — the conversation is still short", "无需压缩，对话还较短", "無需壓縮，對話還較短") },
  };
  let body: ReactNode;
  if (compaction.status === "queued" || compaction.status === "compacting") {
    body = (
      <LoadingState
        variant="Dots"
        label={compaction.status === "queued"
          ? w("Compaction queued — runs after earlier work", "压缩已排队，将在先前任务完成后进行", "壓縮已排隊，將在先前任務完成後進行")
          : w("Compacting context", "正在压缩上下文", "正在壓縮上下文")}
      />
    );
  } else if (compaction.status === "done" || compaction.status === "nothing_to_compact") {
    const { icon, text } = settled[compaction.status];
    body = <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2"><Icon name={icon} size={14} />{text}</span>;
  } else {
    body = (
      <span className="flex flex-wrap items-center justify-center gap-2 text-[12.5px] text-ink-2">
        <StatusPill tone={compaction.status === "interrupted" ? "orange" : "neutral"} className="h-5.5 text-[12px]">
          {compaction.status === "interrupted" ? w("Compaction interrupted", "压缩已中断", "壓縮已中斷") : w("Compaction cancelled", "压缩已取消", "壓縮已取消")}
        </StatusPill>
        {compaction.error}
      </span>
    );
  }
  return (
    <div role="status" aria-label={w("Context compaction", "上下文压缩", "上下文壓縮")} className="flex items-center gap-3">
      <span aria-hidden className="h-px flex-1 bg-line" />
      {body}
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Harness empty state: greeting, the tall composer, and a few starting points that fill the draft. */
function Welcome({ empty, thread, composerRef, eyebrow, question, composer, starters, onStarter }: {
  empty: boolean;
  thread: ReactNode;
  composerRef: React.RefObject<HTMLDivElement | null>;
  eyebrow: string;
  question: string;
  composer: ReactNode;
  starters: { key: string; label: string; icon: ReactNode }[];
  onStarter: (text: string) => void;
}) {
  return (
    <div className={empty ? "mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col justify-center overflow-y-auto px-4 py-10 sm:px-8" : "relative flex min-h-0 flex-1 flex-col"}>
      {thread}
      {empty && <h1 className="text-[26px] font-normal tracking-[-0.02em] text-ink" style={{ animation: "fade-up 450ms cubic-bezier(0.16,1,0.3,1) both" }}>
        <span className="block text-ink-3">{eyebrow}</span>
        <span className="block">{question}</span>
      </h1>}
      <div ref={composerRef} className={empty ? "relative mt-7" : "absolute inset-x-0 bottom-0 px-4 pb-4 sm:px-8 sm:pb-6"}>
        <div className="mx-auto max-w-[720px]">{composer}</div>
      </div>
      {empty && starters.length > 0 && (
        <div className="mt-6 flex flex-col" style={{ animation: "fade-up 450ms cubic-bezier(0.16,1,0.3,1) 240ms both" }}>
          {starters.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onStarter(item.label)}
              className="-mx-2 flex items-center gap-3 rounded-control px-2 py-2.5 text-left text-[14px] text-ink transition-colors duration-150 hover:bg-hover touch:min-h-11"
            >
              <span className="text-ink-3">{item.icon}</span>
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const starterIcon = (path: ReactNode) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{path}</svg>
);

function ConversationScope({ scope, title, meta, actions, menuItems = [], model, onRunEnd, canSend = true, userId, userName }: ConversationProps) {
  const w = useWords();
  const { narrow } = useShell();
  const conversation = useConversation(scope, onRunEnd);
  const [computerOpen, setComputerOpen] = useState(scope === "private" && !narrow);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [seed, setSeed] = useState<{ text: string; n: number } | null>(null);
  const [composerHeight, setComposerHeight] = useState(150);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const composerBox = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const restoreFrom = useRef<number | null>(null);
  const runningSeen = useRef(new Map<number, number>());

  const { messages, live, phase } = conversation;
  const personal = scope === "private";
  const channel = scope.startsWith("channel-");
  const resettable = canSend && !scope.startsWith("chat-");
  const compactionAt = compactionPlacement(conversation.compaction, messages, conversation.nextBefore === null);
  const compactionRow = conversation.compaction && compactionAt !== null ? <CompactionRow compaction={conversation.compaction} /> : null;
  const empty = phase === "ready" && messages.length === 0 && !live && !compactionRow;

  // Keep the reading position when older history is prepended.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || restoreFrom.current === null) return;
    node.scrollTop += node.scrollHeight - restoreFrom.current;
    restoreFrom.current = null;
  }, [messages]);

  /* Content grows after it is committed (streaming, expanding traces, late images). A reader pinned to the bottom
   * keeps following; a reader scrolled up keeps their place. Settling is immediate, never animated. */
  useEffect(() => {
    const node = scroller.current;
    const inner = content.current;
    if (!node || !inner) return;
    let frame = 0;
    const pin = () => {
      if (!stick.current || restoreFrom.current !== null) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        node.scrollTop = node.scrollHeight;
      });
    };
    node.scrollTop = node.scrollHeight;
    const resize = new ResizeObserver(pin);
    resize.observe(inner);
    const mutate = new MutationObserver(pin);
    mutate.observe(inner, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutate.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [phase, empty]);

  /* the composer floats over the thread, so the thread pads its bottom by the composer's height */
  useEffect(() => {
    const node = composerBox.current;
    if (!node) return;
    const measure = () => setComposerHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [phase, empty, canSend]);

  const loadOlder = async () => {
    setLoadingOlder(true);
    restoreFrom.current = scroller.current?.scrollHeight ?? null;
    try {
      await conversation.loadOlder();
    } catch (reason) {
      restoreFrom.current = null;
      setNotice({ tone: "danger", text: errorText(reason) });
    } finally {
      setLoadingOlder(false);
    }
  };

  const compact = async () => {
    setNotice(null);
    stick.current = true;
    try {
      await conversation.compact();
    } catch (reason) {
      setNotice({ tone: "danger", text: errorText(reason) });
    }
  };

  const reset = async () => {
    setResetting(true);
    setNotice(null);
    try {
      await conversation.reset();
      setConfirmingReset(false);
      setNotice({ tone: "success", text: w("Conversation reset — the agent starts fresh", "对话已重置，智能体将重新开始", "對話已重置，智慧體將重新開始") });
    } catch (reason) {
      setNotice({ tone: "danger", text: errorText(reason) });
      setConfirmingReset(false);
    } finally {
      setResetting(false);
    }
  };

  const send = async (text: string, attachmentIds: number[]) => {
    stick.current = true;
    await conversation.send(text, attachmentIds);
  };

  const resend = (request: Message) => {
    // Bound attachments cannot be re-sent; put the text back so the person re-attaches deliberately.
    if (request.attachments.length || !request.content.trim()) {
      setSeed((current) => ({ text: request.content, n: (current?.n ?? 0) + 1 }));
      return;
    }
    return send(request.content, []).catch((reason: unknown) => setNotice({ tone: "danger", text: errorText(reason) }));
  };

  // FIFO positions: the running request first, then queued ones in order.
  const queuedMessages = messages.filter((message) => message.role === "user" && message.metadata.status === "queued");
  const running = messages.find((message) => message.role === "user" && message.metadata.status === "running");
  if (running && !runningSeen.current.has(running.id)) runningSeen.current.set(running.id, Date.now());
  const positions = new Map(queuedMessages.map((message, index) => [message.id, index + 1 + (running ? 1 : 0)]));

  const commands: ComposerCommand[] = canSend ? [
    {
      key: "compact", name: "/compact",
      desc: w("Summarize older turns so long conversations stay fast", "总结较早的对话，让长对话保持流畅", "總結較早的對話，讓長對話保持流暢"),
      run: () => {
        if (!conversation.compactBusy) void compact();
      },
    },
    ...(resettable ? [{
      key: "reset", name: "/reset",
      desc: w("Start a fresh agent session for this conversation", "为此对话开始新的智能体会话", "為此對話開始新的智慧體工作階段"),
      run: () => setConfirmingReset(true),
    }] : []),
  ] : [];

  const items: MenuItem[] = [
    ...menuItems,
    ...(canSend ? [{
      key: "compact", label: w("Compact context", "压缩上下文", "壓縮上下文"),
      icon: <Icon name="history" size={16} />, disabled: conversation.compactBusy || phase !== "ready", onSelect: () => void compact(),
    }] : []),
    ...(resettable ? [{
      key: "reset", label: w("Reset conversation…", "重置对话…", "重置對話…"), tone: "danger" as const,
      icon: <Icon name="refresh" size={16} />, disabled: conversation.busy || phase !== "ready", onSelect: () => setConfirmingReset(true),
    }] : []),
  ];

  const defaultTitle = personal ? w("Personal AI", "个人 AI", "個人 AI")
    : scope.startsWith("chat-") ? w("Chat", "聊天", "聊天") : w("Channel", "频道", "頻道");
  const computerLabel = w("Computer", "电脑", "電腦");

  const header = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 sm:pl-4 touch:h-14">
      <NavigationButton />
      <h1 className="min-w-0 truncate text-[13px] font-semibold text-ink">{title ?? defaultTitle}</h1>
      {meta && <span className="min-w-0 shrink truncate text-[12px] text-ink-2">{meta}</span>}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 text-ink-3">
        {actions}
        {personal && (
          <button
            type="button"
            aria-pressed={computerOpen}
            onClick={() => setComputerOpen(!computerOpen)}
            className={`flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[12.5px] font-medium transition-colors duration-100 touch:h-11 ${
              computerOpen ? "bg-hover-2 text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
            }`}
          >
            <Icon name="monitor" size={15} />
            {computerLabel}
          </button>
        )}
        {items.length > 0 && (
          <Menu
            label={w("Conversation actions", "对话操作", "對話操作")}
            align="end"
            width={220}
            items={items}
            trigger={(props) => (
              <button {...props} type="button" aria-label={w("Conversation actions", "对话操作", "對話操作")}
                className="flex size-7 items-center justify-center rounded-[6px] transition-colors duration-100 hover:bg-hover hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink touch:size-11">
                <Icon name="more" size={16} />
              </button>
            )}
          />
        )}
      </div>
    </div>
  );

  const composer = canSend ? (
    <Composer
      ensureScope={async () => scope}
      onSend={send}
      working={conversation.busy}
      onStop={conversation.cancel}
      queued={queuedMessages.length}
      commands={commands}
      models={model?.models}
      model={model?.value}
      onModelChange={model?.onChange}
      modelDisabled={conversation.busy}
      notice={model?.notice}
      blocked={model?.blocked}
      seed={seed}
      placeholder={empty && personal
        ? w("Ask your agent to research, write files or run code…", "让智能体查资料、写文件或运行代码…", "讓智慧體查資料、寫檔案或執行程式…")
        : w("Write a message…", "输入消息…", "輸入訊息…")}
    />
  ) : (
    <div className="flex items-center gap-2.5 rounded-[14px] border border-line bg-surface px-4 py-3 text-[13px] text-ink-2 shadow-card">
      <Icon name="lock" size={16} />
      {w("You can read this conversation but not post in it.", "你可以查看此对话，但不能发言。", "你可以檢視此對話，但不能發言。")}
    </div>
  );

  const noticeBar = notice && (
    <div className="mx-auto w-full max-w-[720px] px-4 pt-3 sm:px-8">
      <Notice tone={notice.tone} title={notice.text}
        action={<Button variant="quiet" size="xs" onClick={() => setNotice(null)}>{w("Dismiss", "关闭", "關閉")}</Button>} />
    </div>
  );

  let body: ReactNode;
  if (phase === "loading") {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <LoadingState variant="Dots" label={w("Loading conversation", "正在加载对话", "正在載入對話")} />
      </div>
    );
  } else if (phase === "error") {
    body = (
      <div className="mx-auto w-full max-w-[720px] px-4 py-10 sm:px-8">
        <Notice tone="danger" title={w("The conversation could not be loaded", "无法加载对话", "無法載入對話")}
          action={<Button variant="secondary" size="sm" onClick={() => void conversation.reload()}>{w("Retry", "重试", "重試")}</Button>}>
          {conversation.error}
        </Notice>
      </div>
    );
  } else {
    const starters = !canSend ? [] : personal ? [
      { key: "research", label: w("Research a topic and write a short report", "调研一个主题并写一份简短报告", "研究一個主題並寫一份簡短報告"), icon: starterIcon(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>) },
      { key: "browse", label: w("Open a website and summarize what it says", "打开一个网页并总结其内容", "開啟一個網頁並總結其內容"), icon: starterIcon(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>) },
      { key: "files", label: w("Analyze a file I attach", "分析我附上的文件", "分析我附上的檔案"), icon: starterIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>) },
    ] : [];
    const welcomeProps = {
      eyebrow: personal ? (userName ? w(`Hello ${userName}`, `你好，${userName}`, `你好，${userName}`) : defaultTitle) : String(title ?? defaultTitle),
      question: personal ? w("What can I help you with?", "今天要做什么？", "今天要做什麼？")
        : canSend ? w("Start the conversation — the agent answers everyone here", "开始对话，智能体会回复这里的每个人", "開始對話，智慧體會回覆這裡的每個人")
          : w("No messages yet", "还没有消息", "還沒有訊息"),
      starters,
      onStarter: (text: string) => setSeed((current) => ({ text, n: (current?.n ?? 0) + 1 })),
    };
    const lastRunning = running ? runningSeen.current.get(running.id) ?? Date.now() : null;
    const firstQueued = queuedMessages[0];
    const thread = empty ? noticeBar : (
      <>
        <div
          ref={scroller}
          role="log"
          aria-label={w("Conversation", "对话", "對話")}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onScroll={(event) => {
            const node = event.currentTarget;
            const near = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX;
            stick.current = near;
            if (near !== atBottom) setAtBottom(near);
          }}
        >
          {noticeBar}
          <div ref={content} className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-4 pt-8 sm:px-8" style={{ paddingBottom: composerHeight + 16 }}>
            {conversation.nextBefore !== null && (
              <div className="flex justify-center">
                <Button variant="secondary" size="xs" disabled={loadingOlder} onClick={() => void loadOlder()}>
                  {w("Load earlier messages", "加载更早的消息", "載入更早的訊息")}
                </Button>
              </div>
            )}
            {compactionAt === "start" && compactionRow}
            {messages.map((message) => {
              let entry: ReactNode;
              if (message.role === "user") {
                const mine = !channel || userId === undefined || message.metadata.author_user_id === userId;
                const retryable = message.metadata.status === "interrupted" || message.metadata.status === "cancelled";
                entry = (
                  <div>
                    <UserBubble message={message} showAuthor={channel} mine={mine} queuePosition={positions.get(message.id)} />
                    {canSend && retryable && (
                      <div className="mt-2 flex justify-end">
                        <Button variant="quiet" size="xs" onClick={() => void resend(message)}>{w("Send again", "重新发送", "重新傳送")}</Button>
                      </div>
                    )}
                  </div>
                );
              } else if (message.role === "system") entry = <SystemLine message={message} />;
              else entry = <AssistantMessage message={message} />;
              return (
                <Fragment key={message.id}>
                  {entry}
                  {compactionAt === message.id && compactionRow}
                </Fragment>
              );
            })}
            {live ? <LiveReply run={live} />
              : running ? <PendingReply since={lastRunning ?? Date.now()} queued={false} />
                : firstQueued ? <PendingReply since={Date.parse(firstQueued.created_at) || Date.now()} queued /> : null}
            {compactionAt === "end" && compactionRow}
          </div>
        </div>

        {/* soft fade so content dissolves into the bar instead of hard-clipping */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: composerHeight + 32, background: "linear-gradient(to top, var(--page) 64%, transparent)" }} />

        {!atBottom && (
          <button
            type="button"
            onClick={() => {
              const node = scroller.current;
              if (node) node.scrollTop = node.scrollHeight;
              stick.current = true;
              setAtBottom(true);
            }}
            className="absolute left-1/2 z-10 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full bg-surface px-3 text-[12px] font-medium text-ink-2 shadow-raised transition-colors duration-100 hover:text-ink touch:h-11"
            style={{ bottom: composerHeight + 8, animation: "fade-in 150ms ease-out both" }}
          >
            <Icon name="chevronDown" size={14} />
            {w("Jump to latest", "回到最新", "回到最新")}
          </button>
        )}
      </>
    );
    body = <Welcome {...welcomeProps} empty={empty} thread={thread} composerRef={composerBox} composer={composer} />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {header}
      {body}
      {personal && computerOpen && (narrow ? (
        <Sheet open onClose={() => setComputerOpen(false)} title={computerLabel} width={420}>
          <ComputerBody working={conversation.busy} />
        </Sheet>
      ) : (
        <WindowAside label={computerLabel} className="w-[380px]">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-3 sm:pl-4">
            <span className="text-[13px] font-semibold text-ink">{computerLabel}</span>
            <button type="button" aria-label={w("Close computer", "关闭电脑面板", "關閉電腦面板")} onClick={() => setComputerOpen(false)}
              className="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink touch:size-11">
              <Icon name="close" size={13} strokeWidth={2.2} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <ComputerBody working={conversation.busy} />
          </div>
        </WindowAside>
      ))}
      <ConfirmDialog
        open={confirmingReset}
        tone="danger"
        title={w("Reset this conversation?", "重置此对话？", "重置此對話？")}
        description={w("The agent starts a fresh session and no longer remembers this conversation's history. Messages stay visible. This cannot be undone.", "智能体将开始新的会话，不再记得此对话的历史，消息仍会保留显示。此操作无法撤销。", "智慧體將開始新的工作階段，不再記得此對話的歷史，訊息仍會保留顯示。此操作無法復原。")}
        confirmLabel={w("Reset conversation", "重置对话", "重置對話")}
        busy={resetting}
        onConfirm={() => void reset()}
        onCancel={() => setConfirmingReset(false)}
      />
    </div>
  );
}

/** One agent conversation: personal AI, a channel, or a standard chat. State resets per scope. */
export function Conversation(props: ConversationProps) {
  return <ConversationScope key={props.scope} {...props} />;
}
