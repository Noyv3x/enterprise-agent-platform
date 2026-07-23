/* <TelegramAdminConfig/> — global Telegram bot gateway config + a read-only table
   of users who linked their Telegram (legacy renderTelegramAdminConfig,
   legacy-app.js:2274-2362). Two secret fields (bot_token / webhook_secret) are
   never seeded (empty = keep) and clear via the post-save re-seed
   (loadTelegramConfig replaces telegramConfig). */

import { Badge, Button, Form, Input, Switch, Table, type TableProps } from "antd";
import { useEffect, useId, useState } from "react";
import { saveTelegramConfig } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { formatTime } from "../../../utils/format";
import type { TelegramConfigValues, TelegramLinkedUser } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { AdminCard } from "../AdminCard";
import { useI18n } from "../../../i18n";

interface TelegramFormState {
  enabled: boolean;
  polling: boolean;
  botUsername: string;
  botToken: string;
  webhookSecret: string;
}

function seedForm(config: TelegramConfigValues): TelegramFormState {
  return {
    enabled: !!config.enabled,
    polling: config.polling !== false,
    botUsername: config.bot_username || "",
    botToken: "",
    webhookSecret: "",
  };
}

export function TelegramAdminConfig() {
  const { t } = useI18n();
  const formId = useId();
  const fieldId = (name: string) => `${formId}-${name}`;
  const store = useStoreHandle();
  const saving = useStore((state) => state.pendingOperations.includes("admin:telegram:save"));
  const telegramConfig = useStore((state) => state.telegramConfig);
  const config = telegramConfig?.config || {};
  const linked = telegramConfig?.linked_users || [];
  const webhookUrl = config.webhook_url || t("admin.telegram.webhookPlaceholder");

  const [form, setForm] = useState<TelegramFormState>(() => seedForm(telegramConfig?.config || {}));

  useEffect(() => {
    setForm(seedForm(telegramConfig?.config || {}));
  }, [telegramConfig]);

  const dirty = JSON.stringify(form) !== JSON.stringify(seedForm(telegramConfig?.config || {}));

  const handleSubmit = () => {
    void saveTelegramConfig(store, {
      enabled: form.enabled,
      polling: form.polling,
      bot_username: form.botUsername,
      bot_token: form.botToken,
      webhook_secret: form.webhookSecret,
    });
  };

  const linkedColumns: TableProps<TelegramLinkedUser>["columns"] = [
    {
      title: t("admin.telegram.platformUser"),
      key: "platform-user",
      render: (_, item) => item.display_name || item.username,
    },
    {
      title: t("admin.accounts.username"),
      dataIndex: "username",
      key: "username",
    },
    {
      title: t("admin.telegram.telegramId"),
      dataIndex: "external_id",
      key: "external-id",
      render: (value) => <span className="mono">{value}</span>,
    },
    {
      title: t("admin.telegram.telegramUsername"),
      dataIndex: "telegram_username",
      key: "telegram-username",
      render: (value) => value ? `@${value}` : "-",
    },
    {
      title: t("admin.telegram.updatedAt"),
      dataIndex: "updated_at",
      key: "updated-at",
      render: (value) => formatTime(Number(value) || undefined),
    },
  ];

  return (
    <AdminCard className="config-form">
      <CardHead
        title={t("admin.telegram.title")}
        icon="message"
        desc={t("admin.telegram.description")}
        extra={
          <Badge
            className="status"
            status={config.enabled && config.bot_token_configured ? "success" : "warning"}
            text={t(config.enabled ? "admin.common.enabled" : "admin.common.disabled")}
          />
        }
      />
      <Form layout="vertical" requiredMark={false} onFinish={handleSubmit}>
        <div className="config-grid">
          <div className="check-row">
            <Switch
              id={fieldId("enabled")}
              aria-labelledby={fieldId("enabled-label")}
              checked={form.enabled}
              onChange={(enabled) => setForm((prev) => ({ ...prev, enabled }))}
            />
            <div id={fieldId("enabled-label")} className="check-row__text">
              <strong>{t("admin.telegram.enable")}</strong>
              <span>{t("admin.telegram.enableHint")}</span>
            </div>
          </div>
          <div className="check-row">
            <Switch
              id={fieldId("polling")}
              aria-labelledby={fieldId("polling-label")}
              checked={form.polling}
              onChange={(polling) => setForm((prev) => ({ ...prev, polling }))}
            />
            <div id={fieldId("polling-label")} className="check-row__text">
              <strong>{t("admin.telegram.longPolling")}</strong>
              <span>{t("admin.telegram.longPollingHint")}</span>
            </div>
          </div>
          <Form.Item
            className="field"
            label={t("admin.telegram.botUsername")}
            htmlFor={fieldId("bot-username")}
          >
            <Input
              id={fieldId("bot-username")}
              value={form.botUsername}
              placeholder={t("admin.telegram.botUsernamePlaceholder")}
              onChange={(event) => setForm((prev) => ({ ...prev, botUsername: event.target.value }))}
            />
          </Form.Item>
          <Form.Item
            className="field"
            label={t("admin.telegram.botToken")}
            htmlFor={fieldId("bot-token")}
          >
            <Input.Password
              id={fieldId("bot-token")}
              autoComplete="off"
              placeholder={config.bot_token_configured ? t("admin.common.keepUnchanged") : "BotFather token"}
              value={form.botToken}
              onChange={(event) => setForm((prev) => ({ ...prev, botToken: event.target.value }))}
            />
          </Form.Item>
          <Form.Item
            className="field field--full"
            label={t("admin.telegram.webhookSecret")}
            htmlFor={fieldId("webhook-secret")}
          >
            <Input.Password
              id={fieldId("webhook-secret")}
              autoComplete="off"
              placeholder={config.webhook_secret_configured ? t("admin.common.keepUnchanged") : t("admin.telegram.secretPlaceholder")}
              value={form.webhookSecret}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, webhookSecret: event.target.value }))
              }
            />
          </Form.Item>
          <div className="field--full field-stack">
            <span className="field-help">{t("admin.telegram.webhookUrl")}</span>
            <code className="mono config-value">{webhookUrl}</code>
          </div>
        </div>
        <div className="form-actions">
          <Button
            type="primary"
            htmlType="submit"
            disabled={!dirty}
            loading={saving}
          >
            {saving ? t("admin.common.saving") : t("admin.telegram.save")}
          </Button>
        </div>
      </Form>
      <div
        className="usage-table-wrap usage-table-wrap--spaced"
        role="region"
        aria-label={t("admin.telegram.linkedAria")}
        tabIndex={0}
      >
        <Table<TelegramLinkedUser>
          className="eap-admin-usage-table"
          columns={linkedColumns}
          dataSource={linked}
          rowKey={(item, index) => `${item.external_id ?? ""}-${index ?? ""}`}
          pagination={false}
          size="middle"
          scroll={{ x: 720 }}
          locale={{ emptyText: t("admin.telegram.empty") }}
        />
      </div>
    </AdminCard>
  );
}
