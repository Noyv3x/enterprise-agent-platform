/* <ChannelAuditCard/> — channel-message audit + delete tools (legacy Card A in
   renderMessageAuditManagement, legacy-app.js:1830-1879). Three tools (delete by
   id / delete-before / clear-all) + the message list. Every delete confirms via
   the shared useConfirm() dialog (cancel = no-op), then runs the data-op which
   cascades reloads. The two tool inputs are local state, cleared on a confirmed
   submit. */

import { useState } from "react";
import {
  clearChannelMessages,
  deleteChannelMessage,
  deleteChannelMessagesBefore,
  refreshAuditChannel,
  selectAuditChannel,
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

export interface ChannelAuditCardProps {
  confirm: UseConfirm["confirm"];
  channelId: string;
}

export function ChannelAuditCard({ confirm, channelId }: ChannelAuditCardProps) {
  const store = useStoreHandle();
  const channels = useStore((state) => state.channels);
  const channelMessages = useStore((state) => state.messageAudit.channelMessages);
  const channelTotal = useStore((state) => state.messageAudit.channelTotal);
  const busy = useStore((state) => state.busy);
  const channel = channels.find((item) => String(item.id) === channelId);

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
      if (!(await confirm(`删除频道消息 #${id}？`, { danger: true }))) return;
      await deleteChannelMessage(store, channelId, id);
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
      if (!(await confirm("删除该时间点之前的频道消息？", { danger: true }))) return;
      await deleteChannelMessagesBefore(store, channelId, ts);
      setBeforeTime("");
    })();
  };

  const handleClear = () => {
    void (async () => {
      if (!(await confirm("清空当前频道的全部消息？", { danger: true }))) return;
      await clearChannelMessages(store, channelId);
    })();
  };

  const handleRowDelete = (id: Id) => {
    void (async () => {
      if (!(await confirm(`删除频道消息 #${id}？`, { danger: true }))) return;
      await deleteChannelMessage(store, channelId, id);
    })();
  };

  return (
    <section className="card audit-card">
      <CardHead
        title="频道消息管理"
        icon="message"
        desc={
          channel ? `#${channel.name}：${channelTotal || 0} 条消息` : "选择频道后查看和删除消息"
        }
        extra={
          <button
            className="btn btn--sm"
            type="button"
            disabled={busy || !channelId}
            onClick={() => void refreshAuditChannel(store, channelId)}
          >
            <Icon name="refresh" size={14} />
            <span>刷新</span>
          </button>
        }
      />
      {channels.length ? (
        <Field label="频道">
          <select
            value={channelId}
            onChange={(event) => void selectAuditChannel(store, String(event.target.value || ""))}
          >
            {channels.map((item) => (
              <option key={String(item.id)} value={String(item.id)}>
                {`#${item.name}`}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
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
          <button className="btn btn--danger" type="submit" disabled={busy || !channelId}>
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
          <button className="btn btn--danger" type="submit" disabled={busy || !channelId}>
            <Icon name="trash" size={15} />
            <span>删除之前</span>
          </button>
        </form>
        <div className="audit-tool audit-tool--compact">
          <span className="field">
            <span>全部清空</span>
            <span className="muted">清空当前频道消息</span>
          </span>
          <button
            className="btn btn--danger"
            type="button"
            disabled={busy || !channelId}
            onClick={handleClear}
          >
            <Icon name="trash" size={15} />
            <span>清空频道</span>
          </button>
        </div>
      </div>
      <div className="audit-list">
        {channelMessages.length ? (
          channelMessages.map((message) => (
            <AuditMessageRow
              key={String(message.id)}
              message={message}
              deletable
              onDelete={() => handleRowDelete(message.id)}
            />
          ))
        ) : (
          <div className="muted">{channel ? "当前频道暂无消息。" : "暂无频道。"}</div>
        )}
      </div>
    </section>
  );
}
