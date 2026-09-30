import { useRef, useState } from "react";
import { request } from "../../api";
import { Button } from "../../components/ui/beautiful";
import { ComposerFrame, Glyph, Spinner } from "../../components/ui/fieldwork";
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

export interface ComposerProps {
  scope: string;
  busy: boolean;
  onSend: (content: string, attachmentIds: number[]) => Promise<void>;
  onCancel: () => Promise<unknown>;
}

export function Composer({ scope, busy, onSend, onCancel }: ComposerProps) {
  const w = useWords();
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  const uploading = uploads.some((upload) => !upload.attachment && !upload.error);
  const ready = uploads.flatMap((upload) => (upload.attachment ? [upload.attachment.id] : []));
  const canSend = !sending && !uploading && (text.trim() !== "" || ready.length > 0);

  const upload = (files: FileList) => {
    for (const file of Array.from(files)) {
      const key = nextKey.current++;
      setUploads((current) => [...current, { key, name: file.name, attachment: null, error: "" }]);
      const body = new FormData();
      body.append("file", file);
      request<{ attachment: Attachment }>(uploadPath(scope), { method: "POST", body })
        .then(({ attachment }) => setUploads((current) => current.map((item) => (item.key === key ? { ...item, attachment } : item))))
        .catch((reason: unknown) => setUploads((current) => current.map((item) => (item.key === key ? { ...item, error: errorText(reason) } : item))));
    }
  };

  const submit = async (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
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
    setStopping(true);
    try {
      await onCancel();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setStopping(false);
    }
  };

  const label = w("Message", "消息", "訊息");
  return (
    <form onSubmit={submit}>
      <ComposerFrame
        label={w("Compose message", "撰写消息", "撰寫訊息")}
        recovery={error ? <div className="cv-error-text" role="alert">{error}</div> : undefined}
        attachments={uploads.length ? (
          <ul className="cv-chips" aria-label={w("Attached files", "已附加文件", "已附加檔案")}>
            {uploads.map((item) => (
              <li key={item.key} className="cv-chip" data-error={item.error ? "" : undefined}>
                {!item.attachment && !item.error ? <Spinner size={12} /> : <Glyph name={item.error ? "warning" : "file"} size={14} />}
                <span className="cv-chip-name">{item.name}</span>
                <span className="cv-chip-meta">{item.error || (item.attachment ? formatBytes(item.attachment.size_bytes) : w("Uploading…", "上传中…", "上傳中…"))}</span>
                <button type="button" className="cv-chip-remove" aria-label={`${w("Remove", "移除", "移除")} ${item.name}`}
                  onClick={() => setUploads((current) => current.filter((other) => other.key !== item.key))}>
                  <Glyph name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : undefined}
        input={
          <textarea
            className="cv-input"
            aria-label={label}
            placeholder={w("Message the agent", "给智能体发消息", "傳訊息給智慧體")}
            rows={1}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        }
        startActions={
          <>
            <input ref={fileInput} type="file" multiple hidden onChange={(event) => { if (event.target.files) upload(event.target.files); event.target.value = ""; }} data-testid="composer-file" />
            <Button type="button" variant="quiet" size="sm" className="cv-icon-button" aria-label={w("Attach files", "添加附件", "新增附件")} onClick={() => fileInput.current?.click()}>
              <Glyph name="attach" size={16} />
            </Button>
          </>
        }
        status={busy ? w("New messages run after the current reply", "新消息将在当前回复后处理", "新訊息將在目前回覆後處理") : undefined}
        submitAction={
          <>
            {busy && (
              <Button type="button" variant="secondary" size="sm" disabled={stopping} onClick={() => void stop()}>
                {w("Stop", "停止", "停止")}
              </Button>
            )}
            <Button type="submit" variant="primary" size="sm" className="cv-icon-button" aria-label={w("Send", "发送", "傳送")} disabled={!canSend}>
              {sending ? <Spinner size={14} /> : <Glyph name="arrowUp" size={16} />}
            </Button>
          </>
        }
        hint={<span>{w("Enter to send · Shift+Enter for a new line", "Enter 发送 · Shift+Enter 换行", "Enter 傳送 · Shift+Enter 換行")}</span>}
      />
    </form>
  );
}
