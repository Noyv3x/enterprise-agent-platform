import { Button, Input, Field } from "../../ui/beautiful";
import { useEffect, useRef, useState } from "react";
import { clearChannelMessages, clearPrivateMessages, deleteChannelMessage, deleteChannelMessagesBefore, deletePrivateMessage, deletePrivateMessagesBefore } from "../../../data/adminActions";
import { toast } from "../../../context/ToastContext";
import type { UseConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { Id, Message } from "../../../types";
import { unixFromDatetimeLocal } from "../../../utils/format";
import { DataRegion, EmptyState, FormGrid, Notice, ResourceList, Section } from "../../ui/beautiful";
import { AuditMessageRow } from "./AuditMessageRow";

interface AuditThreadProps {
  kind: "channel" | "private";
  scopeId: string;
  scopeName: string;
  messages: Message[];
  total: number;
  loading: boolean;
  confirm: UseConfirm["confirm"];
}

export function AuditThread({ kind, scopeId, scopeName, messages, total, loading, confirm }: AuditThreadProps) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const pending = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:audit:")));
  const [messageId, setMessageId] = useState("");
  const [beforeTime, setBeforeTime] = useState("");
  const [confirming, setConfirming] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const disabled = !scopeId || pending || confirming;

  async function remove(operation: "id" | "before" | "clear", rowId?: Id) {
    if (disabled || locked.current) return;
    const id = rowId ?? Number(messageId);
    const before = unixFromDatetimeLocal(beforeTime);
    if (operation === "id" && !id) {
      toast(t("admin.audit.missingMessageId.detail"), { title: t("admin.audit.missingMessageId.title") });
      return;
    }
    if (operation === "before" && !before) {
      toast(t("admin.audit.missingTime.detail"), { title: t("admin.audit.missingTime.title") });
      return;
    }
    const account = store.getState().user;
    const question = kind === "channel"
      ? operation === "id" ? t("admin.audit.confirmDeleteChannelMessage", { id: String(id) }) : operation === "before" ? t("admin.audit.confirmDeleteChannelBefore") : t("admin.audit.confirmClearChannel")
      : operation === "id" ? t("admin.audit.confirmDeletePrivateMessage", { id: String(id) }) : operation === "before" ? t("admin.audit.confirmDeletePrivateBefore") : t("admin.audit.confirmClearPrivate");
    locked.current = true;
    setConfirming(true);
    try {
      if (!await confirm(`${scopeName} (#${scopeId})\n${question}${operation === "before" ? `\n${beforeTime}` : ""}`, { danger: true })) return;
      const state = store.getState();
      const selected = kind === "channel" ? state.messageAudit.auditChannelId : state.messageAudit.auditPrivateUserId;
      if (!alive.current || state.user !== account || String(selected || "") !== scopeId || state.pendingOperations.some((key) => key.startsWith("admin:audit:"))) return;
      if (operation === "id") await (kind === "channel" ? deleteChannelMessage : deletePrivateMessage)(store, scopeId, id);
      else if (operation === "before") await (kind === "channel" ? deleteChannelMessagesBefore : deletePrivateMessagesBefore)(store, scopeId, before!);
      else await (kind === "channel" ? clearChannelMessages : clearPrivateMessages)(store, scopeId);
      // These actions swallow failures. A settled promise cannot authorize clearing a draft.
    } finally {
      locked.current = false;
      if (alive.current) setConfirming(false);
    }
  }

  return <>
    <Notice title={scopeName} tone="info">
      <span>#{scopeId} · {t("admin.audit.receivedTotal", { received: messages.length, total })}</span>
    </Notice>
    <DataRegion state={messages.length ? "ready" : loading ? "loading" : "empty"} loadingLabel={t("common.loading")} empty={<EmptyState compact title={t(kind === "channel" ? "admin.audit.channel.empty" : "admin.audit.private.empty")} />}>
      {loading && <div role="status">{t("common.loading")}</div>}
      <ResourceList><>{messages.map((message) => <AuditMessageRow key={message.id} message={message} deletable={!disabled} onDelete={() => { void remove("id", message.id); }} />)}</></ResourceList>
    </DataRegion>
    <Section tone="danger" title={t("admin.audit.deleteMessage")} description={t(kind === "channel" ? "admin.audit.channel.clearHint" : "admin.audit.private.clearHint")}>
      <FormGrid>
        <form onSubmit={(event) => { event.preventDefault(); void remove("id"); }}><Field label={t("admin.audit.messageId")}><Input aria-label={t("admin.audit.messageId")} type="number" min={1} step={1} value={messageId} disabled={disabled} onChange={(event) => setMessageId(event.target.value)} /></Field>
        <Button variant="danger" type="submit" disabled={disabled}>{t("admin.audit.deleteId")}</Button></form>
        <form onSubmit={(event) => { event.preventDefault(); void remove("before"); }}><Field label={t("admin.audit.deleteBeforeLabel")}><Input aria-label={t("admin.audit.deleteBeforeLabel")} type="datetime-local" value={beforeTime} disabled={disabled} onChange={(event) => setBeforeTime(event.target.value)} /></Field>
        <Button variant="danger" type="submit" disabled={disabled}>{t("admin.audit.deleteBefore")}</Button></form>
      </FormGrid>
      <Button  variant="danger" disabled={disabled} onClick={() => { void remove("clear"); }}>{t(kind === "channel" ? "admin.audit.channel.clear" : "admin.audit.private.clear")}</Button>
    </Section>
  </>;
}
