/* <TelegramAdminConfig/> — global Telegram bot gateway config + a read-only table
   of users who linked their Telegram (legacy renderTelegramAdminConfig,
   legacy-app.js:2274-2362). Two secret fields (bot_token / webhook_secret) are
   never seeded (empty = keep) and clear via the post-save re-seed
   (loadTelegramConfig replaces telegramConfig). The linked table's grid columns
   are driven by the inline --usage-cols custom property. */

import { useEffect, useState } from "react";
import { saveTelegramConfig } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { formatTime } from "../../../utils/format";
import type { TelegramConfigValues } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Field } from "../../common/Field";
import { StatusBadge } from "../../common/StatusBadge";

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
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const telegramConfig = useStore((state) => state.telegramConfig);
  const config = telegramConfig?.config || {};
  const linked = telegramConfig?.linked_users || [];
  const webhookUrl = config.webhook_url || "保存 webhook secret 后生成 URL";

  const [form, setForm] = useState<TelegramFormState>(() => seedForm(telegramConfig?.config || {}));

  useEffect(() => {
    setForm(seedForm(telegramConfig?.config || {}));
  }, [telegramConfig]);

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
        title="Telegram 私聊网关"
        icon="message"
        desc="全局 bot 由管理员配置；每个用户在私人 Agent 页面绑定自己的 Telegram ID。"
        extra={
          <StatusBadge
            ok={!!config.enabled && !!config.bot_token_configured}
            label={config.enabled ? "已启用" : "未启用"}
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
              <strong>启用 Telegram 私聊</strong>
              <span>只接收 private chat，不处理群组或频道</span>
            </div>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.polling}
              onChange={(event) => setForm((prev) => ({ ...prev, polling: event.target.checked }))}
            />
            <div className="check-row__text">
              <strong>Long polling</strong>
              <span>关闭后使用 webhook URL 接收 update</span>
            </div>
          </label>
          <Field label="Bot 用户名">
            <input
              value={form.botUsername}
              placeholder="your_bot_username"
              onChange={(event) => setForm((prev) => ({ ...prev, botUsername: event.target.value }))}
            />
          </Field>
          <Field label="Bot Token">
            <input
              type="password"
              autoComplete="off"
              placeholder={config.bot_token_configured ? "保持不变" : "BotFather token"}
              value={form.botToken}
              onChange={(event) => setForm((prev) => ({ ...prev, botToken: event.target.value }))}
            />
          </Field>
          <div className="field--full">
            <Field label="Webhook Secret">
              <input
                type="password"
                autoComplete="off"
                placeholder={config.webhook_secret_configured ? "保持不变" : "8-128 位 URL-safe secret"}
                value={form.webhookSecret}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, webhookSecret: event.target.value }))
                }
              />
            </Field>
          </div>
          <div className="field--full field-stack">
            <span className="field-help">Webhook URL</span>
            <code className="mono">{webhookUrl}</code>
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn--primary" type="submit" disabled={busy}>
            <span>保存 Telegram 配置</span>
          </button>
        </div>
      </form>
      <div className="usage-table" style={{ marginTop: "14px" }}>
        <div
          className="usage-table__row usage-table__row--head"
          style={{ "--usage-cols": 5 } as React.CSSProperties}
        >
          <div>平台用户</div>
          <div>用户名</div>
          <div>Telegram ID</div>
          <div>Telegram 用户名</div>
          <div>更新时间</div>
        </div>
        {linked.length ? (
          linked.map((item, index) => (
            <div
              className="usage-table__row"
              key={`${item.external_id ?? ""}-${index}`}
              style={{ "--usage-cols": 5 } as React.CSSProperties}
            >
              <div>{item.display_name || item.username}</div>
              <div>{item.username}</div>
              <div className="mono">{item.external_id}</div>
              <div>{item.telegram_username ? `@${item.telegram_username}` : "-"}</div>
              <div>{formatTime(Number(item.updated_at) || undefined)}</div>
            </div>
          ))
        ) : (
          <div className="muted">暂无用户绑定 Telegram。</div>
        )}
      </div>
    </section>
  );
}
