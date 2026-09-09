import { Button, Form, Input, Switch, Table, type TableProps } from "antd";
import { useEffect, useState } from "react";
import { saveTelegramConfig } from "../../../data/adminActions";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { TelegramConfigValues, TelegramLinkedUser } from "../../../types";
import { formatTimestamp } from "../../../utils/format";
import { DataRegion, EmptyState, FactGrid, FormFooter, FormGrid, Section } from "../../ui/fieldwork";

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
  const columns: TableProps<TelegramLinkedUser>["columns"] = [
    { title: t("admin.telegram.platformUser"), key: "name", render: (_, row) => row.display_name || row.username },
    { title: t("admin.accounts.username"), dataIndex: "username" },
    { title: t("admin.telegram.telegramId"), dataIndex: "external_id" },
    { title: t("admin.telegram.telegramUsername"), dataIndex: "telegram_username", render: (value: string) => value ? `@${value}` : "—" },
    { title: t("admin.telegram.updatedAt"), dataIndex: "updated_at", render: (value: number | string | undefined) => formatTimestamp(value) },
  ];
  return <>
    <Section title={t("admin.telegram.title")} description={t("admin.telegram.description")}>
      <Form layout="vertical" disabled={saving} onFinish={() => { if (dirty && !saving) void saveTelegramConfig(store, { enabled: draft.enabled, polling: draft.polling, bot_username: draft.username, bot_token: draft.token, webhook_secret: draft.secret }); }}>
        <FormGrid>
          <Form.Item label={t("admin.telegram.enable")} extra={t("admin.telegram.enableHint")}><Switch aria-label={t("admin.telegram.enable")} checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} /></Form.Item>
          <Form.Item label={t("admin.telegram.longPolling")} extra={t("admin.telegram.longPollingHint")}><Switch aria-label={t("admin.telegram.longPolling")} checked={draft.polling} onChange={(polling) => setDraft({ ...draft, polling })} /></Form.Item>
          <Form.Item label={t("admin.telegram.botUsername")}><Input aria-label={t("admin.telegram.botUsername")} value={draft.username} placeholder={t("admin.telegram.botUsernamePlaceholder")} onChange={(e) => setDraft({ ...draft, username: e.target.value })} /></Form.Item>
          <Form.Item label={t("admin.telegram.botToken")} extra={t(config.bot_token_configured ? "admin.common.leaveBlank" : "admin.common.notConfigured")}><Input.Password aria-label={t("admin.telegram.botToken")} autoComplete="new-password" value={draft.token} onChange={(e) => setDraft({ ...draft, token: e.target.value })} /></Form.Item>
          <Form.Item label={t("admin.telegram.webhookSecret")} extra={t(config.webhook_secret_configured ? "admin.common.leaveBlank" : "admin.common.notConfigured")}><Input.Password aria-label={t("admin.telegram.webhookSecret")} autoComplete="new-password" value={draft.secret} placeholder={t("admin.telegram.secretPlaceholder")} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} /></Form.Item>
        </FormGrid>
        <FormFooter><Button type="primary" htmlType="submit" loading={saving} disabled={!dirty || saving}>{t("admin.telegram.save")}</Button></FormFooter>
      </Form>
      <FactGrid items={[
        { key: "url", label: t("admin.telegram.webhookUrl"), value: config.webhook_url || t("admin.telegram.webhookPlaceholder") },
        { key: "enabled", label: t("admin.telegram.enable"), value: t(config.enabled ? "admin.common.enabled" : "admin.common.disabled") },
        { key: "token", label: t("admin.telegram.botToken"), value: t(config.bot_token_configured ? "admin.common.enabled" : "admin.common.notConfigured") },
      ]} />
    </Section>
    <Section title={t("admin.telegram.linkedAria")}>
      <DataRegion state={linked.length ? "ready" : "empty"} loadingLabel={t("common.loading")} empty={<EmptyState title={t("admin.telegram.empty")} compact />}>
        <Table aria-label={t("admin.telegram.linkedAria")} columns={columns} dataSource={linked} rowKey={(row) => `${row.username}:${row.external_id}`} pagination={false} scroll={{ x: 640 }} />
      </DataRegion>
    </Section>
  </>;
}
