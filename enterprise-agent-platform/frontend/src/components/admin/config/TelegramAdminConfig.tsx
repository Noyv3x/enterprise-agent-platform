import { Button, Input, Switch, Field, DataTable, type DataColumn } from "../../ui/beautiful";
import { useEffect, useState } from "react";
import { saveTelegramConfig } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { TelegramConfigValues, TelegramLinkedUser } from "../../../types";
import { formatTimestamp } from "../../../utils/format";
import { DataRegion, EmptyState, FactGrid, FormFooter, FormGrid, Section } from "../../ui/beautiful";

function seed(config: TelegramConfigValues) { return { enabled: !!config.enabled, polling: config.polling !== false, username: config.bot_username || "", token: "", secret: "" }; }
export function TelegramAdminConfig() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const data = useStore((state) => state.telegramConfig);
  const saving = useStore((state) => state.pendingOperations.includes("admin:telegram:save"));
  const config = data?.config || {};
  const [draft, setDraft] = useState(() => seed(config));
  useEffect(() => setDraft(seed(data?.config || {})), [data]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(seed(config));
  const linked = data?.linked_users || [];
  const columns: DataColumn<TelegramLinkedUser>[] = [
    { title: t("admin.telegram.platformUser"), key: "name", render: (row) => row.display_name || row.username },
    { title: t("admin.accounts.username"), key: "username", render: (row) => row.username },
    { title: t("admin.telegram.telegramId"), key: "external_id", render: (row) => row.external_id },
    { title: t("admin.telegram.telegramUsername"), key: "telegram_username", render: (row) => row.telegram_username ? `@${row.telegram_username}` : "—" },
    { title: t("admin.telegram.updatedAt"), key: "updated_at", render: (row) => formatTimestamp(row.updated_at) },
  ];
  return <>
    <Section title={t("admin.telegram.title")} description={t("admin.telegram.description")}>
      <form onSubmit={(event) => { event.preventDefault(); if (dirty && !saving) void saveTelegramConfig(store, { enabled: draft.enabled, polling: draft.polling, bot_username: draft.username, bot_token: draft.token, webhook_secret: draft.secret }); }}><fieldset disabled={saving}><FormGrid>
        <Field label={t("admin.telegram.enable")} hint={t("admin.telegram.enableHint")} ><Switch aria-label={t("admin.telegram.enable")} checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} /></Field>
        <Field label={t("admin.telegram.longPolling")} hint={t("admin.telegram.longPollingHint")} ><Switch aria-label={t("admin.telegram.longPolling")} checked={draft.polling} onChange={(polling) => setDraft({ ...draft, polling })} /></Field>
        <Field label={t("admin.telegram.botUsername")}><Input aria-label={t("admin.telegram.botUsername")} value={draft.username} placeholder={t("admin.telegram.botUsernamePlaceholder")} onChange={(e) => setDraft({ ...draft, username: e.target.value })} /></Field>
        <Field label={t("admin.telegram.botToken")} hint={t(config.bot_token_configured ? "admin.common.leaveBlank" : "admin.common.notConfigured")} ><Input type="password" aria-label={t("admin.telegram.botToken")} autoComplete="new-password" value={draft.token} onChange={(e) => setDraft({ ...draft, token: e.target.value })} /></Field>
        <Field label={t("admin.telegram.webhookSecret")} hint={t(config.webhook_secret_configured ? "admin.common.leaveBlank" : "admin.common.notConfigured")} ><Input type="password" aria-label={t("admin.telegram.webhookSecret")} autoComplete="new-password" value={draft.secret} placeholder={t("admin.telegram.secretPlaceholder")} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} /></Field>
      </FormGrid>
      <FormFooter><Button variant="primary" type="submit" loading={saving} disabled={!dirty || saving}>{t("admin.telegram.save")}</Button></FormFooter></fieldset></form>
      <FactGrid items={[
        { key: "url", label: t("admin.telegram.webhookUrl"), value: config.webhook_url || t("admin.telegram.webhookPlaceholder") },
        { key: "enabled", label: t("admin.telegram.enable"), value: t(config.enabled ? "admin.common.enabled" : "admin.common.disabled") },
        { key: "token", label: t("admin.telegram.botToken"), value: t(config.bot_token_configured ? "admin.common.enabled" : "admin.common.notConfigured") },
      ]} />
    </Section>
    <Section title={t("admin.telegram.linkedAria")}>
      <DataRegion state={linked.length ? "ready" : "empty"} loadingLabel={t("common.loading")} empty={<EmptyState title={t("admin.telegram.empty")} compact />}>
        <DataTable aria-label={t("admin.telegram.linkedAria")} columns={columns} rows={linked} rowKey={(row) => `${row.username}:${row.external_id}`} />
      </DataRegion>
    </Section>
  </>;
}
