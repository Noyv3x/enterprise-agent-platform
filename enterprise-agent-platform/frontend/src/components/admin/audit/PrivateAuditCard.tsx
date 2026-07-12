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
import { useI18n } from "../../../i18n";

export interface PrivateAuditCardProps {
  confirm: UseConfirm["confirm"];
}

export function PrivateAuditCard({ confirm }: PrivateAuditCardProps) {
  const { t } = useI18n();
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
      toast(t("admin.audit.missingMessageId.detail"), { title: t("admin.audit.missingMessageId.title") });
      return;
    }
    void (async () => {
      if (!(await confirm(t("admin.audit.confirmDeletePrivateMessage", { id }), { danger: true }))) return;
      await deletePrivateMessage(store, selectedPrivateUserId, id);
      setMessageId("");
    })();
  };

  const handleDeleteBefore = (event: React.FormEvent) => {
    event.preventDefault();
    const ts = unixFromDatetimeLocal(beforeTime);
    if (!ts) {
      toast(t("admin.audit.missingTime.detail"), { title: t("admin.audit.missingTime.title") });
      return;
    }
    void (async () => {
      if (!(await confirm(t("admin.audit.confirmDeletePrivateBefore"), { danger: true }))) return;
      await deletePrivateMessagesBefore(store, selectedPrivateUserId, ts);
      setBeforeTime("");
    })();
  };

  const handleClear = () => {
    void (async () => {
      if (!(await confirm(t("admin.audit.confirmClearPrivate"), { danger: true }))) return;
      await clearPrivateMessages(store, selectedPrivateUserId);
    })();
  };

  const handleRowDelete = (id: Id) => {
    void (async () => {
      if (!(await confirm(t("admin.audit.confirmDeletePrivateMessage", { id: String(id) }), { danger: true }))) return;
      await deletePrivateMessage(store, selectedPrivateUserId, id);
    })();
  };

  return (
    <section className="card audit-card">
      <CardHead
        title={t("admin.audit.private.title")}
        icon="bot"
        desc={t("admin.audit.private.userCount", { count: conversations.filter((item) => (item.message_count || 0) > 0).length })}
        extra={
          <button
            className="btn btn--sm"
            type="button"
            disabled={busy}
            onClick={() => void refreshMessageAudit(store)}
          >
            <Icon name="refresh" size={14} />
            <span>{t("admin.common.refresh")}</span>
          </button>
        }
      />
      <div className="audit-tools">
        <form className="audit-tool" onSubmit={handleDeleteId}>
          <Field label={t("admin.audit.exactDelete")}>
            <input
              type="number"
              min="1"
              step="1"
              placeholder={t("admin.audit.messageId")}
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
            <span>{t("admin.audit.deleteId")}</span>
          </button>
        </form>
        <form className="audit-tool" onSubmit={handleDeleteBefore}>
          <Field label={t("admin.audit.deleteBeforeLabel")}>
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
            <span>{t("admin.audit.deleteBefore")}</span>
          </button>
        </form>
        <div className="audit-tool audit-tool--compact">
          <span className="field">
            <span>{t("admin.audit.clearAll")}</span>
            <span className="muted">{t("admin.audit.private.clearHint")}</span>
          </span>
          <button
            className="btn btn--danger"
            type="button"
            disabled={busy || !selectedPrivateUserId}
            onClick={handleClear}
          >
            <Icon name="trash" size={15} />
            <span>{t("admin.audit.private.clear")}</span>
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
            <div className="muted">{t("admin.audit.private.noUsers")}</div>
          )}
        </div>
        <div className="audit-private__messages">
          {selectedConversation ? (
            <div className="audit-subhead">
              <div>
                <strong>{selectedConversation.display_name || selectedConversation.username}</strong>
                <span>{`@${selectedConversation.username}`}</span>
              </div>
              <span className="status">{t("admin.audit.messageCount", { count: privateTotal || 0 })}</span>
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
                {t(selectedConversation ? "admin.audit.private.empty" : "admin.audit.private.selectHint")}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
