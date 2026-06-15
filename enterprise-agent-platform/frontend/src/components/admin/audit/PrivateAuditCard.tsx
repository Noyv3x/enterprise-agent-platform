/* <PrivateAuditCard/> — private-agent conversation audit + delete tools (legacy
   Card B in renderMessageAuditManagement, legacy-app.js:1880-1942). Mirrors the
   channel card but is gated on a selected conversation; includes the conversation
   list + selected-thread subhead + message list. Deletes confirm via the shared
   useConfirm() dialog. */

import { useState } from "react";
import {
  clearPrivateMessages,
  deletePrivateMessage,
  deletePrivateMessagesBefore,
  refreshMessageAudit,
  selectAuditConversation,
} from "../../../data/adminActions";
import { toast } from "../../../context/ToastContext";
import { unixFromDatetimeLocal } from "../../../utils/format";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { UseConfirm } from "../../../hooks/useConfirm";
import type { Id } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Field } from "../../common/Field";
import { Icon } from "../../common/Icon";
import { AuditMessageRow } from "./AuditMessageRow";
import { PrivateConversationItem } from "./PrivateConversationItem";

export interface PrivateAuditCardProps {
  confirm: UseConfirm["confirm"];
}

export function PrivateAuditCard({ confirm }: PrivateAuditCardProps) {
  const store = useStoreHandle();
  const conversations = useStore((state) => state.messageAudit.privateConversations);
  const privateMessages = useStore((state) => state.messageAudit.privateMessages);
  const privateTotal = useStore((state) => state.messageAudit.privateTotal);
  const auditPrivateUserId = useStore((state) => state.messageAudit.auditPrivateUserId);
  const busy = useStore((state) => state.busy);

  const selectedPrivateUserId = String(auditPrivateUserId || "");
  const selectedConversation = conversations.find(
    (item) => String(item.user_id) === selectedPrivateUserId,
  );

  const [messageId, setMessageId] = useState("");
  const [beforeTime, setBeforeTime] = useState("");

  const handleDeleteId = (event: React.FormEvent) => {
    event.preventDefault();
    const id = Number(messageId);
    if (!id) {
      toast("请输入要删除的消息 ID", { title: "缺少消息 ID" });
      return;
    }
    void (async () => {
      if (!(await confirm(`删除私人 Agent 消息 #${id}？`, { danger: true }))) return;
      await deletePrivateMessage(store, selectedPrivateUserId, id);
      setMessageId("");
    })();
  };

  const handleDeleteBefore = (event: React.FormEvent) => {
    event.preventDefault();
    const ts = unixFromDatetimeLocal(beforeTime);
    if (!ts) {
      toast("请选择删除截止时间", { title: "缺少时间" });
      return;
    }
    void (async () => {
      if (!(await confirm("删除该时间点之前的私人 Agent 消息？", { danger: true }))) return;
      await deletePrivateMessagesBefore(store, selectedPrivateUserId, ts);
      setBeforeTime("");
    })();
  };

  const handleClear = () => {
    void (async () => {
      if (!(await confirm("清空当前用户的全部私人 Agent 消息？", { danger: true }))) return;
      await clearPrivateMessages(store, selectedPrivateUserId);
    })();
  };

  const handleRowDelete = (id: Id) => {
    void (async () => {
      if (!(await confirm(`删除私人 Agent 消息 #${id}？`, { danger: true }))) return;
      await deletePrivateMessage(store, selectedPrivateUserId, id);
    })();
  };

  return (
    <section className="card audit-card">
      <CardHead
        title="私人 Agent 审计"
        icon="bot"
        desc={`${conversations.filter((item) => (item.message_count || 0) > 0).length} 个用户有私人会话记录`}
        extra={
          <button
            className="btn btn--sm"
            type="button"
            disabled={busy}
            onClick={() => void refreshMessageAudit(store)}
          >
            <Icon name="refresh" size={14} />
            <span>刷新</span>
          </button>
        }
      />
      <div className="audit-tools">
        <form className="audit-tool" onSubmit={handleDeleteId}>
          <Field label="精确删除">
            <input
              type="number"
              min="1"
              step="1"
              placeholder="消息 ID"
              value={messageId}
              onChange={(event) => setMessageId(event.target.value)}
            />
          </Field>
          <button
            className="btn btn--danger"
            type="submit"
            disabled={busy || !selectedPrivateUserId}
          >
            <Icon name="trash" size={15} />
            <span>删除 ID</span>
          </button>
        </form>
        <form className="audit-tool" onSubmit={handleDeleteBefore}>
          <Field label="删除时间点前">
            <input
              type="datetime-local"
              value={beforeTime}
              onChange={(event) => setBeforeTime(event.target.value)}
            />
          </Field>
          <button
            className="btn btn--danger"
            type="submit"
            disabled={busy || !selectedPrivateUserId}
          >
            <Icon name="trash" size={15} />
            <span>删除之前</span>
          </button>
        </form>
        <div className="audit-tool audit-tool--compact">
          <span className="field">
            <span>全部清空</span>
            <span className="muted">清空当前用户私人会话</span>
          </span>
          <button
            className="btn btn--danger"
            type="button"
            disabled={busy || !selectedPrivateUserId}
            onClick={handleClear}
          >
            <Icon name="trash" size={15} />
            <span>清空会话</span>
          </button>
        </div>
      </div>
      <div className="audit-private">
        <div className="audit-conversations">
          {conversations.length ? (
            conversations.map((item) => (
              <PrivateConversationItem
                key={String(item.user_id)}
                item={item}
                active={selectedPrivateUserId === String(item.user_id)}
                onSelect={() => void selectAuditConversation(store, item.user_id)}
              />
            ))
          ) : (
            <div className="muted">暂无用户可审计。</div>
          )}
        </div>
        <div className="audit-private__messages">
          {selectedConversation ? (
            <div className="audit-subhead">
              <div>
                <strong>{selectedConversation.display_name || selectedConversation.username}</strong>
                <span>{`@${selectedConversation.username}`}</span>
              </div>
              <span className="status">{`${privateTotal || 0} messages`}</span>
            </div>
          ) : null}
          <div className="audit-list">
            {privateMessages.length ? (
              privateMessages.map((message) => (
                <AuditMessageRow
                  key={String(message.id)}
                  message={message}
                  deletable
                  onDelete={() => handleRowDelete(message.id)}
                />
              ))
            ) : (
              <div className="muted">
                {selectedConversation
                  ? "该用户暂无私人 Agent 消息。"
                  : "选择一个用户查看私人 Agent 会话。"}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
