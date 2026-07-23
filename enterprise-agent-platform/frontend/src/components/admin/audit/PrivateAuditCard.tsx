/* <PrivateAuditCard/> — private-agent conversation audit + delete tools (legacy
   Card B in renderMessageAuditManagement, legacy-app.js:1880-1942). Mirrors the
   channel card but is gated on a selected conversation; includes the conversation
   list + selected-thread subhead + message list. Deletes confirm via the shared
   useConfirm() dialog. */

import { Button, Form, Input, Tag } from "antd";
import { useId, useState } from "react";
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
import { Icon } from "../../common/Icon";
import { AuditMessageRow } from "./AuditMessageRow";
import { PrivateConversationItem } from "./PrivateConversationItem";
import { AdminCard } from "../AdminCard";
import { useI18n } from "../../../i18n";

export interface PrivateAuditCardProps {
  confirm: UseConfirm["confirm"];
}

export function PrivateAuditCard({ confirm }: PrivateAuditCardProps) {
  const { t } = useI18n();
  const formId = useId();
  const fieldId = (name: string) => `${formId}-${name}`;
  const store = useStoreHandle();
  const conversations = useStore((state) => state.messageAudit.privateConversations);
  const privateMessages = useStore((state) => state.messageAudit.privateMessages);
  const privateTotal = useStore((state) => state.messageAudit.privateTotal);
  const auditPrivateUserId = useStore((state) => state.messageAudit.auditPrivateUserId);
  const busy = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:audit:")));

  const selectedPrivateUserId = String(auditPrivateUserId || "");
  const selectedConversation = conversations.find(
    (item) => String(item.user_id) === selectedPrivateUserId,
  );

  const [messageId, setMessageId] = useState("");
  const [beforeTime, setBeforeTime] = useState("");

  const handleDeleteId = () => {
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

  const handleDeleteBefore = () => {
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
    <AdminCard className="audit-card">
      <CardHead
        title={t("admin.audit.private.title")}
        icon="bot"
        desc={t("admin.audit.private.userCount", { count: conversations.filter((item) => (item.message_count || 0) > 0).length })}
        extra={
          <Button
            size="small"
            icon={<Icon name="refresh" size={14} />}
            disabled={busy}
            onClick={() => void refreshMessageAudit(store)}
          >
            {t("admin.common.refresh")}
          </Button>
        }
      />
      <div className="audit-tools">
        <Form className="audit-tool" layout="vertical" requiredMark={false} onFinish={handleDeleteId}>
          <Form.Item
            className="eap-field"
            label={t("admin.audit.exactDelete")}
            htmlFor={fieldId("message-id")}
          >
            <Input
              id={fieldId("message-id")}
              type="number"
              min="1"
              step="1"
              placeholder={t("admin.audit.messageId")}
              value={messageId}
              onChange={(event) => setMessageId(event.target.value)}
            />
          </Form.Item>
          <Button
            danger
            htmlType="submit"
            icon={<Icon name="trash" size={15} />}
            disabled={busy || !selectedPrivateUserId}
          >
            {t("admin.audit.deleteId")}
          </Button>
        </Form>
        <Form className="audit-tool" layout="vertical" requiredMark={false} onFinish={handleDeleteBefore}>
          <Form.Item
            className="eap-field"
            label={t("admin.audit.deleteBeforeLabel")}
            htmlFor={fieldId("before-time")}
          >
            <Input
              id={fieldId("before-time")}
              type="datetime-local"
              value={beforeTime}
              onChange={(event) => setBeforeTime(event.target.value)}
            />
          </Form.Item>
          <Button
            danger
            htmlType="submit"
            icon={<Icon name="trash" size={15} />}
            disabled={busy || !selectedPrivateUserId}
          >
            {t("admin.audit.deleteBefore")}
          </Button>
        </Form>
        <div className="audit-tool audit-tool--compact">
          <span className="audit-tool__copy">
            <span>{t("admin.audit.clearAll")}</span>
            <span className="muted">{t("admin.audit.private.clearHint")}</span>
          </span>
          <Button
            danger
            icon={<Icon name="trash" size={15} />}
            disabled={busy || !selectedPrivateUserId}
            onClick={handleClear}
          >
            {t("admin.audit.private.clear")}
          </Button>
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
              <Tag className="status" variant="filled">
                {t("admin.audit.messageCount", { count: privateTotal || 0 })}
              </Tag>
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
    </AdminCard>
  );
}
