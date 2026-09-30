import { useCallback, useEffect, useState } from "react";
import { request } from "../api";
import { Button } from "../components/ui/beautiful";
import { EmptyState, Glyph, LoadingState, Notice, StatusMark } from "../components/ui/fieldwork";
import { useWords } from "../words";
import { Conversation } from "./Conversation";
import type { ChatConversation, ChatModels } from "./conversation/types";
import { errorText } from "./conversation/useConversation";
import "./conversation/conversation.css";

/** Standard chat: many conversations per user, each on a model the administrator allows. */
export function Chat() {
  const w = useWords();
  const [models, setModels] = useState<ChatModels | null>(null);
  const [conversations, setConversations] = useState<ChatConversation[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const refreshList = useCallback(async () => {
    const result = await request<{ conversations: ChatConversation[] }>("/api/chat/conversations");
    setConversations(result.conversations);
    return result.conversations;
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const [policy, list] = await Promise.all([request<ChatModels>("/api/chat/models"), refreshList()]);
      setModels(policy);
      setSelected((current) => current ?? list[0]?.id ?? null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [refreshList]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!models) return;
    setPending(true);
    setError("");
    try {
      const { conversation } = await request<{ conversation: ChatConversation }>("/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ model_id: models.default_model_id }),
      });
      setConversations((current) => [conversation, ...(current ?? [])]);
      setSelected(conversation.id);
      setOpen(true);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(false);
    }
  };

  const remove = async (id: string) => {
    setPending(true);
    setError("");
    try {
      await request(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
      const rest = (conversations ?? []).filter((item) => item.id !== id);
      setConversations(rest);
      setConfirming(null);
      if (selected === id) {
        setSelected(rest[0]?.id ?? null);
        setOpen(false);
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(false);
    }
  };

  const changeModel = async (id: string, modelId: string) => {
    setError("");
    try {
      const { conversation } = await request<{ conversation: ChatConversation }>(`/api/chat/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ model_id: modelId }),
      });
      setConversations((current) => (current ?? []).map((item) => (item.id === id ? conversation : item)));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  if (!conversations || !models) {
    return (
      <div className="wf-page">
        {error
          ? <Notice tone="danger" title={w("Chats could not be loaded", "无法加载对话", "無法載入對話")} action={<Button type="button" variant="secondary" size="sm" onClick={() => void load()}>{w("Retry", "重试", "重試")}</Button>}>{error}</Notice>
          : <LoadingState label={w("Loading chats…", "正在加载对话…", "正在載入對話…")} />}
      </div>
    );
  }

  const noModels = models.allowed_models.length === 0;
  const current = conversations.find((item) => item.id === selected) ?? null;
  const untitled = w("New chat", "新对话", "新對話");
  const allowed = current ? models.allowed_models.includes(current.model_id) : true;

  return (
    <div className="cv-chat" data-open={open && current ? "" : undefined}>
      <nav className="cv-chat-list" aria-label={w("Chats", "对话列表", "對話列表")}>
        <Button type="button" variant="primary" size="sm" disabled={pending || noModels} onClick={() => void create()}>
          <Glyph name="plus" size={14} />
          {w("New chat", "新对话", "新對話")}
        </Button>
        {error && <div className="cv-error-text" role="alert">{error}</div>}
        {noModels && (
          <Notice tone="warning" title={w("No chat models available", "没有可用的对话模型", "沒有可用的對話模型")}>
            {w("Ask an administrator to allow a model for your account.", "请联系管理员为你的账号开放模型。", "請聯絡管理員為你的帳號開放模型。")}
          </Notice>
        )}
        <ul>
          {conversations.map((item) => (
            <li key={item.id} className="cv-chat-row" data-active={item.id === selected ? "" : undefined}>
              {confirming === item.id ? (
                <div className="cv-chat-confirm" role="group" aria-label={w("Confirm delete", "确认删除", "確認刪除")}>
                  <span>{w("Delete this chat and its files?", "删除此对话及其文件？", "刪除此對話及其檔案？")}</span>
                  <Button type="button" variant="primary" size="xs" disabled={pending} onClick={() => void remove(item.id)}>{w("Delete", "删除", "刪除")}</Button>
                  <Button type="button" variant="quiet" size="xs" onClick={() => setConfirming(null)}>{w("Cancel", "取消", "取消")}</Button>
                </div>
              ) : (
                <>
                  <button type="button" className="cv-chat-open" aria-current={item.id === selected ? "page" : undefined} onClick={() => { setSelected(item.id); setOpen(true); }}>
                    <span className="cv-chat-title">{item.title || untitled}</span>
                    <span className="cv-chat-meta">{item.model_id}</span>
                  </button>
                  <Button type="button" variant="quiet" size="xs" className="cv-icon-button" aria-label={`${w("Delete", "删除", "刪除")} ${item.title || untitled}`} onClick={() => setConfirming(item.id)}>
                    <Glyph name="trash" size={14} />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </nav>
      <div className="cv-chat-main">
        {current ? (
          <Conversation
            scope={`chat-${current.id}`}
            title={current.title || untitled}
            onRunEnd={() => void refreshList().catch(() => undefined)}
            actions={
              <>
                <Button type="button" variant="quiet" size="sm" className="cv-chat-back" onClick={() => setOpen(false)}>
                  <Glyph name="back" size={14} />
                  {w("Chats", "对话", "對話")}
                </Button>
                <label className="cv-footnote">
                  <span className="wf-sr-only">{w("Model", "模型", "模型")}</span>
                  <select className="cv-select" value={current.model_id} onChange={(event) => void changeModel(current.id, event.target.value)}>
                    {!allowed && <option value={current.model_id} disabled>{`${current.model_id} (${w("no longer allowed", "已不可用", "已不可用")})`}</option>}
                    {models.allowed_models.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                  {!allowed && <StatusMark tone="warning" subtle>{w("Pick an allowed model to continue", "请选择可用的模型以继续", "請選擇可用的模型以繼續")}</StatusMark>}
                </label>
              </>
            }
          />
        ) : (
          <EmptyState
            title={w("Start a chat", "开始对话", "開始對話")}
            description={w("Each chat has its own files and can search the web and run code.", "每个对话都有独立的文件空间，可以搜索网页和运行代码。", "每個對話都有獨立的檔案空間，可以搜尋網頁和執行程式。")}
            action={<Button type="button" variant="primary" size="sm" disabled={pending || noModels} onClick={() => void create()}>{w("New chat", "新对话", "新對話")}</Button>}
          />
        )}
      </div>
    </div>
  );
}
