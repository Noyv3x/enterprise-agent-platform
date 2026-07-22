/* <TelegramAdminConfig/> — global Telegram bot gateway config + a read-only table
   of users who linked their Telegram (legacy renderTelegramAdminConfig,
   legacy-app.js:2274-2362). Two secret fields (bot_token / webhook_secret) are
   never seeded (empty = keep) and clear via the post-save re-seed
   (loadTelegramConfig replaces telegramConfig). The linked-user list uses native
   table semantics and the shared responsive table wrapper. */

import { useEffect, useState } from "react";
import { saveTelegramConfig } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { formatTime } from "../../../utils/format";
import type { TelegramConfigValues } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Field } from "../../common/Field";
import { StatusBadge } from "../../common/StatusBadge";
import { LoadingButton } from "../../common/LoadingButton";
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

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void saveTelegramConfig(store, {
      enabled: form.enabled,
      polling: form.polling,
      bot_username: form.botUsername,
      bot_token: form.botToken,
      webhook_secret: form.webhookSecret,
    });
  };

  return (
    <section className="card config-form">
      <CardHead
        title={t("admin.telegram.title")}
        icon="message"
        desc={t("admin.telegram.description")}
        extra={
          <StatusBadge
            ok={!!config.enabled && !!config.bot_token_configured}
            label={t(config.enabled ? "admin.common.enabled" : "admin.common.disabled")}
          />
        }
      />
      <form onSubmit={handleSubmit}>
        <div className="config-grid">
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <div className="check-row__text">
              <strong>{t("admin.telegram.enable")}</strong>
              <span>{t("admin.telegram.enableHint")}</span>
            </div>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.polling}
              onChange={(event) => setForm((prev) => ({ ...prev, polling: event.target.checked }))}
            />
            <div className="check-row__text">
              <strong>{t("admin.telegram.longPolling")}</strong>
              <span>{t("admin.telegram.longPollingHint")}</span>
            </div>
          </label>
          <Field label={t("admin.telegram.botUsername")}>
            <input
              value={form.botUsername}
              placeholder={t("admin.telegram.botUsernamePlaceholder")}
              onChange={(event) => setForm((prev) => ({ ...prev, botUsername: event.target.value }))}
            />
          </Field>
          <Field label={t("admin.telegram.botToken")}>
            <input
              type="password"
              autoComplete="off"
                placeholder={config.bot_token_configured ? t("admin.common.keepUnchanged") : "BotFather token"}
              value={form.botToken}
              onChange={(event) => setForm((prev) => ({ ...prev, botToken: event.target.value }))}
            />
          </Field>
          <div className="field--full">
            <Field label={t("admin.telegram.webhookSecret")}>
              <input
                type="password"
                autoComplete="off"
                placeholder={config.webhook_secret_configured ? t("admin.common.keepUnchanged") : t("admin.telegram.secretPlaceholder")}
                value={form.webhookSecret}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, webhookSecret: event.target.value }))
                }
              />
            </Field>
          </div>
          <div className="field--full field-stack">
            <span className="field-help">{t("admin.telegram.webhookUrl")}</span>
            <code className="mono config-value">{webhookUrl}</code>
          </div>
        </div>
        <div className="form-actions">
          <LoadingButton
            variant="primary"
            type="submit"
            disabled={!dirty}
            loading={saving}
            loadingLabel={t("admin.common.saving")}
          >
            {t("admin.telegram.save")}
          </LoadingButton>
        </div>
      </form>
      <div
        className="usage-table-wrap usage-table-wrap--spaced"
        role="region"
        aria-label={t("admin.telegram.linkedAria")}
        tabIndex={0}
      >
        <table className="usage-table" aria-label={t("admin.telegram.linkedAria")}>
          <thead>
            <tr className="usage-table__row usage-table__head">
              <th scope="col">{t("admin.telegram.platformUser")}</th>
              <th scope="col">{t("admin.accounts.username")}</th>
              <th scope="col">{t("admin.telegram.telegramId")}</th>
              <th scope="col">{t("admin.telegram.telegramUsername")}</th>
              <th scope="col">{t("admin.telegram.updatedAt")}</th>
            </tr>
          </thead>
          <tbody>
            {linked.length ? (
              linked.map((item, index) => (
                <tr className="usage-table__row" key={`${item.external_id ?? ""}-${index}`}>
                  <td>{item.display_name || item.username}</td>
                  <td>{item.username}</td>
                  <td className="mono">{item.external_id}</td>
                  <td>{item.telegram_username ? `@${item.telegram_username}` : "-"}</td>
                  <td>{formatTime(Number(item.updated_at) || undefined)}</td>
                </tr>
              ))
            ) : (
              <tr className="usage-table__row">
                <td colSpan={5} className="muted">{t("admin.telegram.empty")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
