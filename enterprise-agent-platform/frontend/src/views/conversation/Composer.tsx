import { useEffect, useRef, useState } from "react";
import { request } from "../../api";
import PromptBar, { type PromptCommand } from "../../components/ui/beautiful/primitives/PromptBar";
import { useWords } from "../../words";
import { formatBytes } from "./Attachments";
import { uploadPath } from "./routes";
import type { Attachment } from "./types";
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

export interface ComposerProps {
  /** resolves the conversation scope uploads go to (a new chat creates its conversation here) */
  ensureScope: () => Promise<string>;
  onSend: (content: string, attachmentIds: number[]) => Promise<void>;
  /** the agent is working on this conversation */
  working?: boolean;
  onStop?: () => Promise<unknown>;
  /** accepted messages still waiting their FIFO turn */
  queued?: number;
  commands?: ComposerCommand[];
  placeholder: string;
  /** replaces the draft whenever `seed.n` changes (resend with attachments) */
  seed?: { text: string; n: number } | null;
}

export function Composer({
  ensureScope, onSend, working = false, onStop, queued = 0, commands = [], placeholder, seed,
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
    setText(seed.text);
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

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    setError("");
    try {
      await onSend(text.trim(), ready);
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

  const status = error ? <span className="text-red" role="alert">{error}</span>
    : queued > 0 ? w(
      `${queued} queued — messages run in order after the current reply`,
      `${queued} 条排队中，将在当前回复后依次处理`,
      `${queued} 則排隊中，將在目前回覆後依序處理`,
    ) : null;

  return (
    <PromptBar
      tall
      placeholder={placeholder}
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
      onSend={() => void submit()}
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
      }}
    />
  );
}
