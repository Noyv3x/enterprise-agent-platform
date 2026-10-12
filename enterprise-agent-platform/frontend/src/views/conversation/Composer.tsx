import { useEffect, useRef, useState } from "react";
import { request, type McpPrompt, type SkillList, type SkillView } from "../../api";
import PromptBar, { clipboardFiles, type PromptCommand, type PromptSendOption } from "../../components/ui/beautiful/primitives/PromptBar";
import { useWords } from "../../words";
import { feedbackLabel, type FeedbackItem } from "../artifacts/feedback";
import { formatBytes } from "./Attachments";
import { loadMcpCatalog } from "./mcpCatalog";
import { McpPromptDialog, promptFailure, renderMcpPrompt } from "./McpPromptDialog";
import { uploadPath } from "./routes";
import type { Attachment, SendMode } from "./types";
import { errorText } from "./useConversation";

const PROMPT_KEY = "mcp-prompt:";

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
  /** the scope of the `/` menu's catalogs: `private`, `chat` or `channel-<id>`. It lists the scope's skills (`GET
   * /api/skills`; picking one puts `/<name> ` at the start of the message) and its MCP prompts (`GET
   * /api/mcp/prompts`, as `/<connector>:<prompt>`; picking one asks for its arguments and inserts the rendered text) */
  catalogScope?: string;
  placeholder: string;
  /** applied whenever `seed.n` changes */
  seed?: ComposerSeed | null;
  /** 圈选反馈 waiting to be sent: each a screenshot chip and a context chip. `onSend` sends them; the composer only shows
   * them, waits for screenshots being captured, and removes one on request. */
  feedback?: { items: FeedbackItem[]; remove: (key: string, part: "item" | "shot") => void };
}

