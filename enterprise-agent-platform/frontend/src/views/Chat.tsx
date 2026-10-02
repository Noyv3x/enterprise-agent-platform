import { useRef, useState } from "react";
import { request } from "../api";
import { Button } from "../components/ui/beautiful/atoms/Button";
import { ConfirmDialog, Dialog, EmptyState, Icon, NavigationButton, Notice, TextField } from "../components/ui/beautiful/controls";
import LoadingState from "../components/ui/beautiful/primitives/LoadingState";
import { useWords } from "../words";
import { Conversation } from "./Conversation";
import { createChat, deleteChat, refreshChats, updateChat, useChats } from "./chat/chatStore";
import { Composer } from "./conversation/Composer";
import { conversationBase } from "./conversation/routes";
import type { ChatConversation, Message } from "./conversation/types";
import { errorText } from "./conversation/useConversation";

function ChatHeader({ title }: { title: string }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 sm:pl-4 touch:h-14">
      <NavigationButton />
      <h1 className="min-w-0 truncate text-[13px] font-semibold text-ink">{title}</h1>
    </div>
  );
}

/** `#chat`: the empty state and composer; the first send creates the conversation, then opens `#chat-<id>`. */
function NewChat({ userName }: { userName?: string }) {
  const w = useWords();
  const created = useRef<Promise<ChatConversation> | null>(null);

  // Uploads and the first send share one new conversation; it is created on first need, with
  // a title in the interface language (the server's default title is English).
  const ensure = () => {
    created.current ??= createChat({ title: w("New chat", "新聊天", "新聊天") }).catch((reason: unknown) => {
      created.current = null;
      throw reason;
    });
    return created.current;
  };

  const send = async (content: string, attachmentIds: number[]) => {
    const chat = await ensure();
    await request<{ message: Message; job_id: number }>(`${conversationBase(`chat-${chat.id}`)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, attachment_ids: attachmentIds }),
    });
    location.hash = `chat-${chat.id}`;
  };

  const untitled = w("New chat", "新聊天", "新聊天");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatHeader title={untitled} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-4 py-10 sm:px-8">
          <h1 className="text-[26px] font-normal tracking-[-0.02em] text-ink" style={{ animation: "fade-up 450ms cubic-bezier(0.16,1,0.3,1) both" }}>
            <span className="block text-ink-3">{userName ? w(`Hello ${userName}`, `你好，${userName}`, `你好，${userName}`) : untitled}</span>
            <span className="block">{w("What would you like to ask?", "想问点什么？", "想問點什麼？")}</span>
          </h1>
          <p className="mt-2 text-[13px] text-ink-2" style={{ animation: "fade-up 450ms cubic-bezier(0.16,1,0.3,1) 60ms both" }}>
            {w("Each chat keeps its own files and can search the web and run code.", "每个对话都有独立的文件，可以搜索网页和运行代码。", "每個對話都有獨立的檔案，可以搜尋網頁和執行程式。")}
          </p>
          <div className="relative mt-7" style={{ animation: "fade-up 450ms cubic-bezier(0.16,1,0.3,1) 120ms both" }}>
            <Composer
              ensureScope={async () => `chat-${(await ensure()).id}`}
              onSend={send}
              placeholder={w("Ask anything…", "问点什么…", "問點什麼…")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** `#chat-<id>`: the conversation with its rename and delete. */
function OpenChat({ chat, userName }: { chat: ChatConversation; userName?: string }) {
  const w = useWords();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const untitled = w("New chat", "新聊天", "新聊天");

  const rename = async () => {
    setPending(true);
    setError("");
    try {
      await updateChat(chat.id, { title: name.trim() });
      setRenaming(false);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    setPending(true);
    setError("");
    try {
      await deleteChat(chat.id);
      setDeleting(false);
      location.hash = "chat";
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Conversation
        scope={`chat-${chat.id}`}
        title={chat.title || untitled}
        userName={userName}
        onRunEnd={() => void refreshChats()}
        menuItems={[
          { key: "rename", label: w("Rename…", "重命名…", "重新命名…"), icon: <Icon name="pencil" size={16} />, onSelect: () => { setName(chat.title); setError(""); setRenaming(true); } },
          { key: "delete", label: w("Delete chat…", "删除对话…", "刪除對話…"), icon: <Icon name="trash" size={16} />, tone: "danger", onSelect: () => { setError(""); setDeleting(true); } },
          { key: "separator", separator: true },
        ]}
      />
      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        title={w("Rename chat", "重命名对话", "重新命名對話")}
        footer={
          <>
            <Button variant="quiet" size="sm" onClick={() => setRenaming(false)}>{w("Cancel", "取消", "取消")}</Button>
            <Button variant="primary" size="sm" disabled={pending || !name.trim()} onClick={() => void rename()}>{w("Save", "保存", "儲存")}</Button>
          </>
        }
      >
        <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) void rename(); }} className="flex flex-col gap-2">
          <TextField autoFocus aria-label={w("Chat name", "对话名称", "對話名稱")} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
          {error && <p role="alert" className="text-[12.5px] text-red-ink">{error}</p>}
        </form>
      </Dialog>
      <ConfirmDialog
        open={deleting}
        tone="danger"
        title={w(`Delete “${chat.title || untitled}”?`, `删除“${chat.title || untitled}”？`, `刪除「${chat.title || untitled}」？`)}
        description={w("The conversation and its files are removed. This cannot be undone.", "对话及其文件将被删除，此操作无法撤销。", "對話及其檔案將被刪除，此操作無法復原。")}
        confirmLabel={w("Delete", "删除", "刪除")}
        busy={pending}
        error={error || undefined}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(false)}
      />
    </>
  );
}

/** Standard chat: `#chat` starts a new conversation, `#chat-<id>` opens one from the shared chat list. */
export function Chat({ id, userName }: { id?: string; userName?: string }) {
  const w = useWords();
  const { conversations, error } = useChats();

  if (!conversations) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader title={w("Chat", "聊天", "聊天")} />
        <div className="flex flex-1 items-center justify-center p-6">
          {error ? (
            <Notice tone="danger" title={w("Chats could not be loaded", "无法加载对话", "無法載入對話")}
              action={<Button variant="secondary" size="sm" onClick={() => void refreshChats()}>{w("Retry", "重试", "重試")}</Button>}>
              {error}
            </Notice>
          ) : <LoadingState variant="Dots" label={w("Loading chats", "正在加载对话", "正在載入對話")} />}
        </div>
      </div>
    );
  }

  if (!id) return <NewChat key="new" userName={userName} />;
  const chat = conversations.find((item) => item.id === id);
  if (!chat) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader title={w("Chat", "聊天", "聊天")} />
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon="chat"
            title={w("This chat is not available", "此聊天不存在", "此聊天不存在")}
            description={w("It may have been deleted. Start a new chat instead.", "它可能已被删除。可以开始一个新聊天。", "它可能已被刪除。可以開始一個新聊天。")}
            action={<Button variant="primary" size="sm" onClick={() => { location.hash = "chat"; }}>{w("New chat", "新聊天", "新聊天")}</Button>}
          />
        </div>
      </div>
    );
  }
  return <OpenChat key={chat.id} chat={chat} userName={userName} />;
}
