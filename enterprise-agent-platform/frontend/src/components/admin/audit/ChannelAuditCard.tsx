/* <ChannelAuditCard/> — channel-message audit + delete tools (legacy Card A in
   renderMessageAuditManagement, legacy-app.js:1830-1879). Three tools (delete by
   id / delete-before / clear-all) + the message list. Every delete confirms via
   the shared useConfirm() dialog (cancel = no-op), then runs the data-op which
   cascades reloads. The two tool inputs are local state, cleared on a confirmed
   submit. */

import { Button, Form, Input, Select } from "antd";
import { useId, useState } from "react";
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
import { Icon } from "../../common/Icon";
import { AuditMessageRow } from "./AuditMessageRow";
import { AdminCard } from "../AdminCard";
import { useI18n } from "../../../i18n";

export interface ChannelAuditCardProps {
  confirm: UseConfirm["confirm"];
  channelId: string;
}

export function ChannelAuditCard({ confirm, channelId }: ChannelAuditCardProps) {
  const { t } = useI18n();
  const formId = useId();
  const fieldId = (name: string) => `${formId}-${name}`;
  const store = useStoreHandle();
  const channels = useStore((state) => state.channels);
  const channelMessages = useStore((state) => state.messageAudit.channelMessages);
  const channelTotal = useStore((state) => state.messageAudit.channelTotal);
  const busy = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:audit:")));
  const channel = channels.find((item) => String(item.id) === channelId);

  const [messageId, setMessageId] = useState("");
  const [beforeTime, setBeforeTime] = useState("");

  const handleDeleteId = () => {
    const id = Number(messageId);
    if (!id) {
      toast(t("admin.audit.missingMessageId.detail"), { title: t("admin.audit.missingMessageId.title") });
      return;
    }
    void (async () => {
      if (!(await confirm(t("admin.audit.confirmDeleteChannelMessage", { id }), { danger: true }))) return;
      await deleteChannelMessage(store, channelId, id);
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
      if (!(await confirm(t("admin.audit.confirmDeleteChannelBefore"), { danger: true }))) return;
      await deleteChannelMessagesBefore(store, channelId, ts);
      setBeforeTime("");
    })();
  };

  const handleClear = () => {
    void (async () => {
      if (!(await confirm(t("admin.audit.confirmClearChannel"), { danger: true }))) return;
      await clearChannelMessages(store, channelId);
    })();
  };

  const handleRowDelete = (id: Id) => {
    void (async () => {
      if (!(await confirm(t("admin.audit.confirmDeleteChannelMessage", { id: String(id) }), { danger: true }))) return;
      await deleteChannelMessage(store, channelId, id);
    })();
  };

  return (
    <AdminCard className="audit-card">
      <CardHead
        title={t("admin.audit.channel.title")}
        icon="message"
        desc={
          channel ? t("admin.audit.channel.messageCount", { channel: channel.name, count: channelTotal || 0 }) : t("admin.audit.channel.selectHint")
        }
        extra={
          <Button
            className="btn--sm"
            size="small"
            icon={<Icon name="refresh" size={14} />}
            disabled={busy || !channelId}
            onClick={() => void refreshAuditChannel(store, channelId)}
          >
            {t("admin.common.refresh")}
          </Button>
        }
      />
      {channels.length ? (
        <Form.Item
          className="field"
          label={t("admin.audit.channel.label")}
          htmlFor={fieldId("channel")}
        >
          <Select
            id={fieldId("channel")}
            aria-label={t("admin.audit.channel.label")}
            style={{ width: "100%" }}
            value={channelId}
            options={channels.map((item) => ({
              value: String(item.id),
              label: `#${item.name}`,
            }))}
            onChange={(value) => void selectAuditChannel(store, String(value || ""))}
          />
        </Form.Item>
      ) : null}
      <div className="audit-tools">
        <Form className="audit-tool" layout="vertical" requiredMark={false} onFinish={handleDeleteId}>
          <Form.Item
            className="field"
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
            disabled={busy || !channelId}
          >
            {t("admin.audit.deleteId")}
          </Button>
        </Form>
        <Form className="audit-tool" layout="vertical" requiredMark={false} onFinish={handleDeleteBefore}>
          <Form.Item
            className="field"
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
            disabled={busy || !channelId}
          >
            {t("admin.audit.deleteBefore")}
          </Button>
        </Form>
        <div className="audit-tool audit-tool--compact">
          <span className="field">
            <span>{t("admin.audit.clearAll")}</span>
            <span className="muted">{t("admin.audit.channel.clearHint")}</span>
          </span>
          <Button
            danger
            icon={<Icon name="trash" size={15} />}
            disabled={busy || !channelId}
            onClick={handleClear}
          >
            {t("admin.audit.channel.clear")}
          </Button>
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
          <div className="muted">{t(channel ? "admin.audit.channel.empty" : "admin.audit.channel.none")}</div>
        )}
      </div>
    </AdminCard>
  );
}
