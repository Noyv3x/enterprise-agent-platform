/* <SecuritySettings/> — public-facing security config form + read-only status
   board (legacy renderSecuritySettings, legacy-app.js:1988-2093).

   Numbers (port / session_ttl_seconds) are kept as STRING state and sent raw —
   the backend parses them; coercing to Number would change the payload. The
   session secret is never seeded (empty = keep existing) and clears after save.
   Form state re-seeds whenever the loaded securityConfig object changes (initial
   async load + the PUT response that replaces it), mirroring the legacy
   full-teardown re-seed without clobbering in-progress typing. */

import { useEffect, useState } from "react";
import { saveSecurityConfig } from "../../../data/adminActions";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { SecurityConfigValues } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Field } from "../../common/Field";
import { StatusBadge } from "../../common/StatusBadge";

interface SecurityFormState {
  publicBaseUrl: string;
  trustedProxy: boolean;
  host: string;
  port: string;
  sessionTtl: string;
  sessionSecret: string;
}

function seedForm(security: SecurityConfigValues): SecurityFormState {
  return {
    publicBaseUrl: security.public_base_url || "",
    trustedProxy: !!security.trusted_proxy,
    host: security.host || "127.0.0.1",
    port: String(security.port || 8765),
    sessionTtl: String(security.session_ttl_seconds || 8 * 60 * 60),
    sessionSecret: "",
  };
}

function StatusRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className="security-status__row">
      <span>{label}</span>
      <StatusBadge ok={ok} label={value} />
    </div>
  );
}

export function SecuritySettings() {
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const securityConfig = useStore((state) => state.securityConfig);
  const security = securityConfig?.config || {};

  const [form, setForm] = useState<SecurityFormState>(() => seedForm(securityConfig?.config || {}));

  useEffect(() => {
    setForm(seedForm(securityConfig?.config || {}));
  }, [securityConfig]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void saveSecurityConfig(store, {
      public_base_url: form.publicBaseUrl,
      trusted_proxy: form.trustedProxy,
      host: form.host,
      port: form.port,
      session_ttl_seconds: form.sessionTtl,
      session_secret: form.sessionSecret,
    });
  };

  return (
    <section className="card config-form security-config">
      <CardHead
        title="公网安全"
        icon="key"
        desc="公开到公网前确认 HTTPS 反代、Cookie、会话与监听边界。"
      />
      <form onSubmit={handleSubmit}>
        <div className="config-grid">
          <div className="field--full">
            <Field label="公网 URL">
              <div className="field-stack">
                <input
                  value={form.publicBaseUrl}
                  placeholder="https://agent.example.com"
                  onChange={(event) => setForm((prev) => ({ ...prev, publicBaseUrl: event.target.value }))}
                />
                <div className="field-help">
                  设为 https:// 域名后，登录 Cookie 会带 Secure，写请求按该域名校验 Origin/Referer。
                </div>
              </div>
            </Field>
          </div>
          <label className="check-row field--full">
            <input
              type="checkbox"
              checked={form.trustedProxy}
              onChange={(event) => setForm((prev) => ({ ...prev, trustedProxy: event.target.checked }))}
            />
            <div className="check-row__text">
              <strong>信任反向代理头</strong>
              <span>只在后端端口不能被公网直连时开启；用于真实客户端 IP、X-Forwarded-Host/Proto。</span>
            </div>
          </label>
          <Field label="监听 Host">
            <div className="field-stack">
              <input
                value={form.host}
                placeholder="127.0.0.1"
                onChange={(event) => setForm((prev) => ({ ...prev, host: event.target.value }))}
              />
              <div className="field-help">{`当前进程：${security.applied_host || "-"}，修改后需重启/重新部署。`}</div>
            </div>
          </Field>
          <Field label="监听 Port">
            <div className="field-stack">
              <input
                type="number"
                min="1"
                max="65535"
                step="1"
                value={form.port}
                onChange={(event) => setForm((prev) => ({ ...prev, port: event.target.value }))}
              />
              <div className="field-help">{`当前进程：${security.applied_port || "-"}，修改后需重启/重新部署。`}</div>
            </div>
          </Field>
          <Field label="Session TTL 秒">
            <div className="field-stack">
              <input
                type="number"
                min="60"
                max={String(30 * 24 * 60 * 60)}
                step="60"
                value={form.sessionTtl}
                onChange={(event) => setForm((prev) => ({ ...prev, sessionTtl: event.target.value }))}
              />
              <div className="field-help">影响新签发的登录会话；建议公网保持有限时长。</div>
            </div>
          </Field>
          <Field label="轮换 Session Secret">
            <div className="field-stack">
              <input
                type="password"
                autoComplete="off"
                placeholder={security.session_secret_configured ? "留空不修改" : "至少 32 字符"}
                value={form.sessionSecret}
                onChange={(event) => setForm((prev) => ({ ...prev, sessionSecret: event.target.value }))}
              />
              <div className="field-help">留空不修改；填入新值后重启会使所有旧会话失效。</div>
            </div>
          </Field>
        </div>
        <div className="form-actions">
          <button className="btn btn--primary" type="submit" disabled={busy}>
            <span>保存安全配置</span>
          </button>
        </div>
      </form>
      <div className="security-status">
        <StatusRow
          label="Secure Cookie"
          ok={!!security.secure_cookie_enabled}
          value={security.secure_cookie_enabled ? "已启用" : "未启用"}
        />
        <StatusRow
          label="Trusted Proxy"
          ok={!!security.trusted_proxy}
          value={security.trusted_proxy ? "信任 X-Forwarded-* 头" : "未信任代理头"}
        />
        <StatusRow
          label="默认 admin/admin"
          ok={!security.admin_default_password_active && !security.allow_default_admin_password}
          value={
            security.admin_default_password_active
              ? "当前可用"
              : security.allow_default_admin_password
                ? "启动项允许"
                : "未启用"
          }
        />
        <StatusRow
          label="Session Secret"
          ok={!!security.session_secret_configured}
          value={security.session_secret_source === "env" ? "来自环境变量" : "已持久化"}
        />
        <StatusRow
          label="监听地址"
          ok={!security.listen_restart_required}
          value={`${security.applied_host || "-"}:${security.applied_port || "-"}${
            security.listen_restart_required ? "，有待重启配置" : ""
          }`}
        />
        <StatusRow
          label="Bootstrap 密码文件"
          ok={!security.bootstrap_password_file_exists}
          value={security.bootstrap_password_file_exists ? "仍存在" : "不存在"}
        />
      </div>
    </section>
  );
}