export function Composer({
  ensureScope, onSend, working = false, onStop, queued = 0, inserting = false, pendingInputs = 0, commands = [], catalogScope, placeholder, seed, feedback,
}: ComposerProps) {
  const w = useWords();
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [prompts, setPrompts] = useState<McpPrompt[]>([]);
  /** the prompt whose argument form is open */
  const [picked, setPicked] = useState<McpPrompt | null>(null);
  const [rendering, setRendering] = useState(false);
  const nextKey = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  // Without the catalogs the menu still offers the commands; Platform reads `/name` whether or not it was picked here.
  useEffect(() => {
    setSkills([]);
    setPrompts([]);
    if (!catalogScope) return;
    let current = true;
    request<SkillList>(`/api/skills?scope=${encodeURIComponent(catalogScope)}`)
      .then((list) => { if (current) setSkills(list.skills.filter((skill) => skill.enabled)); })
      .catch(() => {});
    loadMcpCatalog(catalogScope)
      .then((catalog) => { if (current) setPrompts(catalog.prompts); })
      .catch(() => {});
    return () => { current = false; };
  }, [catalogScope]);
  const skillTag = w("Skill", "技能", "技能");
  const menu: PromptCommand[] = [
    ...commands,
    ...skills.map((skill) => ({ key: `skill:${skill.key}`, name: `/${skill.name}`, desc: skill.description, insert: `/${skill.name} `, leading: true, tag: skillTag })),
    ...prompts.map((prompt, index) => ({
      key: `${PROMPT_KEY}${index}`, name: `/${prompt.connector}:${prompt.name}`, desc: prompt.description || prompt.title || "", tag: prompt.connector_label,
    })),
  ];

  /** The rendered prompt joins the draft below what is already written; the person reviews it before sending. */
  const insertPrompt = (rendered: string) => {
    setPicked(null);
    setText((current) => (current.trim() ? `${current.trimEnd()}\n\n${rendered}` : rendered));
    input.current?.focus();
  };
  const pickPrompt = (prompt: McpPrompt) => {
    if (prompt.arguments.length) {
      setPicked(prompt);
      return;
    }
    if (!catalogScope) return;
    setRendering(true);
    setError("");
    renderMcpPrompt(catalogScope, prompt, {})
      .then(insertPrompt, (reason: unknown) => setError(promptFailure(reason, prompt, w)))
      .finally(() => setRendering(false));
  };

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

  const feedbackItems = feedback?.items ?? [];
  const uploading = uploads.some((upload) => !upload.attachment && !upload.error) || feedbackItems.some((item) => item.shot?.state === "capturing");
  const ready = uploads.flatMap((upload) => (upload.attachment ? [upload.attachment.id] : []));
  const canSend = !sending && !uploading && (text.trim() !== "" || ready.length > 0 || feedbackItems.length > 0);

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
    : rendering ? <span role="status">{w("Loading the prompt…", "正在获取提示词…", "正在取得提示詞…")}</span>
      : count && modes ? <span className="flex flex-wrap gap-x-3">{count}<span>{modes}</span></span>
        : count ?? modes;
  // The menu's name for what it lists, e.g. 命令、技能和提示词.
  const catalog = skills.length && prompts.length ? w("commands, skills and prompts", "命令、技能和提示词", "命令、技能和提示詞")
    : skills.length ? w("commands and skills", "命令和技能", "命令和技能")
      : prompts.length ? w("commands and prompts", "命令和提示词", "命令和提示詞") : w("commands", "命令", "命令");

  return (
    <>
      <PromptBar
        tall
        placeholder={inserting ? w("Add a message to this run…", "补充消息，加入当前任务…", "補充訊息，加入目前任務…") : placeholder}
        draft={text}
        onDraftChange={setText}
        inputRef={input}
        attachments={[
          ...uploads.map((item) => ({
            key: item.key,
            name: item.name,
            state: item.error ? "error" as const : item.attachment ? "ready" as const : "uploading" as const,
            detail: item.error || (item.attachment ? formatBytes(item.attachment.size_bytes) : w("Uploading…", "上传中…", "上傳中…")),
          })),
          ...feedbackItems.flatMap((item) => {
            const label = feedbackLabel(item.feedback, w, item.tag);
            const { shot } = item;
            return [
              { key: `context:${item.key}`, name: label, state: "ready" as const, context: true },
              ...(shot ? [{
                key: `shot:${item.key}`,
                name: w(`Screenshot · ${label}`, `截图 · ${label}`, `截圖 · ${label}`),
                state: shot.state === "capturing" ? "uploading" as const : shot.state,
                detail: shot.state === "error" ? shot.error : shot.state === "capturing" ? w("Capturing…", "正在截图…", "正在截圖…") : undefined,
                thumb: shot.state === "ready" ? shot.attachment.preview_url ?? undefined : undefined,
              }] : []),
            ];
          }),
        ]}
        onAttach={upload}
        onRemoveAttachment={(key) => {
          if (typeof key === "number") setUploads((current) => current.filter((item) => item.key !== key));
          else if (key.startsWith("shot:")) feedback?.remove(key.slice(5), "shot");
          else if (key.startsWith("context:")) feedback?.remove(key.slice(8), "item");
        }}
        commands={menu}
        onCommand={(key) => {
          if (key.startsWith(PROMPT_KEY)) {
            const prompt = prompts[Number(key.slice(PROMPT_KEY.length))];
            if (prompt) pickPrompt(prompt);
          } else commands.find((command) => command.key === key)?.run();
        }}
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
          commandsHint: catalog.charAt(0).toUpperCase() + catalog.slice(1),
          noMatches: (query) => w(`Nothing matches “${query}”`, `没有匹配“${query}”的${catalog}`, `沒有符合「${query}」的${catalog}`),
          dropFiles: w("Drop files to attach", "松开以添加附件", "放開以新增附件"),
          sendOptions: w("Send options", "发送方式", "傳送方式"),
        }}
      />
      {picked && catalogScope && (
        <McpPromptDialog prompt={picked} scope={catalogScope} onInsert={insertPrompt} onClose={() => { setPicked(null); input.current?.focus(); }} />
      )}
    </>
  );
}
