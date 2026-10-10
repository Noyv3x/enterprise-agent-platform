import { useEffect, useRef, useState } from "react";
import { request } from "../../api";
import PromptBar, { clipboardFiles, type PromptCommand, type PromptSendOption } from "../../components/ui/beautiful/primitives/PromptBar";
import { useWords } from "../../words";
import { formatBytes } from "./Attachments";
import { uploadPath } from "./routes";
import type { Attachment, SendMode } from "./types";
import { errorText } from "./useConversation";

interface Upload {
  key: number;
  name: string;
  attachment: Attachment | null;
  error: string;
}

export interface ComposerCommand extends PromptCommand {
  run: () => void;
}

/** Text (and files) put back into the composer. `prepend` keeps the current draft below it (a withdrawn message);
 * otherwise it replaces the draft (resend, starters). */
export interface ComposerSeed {
  text: string;
  attachments?: Attachment[];
  prepend?: boolean;
  n: number;
}

export interface ComposerProps {
  /** resolves the conversation scope uploads go to (a new chat creates its conversation here) */
  ensureScope: () => Promise<string>;
  /** `mode` is set only while the running turn can take an inserted message */
  onSend: (content: string, attachmentIds: number[], mode?: SendMode) => Promise<void>;
  /** the agent is working on this conversation */
  working?: boolean;
  onStop?: () => Promise<unknown>;
  /** accepted messages still waiting their FIFO turn */
  queued?: number;
  /** this interactive turn can receive a message after its current step: Enter inserts, Alt+Enter sends after the turn */
  inserting?: boolean;
  pendingInputs?: number;
  commands?: ComposerCommand[];
  placeholder: string;
  /** applied whenever `seed.n` changes */
  seed?: ComposerSeed | null;
}

export function Composer({
  ensureScope, onSend, working = false, onStop, queued = 0, inserting = false, pendingInputs = 0, commands = [], placeholder, seed,
}: ComposerProps) {
  const w = useWords();
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const nextKey = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!seed) return;
    setText((current) => (seed.prepend && current.trim() ? (seed.text ? `${seed.text}\n\n${current}` : current) : seed.text));
    const restored = seed.attachments ?? [];
    if (restored.length) {
      setUploads((current) => [
        ...current,
        ...restored
          .filter((attachment) => !current.some((item) => item.attachment?.id === attachment.id))
          .map((attachment) => ({ key: nextKey.current++, name: attachment.filename, attachment, error: "" })),
      ]);
    }
    input.current?.focus();
  }, [seed]);

  const uploading = uploads.some((upload) => !upload.attachment && !upload.error);
  const ready = uploads.flatMap((upload) => (upload.attachment ? [upload.attachment.id] : []));
  const canSend = !sending && !uploading && (text.trim() !== "" || ready.length > 0);

  const upload = (files: File[]) => {
    setError("");
    for (const file of files) {
      const key = nextKey.current++;
      setUploads((current) => [...current, { key, name: file.name, attachment: null, error: "" }]);
      const body = new FormData();
      body.append("file", file);
      ensureScope()
        .then((scope) => request<{ attachment: Attachment }>(uploadPath(scope), { method: "POST", body }))
        .then(({ attachment }) => setUploads((current) => current.map((item) => (item.key === key ? { ...item, attachment } : item))))
        .catch((reason: unknown) => setUploads((current) => current.map((item) => (item.key === key ? { ...item, error: errorText(reason) } : item))));
    }
  };

  // Files pasted while focus is elsewhere in the conversation (not another text field or a dialog) attach here.
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog']")) return;
      const files = clipboardFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      uploadRef.current(files);
      input.current?.focus();
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const submit = async (mode?: SendMode) => {
    if (!canSend) return;
    setSending(true);
    setError("");
    try {
      await onSend(text.trim(), ready, inserting ? mode ?? "insert" : undefined);
      setText("");
      setUploads([]);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!onStop) return;
    setStopping(true);
    try {
      await onStop();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setStopping(false);
    }
  };

  const count = queued > 0 ? w(
    `${queued} queued — messages run in order after the current reply`,
    `${queued} 条排队中，将在当前回复后依次处理`,
    `${queued} 則排隊中，將在目前回覆後依序處理`,
  ) : pendingInputs > 0 ? w(
    `${pendingInputs} ${pendingInputs === 1 ? "message" : "messages"} waiting for the current step to finish`,
    `${pendingInputs} 条补充消息等待当前步骤结束`,
    `${pendingInputs} 則補充訊息等待目前步驟結束`,
  ) : null;
  const sendOptions: PromptSendOption[] = inserting ? [
    { key: "insert", label: w("Add to this turn", "插入当前任务", "插入目前任務"), shortcut: "enter" },
    { key: "after_turn", label: w("Send after this turn", "本轮结束后发送", "本輪結束後傳送"), shortcut: "alt-enter" },
  ] : [];
  // Keyboards get both shortcuts; touch screens have no Alt+Enter and use the menu beside send instead.
  const modes = inserting ? (
    <>
      <span className="touch:hidden">{w("Enter adds to this turn · Alt+Enter sends after it", "Enter 插入当前任务 · Alt+Enter 本轮结束后发送", "Enter 插入目前任務 · Alt+Enter 本輪結束後傳送")}</span>
      <span className="hidden touch:inline">{w("Send adds to this turn · tap ⌄ to send after it", "发送即插入当前任务 · 点按 ⌄ 可在本轮结束后发送", "傳送即插入目前任務 · 點按 ⌄ 可在本輪結束後傳送")}</span>
    </>
  ) : null;
  const status = error ? <span className="text-red" role="alert">{error}</span>
    : count && modes ? <span className="flex flex-wrap gap-x-3">{count}<span>{modes}</span></span>
      : count ?? modes;

  return (
    <PromptBar
      tall
      placeholder={inserting ? w("Add a message to this run…", "补充消息，加入当前任务…", "補充訊息，加入目前任務…") : placeholder}
      draft={text}
      onDraftChange={setText}
      inputRef={input}
      attachments={uploads.map((item) => ({
        key: item.key,
        name: item.name,
        state: item.error ? "error" : item.attachment ? "ready" : "uploading",
        detail: item.error || (item.attachment ? formatBytes(item.attachment.size_bytes) : w("Uploading…", "上传中…", "上傳中…")),
      }))}
      onAttach={upload}
      onRemoveAttachment={(key) => setUploads((current) => current.filter((item) => item.key !== key))}
      commands={commands}
      onCommand={(key) => commands.find((command) => command.key === key)?.run()}
      canSend={canSend}
      onSend={(option) => void submit(option === "after_turn" ? "after_turn" : undefined)}
      sendOptions={sendOptions}
      working={working}
      onStop={onStop ? () => void stop() : undefined}
      stopping={stopping}
      status={status}
      labels={{
        prompt: w("Message", "消息", "訊息"),
        attach: w("Attach files", "添加附件", "新增附件"),
        remove: (name) => `${w("Remove", "移除", "移除")} ${name}`,
        chooseModel: w("Model", "模型", "模型"),
        send: w("Send", "发送", "傳送"),
        stop: w("Stop", "停止", "停止"),
        commandsHint: w("Commands", "命令", "命令"),
        noMatches: (query) => w(`No commands match “${query}”`, `没有匹配“${query}”的命令`, `沒有符合「${query}」的命令`),
        dropFiles: w("Drop files to attach", "松开以添加附件", "放開以新增附件"),
        sendOptions: w("Send options", "发送方式", "傳送方式"),
      }}
    />
  );
}
