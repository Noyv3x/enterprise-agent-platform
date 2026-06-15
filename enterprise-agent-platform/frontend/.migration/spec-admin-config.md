# Migration Spec — Admin Config Pages + Generic Config-Form Engine

Source: `frontend/src/legacy-app.js` lines **1988–2666** (plus helpers).
Target: React 19 + TypeScript components, replacing full-teardown `app.replaceChildren()` rendering.

This section covers the admin "settings"-style pages and the **generic descriptor-driven
config-form engine** that powers the Hermes-internal / Cognee env editors.

> CRITICAL: Every endpoint path, HTTP method, request-body key, and response field below is
> reproduced verbatim from the legacy code and MUST be preserved exactly. The backend treats
> these as a contract (e.g. it accepts string-typed numbers like `port.value`, and uses the
> presence/absence of a key to decide whether to update a secret).

---

## 0. Shared infrastructure these components depend on

### 0.1 `state` fields (global mutable object, `legacy-app.js:8`)
This section reads/writes these top-level `state` fields:

| Field | Shape | Loaded by | Written by |
|---|---|---|---|
| `state.securityConfig` | `{ config: {...}, restart_required?, session_secret_restart_required?, ... }` | `loadSecurityConfig()` → `GET /api/system/security/config` | security form submit (sets `state.securityConfig = result`) |
| `state.runtimes` | `{ [name]: RuntimeRow }` or `null` | `loadRuntime()` → `GET /api/system/runtime` | runtime restart/install reload |
| `state.hermesConfig` | `{ config: {...} }` or `null` | `loadHermesConfig()` → `GET /api/system/hermes/config` | hermes config form (via `loadSettings`) |
| `state.telegramConfig` | `{ config: {...}, linked_users: [...] }` or `null` | `loadTelegramConfig()` → `GET /api/system/telegram/config` | telegram form (via `loadTelegramConfig`) |
| `state.autoUpdateConfig` | `{ config: {...}, status: {...} }` or `null` | `loadAutoUpdateConfig()` → `GET /api/system/auto-update/config` | auto-update form |
| `state.hermesInternalConfig` | `{ internal: {...} }` or `null` | `loadHermesInternalConfig()` → `GET /api/system/hermes/internal-config` | hermes internal forms |
| `state.cogneeConfig` | `{ internal: {...} }` or `null` | `loadCogneeConfig()` → `GET /api/system/cognee/config` | cognee form |
| `state.oauthProviders` | `{ providers: [...], active_provider? }` or `null` | `loadOAuthProviders()` → `GET /api/system/oauth/providers` | (read for model catalog) |
| `state.secrets` | `Secret[]` | `loadSecrets()` → `GET /api/settings/secrets` (returns `{ secrets }`) | secret-row form |
| `state.busy` | `boolean` | `withBusy()` toggles | disables all submit/action buttons |
| `state.error` | `string` | `withBusy()` sets on failure | — |
| `state.activeAdminPage` | `string` (page id) | nav clicks | admin pager |

All `load*` helpers are at `legacy-app.js:3235-3252`. `loadSettings()` (3252) runs them all in
parallel: `loadSecrets, loadRuntime, loadSecurityConfig, loadHermesConfig, loadTelegramConfig,
loadAutoUpdateConfig, loadHermesInternalConfig, loadCogneeConfig, loadOAuthProviders`.

### 0.2 `api(path, options)` (legacy-app.js:73)
- `fetch(path, { credentials: "include", headers: { "Content-Type": "application/json", ... }, ...options })`.
  (FormData bodies skip the JSON content-type; not used in this section.)
- Reads `res.text()`, then `JSON.parse` guarded by try/catch (HTML proxy error pages → `{}`).
- On `res.status === 401` (and not `skipAuthHandling`) calls `handleSessionExpired()`.
- On `!res.ok` throws `new Error(data.error || data.detail || `请求失败（${res.status}）`)`.
- Returns parsed JSON object.

### 0.3 `withBusy(fn)` (legacy-app.js:3466)
```
state.busy = true; state.error = ""; render();
try { await fn(); }
catch (e) { state.error = e.message; if (state.user) toast(e.message, {type:"error", title:"操作失败"}); }
finally { state.busy = false; render(); }
```
Every form submit / action button in this section wraps its work in `withBusy`. In React this
becomes a `busy` boolean + try/catch + a `toast` call; errors are surfaced via toast, never thrown.

### 0.4 `toast(message, {type, title})` (legacy-app.js:247)
Appends an auto-dismissing toast node to `#toast-stack`. `type: "ok"` → check icon, 3.2s; else
alert icon, 6.5s. Migrate to a toast context/provider; calls in this section all pass
`{ type: "ok", title: "完成" }` (or `"需要重启"`, `"已发送"`, `"已更新 X"`).

### 0.5 DOM/markup helpers (to be replaced by JSX)
- `h(tag, attrs, children)` (117) — hyperscript. `class`→className, `text`→textContent, `on*`→
  addEventListener, `href`/`src` sanitized via `safeUrl`, boolean `true`→empty attr, `false`/`null`→omit.
- `icon(name, {size, cls, strokeWidth})` (196) — inline SVG from `ICONS` map; `aria-hidden="true"`,
  `stroke="currentColor"`, default stroke-width 1.7. Icons used here: `key, server, settings,
  message, refresh, shield, library, users, download, upload, plus, refresh`.
- `field(label, control)` (331) → `<label class="field"><span>{label}</span>{control}</label>`.
- `cardHead(title, iconName, {desc, extra})` (334) → `<div class="card__head"><div><div class="card__title">{icon}{title}</div><div class="card__desc">{desc}</div></div>{extra}</div>`.
- `statusBadge(ok, label)` (343) → `<span class="status status--ok|warn"><span class="dot [dot--warn]"></span>{label-textnode}</span>`.
- `usageMetric(label, value, suffix)` (1671) → `<div class="metric-tile"><span>{label}</span><strong>{value|formatNumber}</strong>{suffix?<small>}</div>`. If `value` is a string it is shown verbatim; numbers go through `formatNumber` (Intl.NumberFormat).
- `formatTime(unixSeconds)` (2814) — relative-ish local time; `value*1000`, returns "" for falsy.
- `shortSha(value)` (2831) — first 7 chars, else `"-"`.
- `isOAuthSecret(key)` (2803) — `key.includes("_OAUTH_")`.

### 0.6 Permission gating
`renderAdminPanel()` (1342) gates the **entire** admin area: `if (!isAdmin()) return emptyState(...)`.
`isAdmin()` (352) = `role === "admin" || permission_group === "admin" || permissions.has("system_settings")`.
No finer-grained gating inside the config pages — all sections assume admin. In React, gate at the
admin route boundary; individual config components can assume admin context.

---

## 1. Admin page shell + routing (context for this section)

### `AdminPanel` / page router (legacy-app.js:1342–1423)
- `ADMIN_PAGES` (182) is the ordered page list. The pages owned by THIS spec:
  `model` (OAuth + Hermes config), `telegram`, `updates`, `security`, `runtime`, `hermes`,
  `cognee`, `secrets`. (`accounts`, `tokens`, `messages` belong to other specs.)
  Each entry: `{ id, label, icon, description }`.
- `renderAdminPageSections(pageId)` (1410) maps id → array of section render fns:
  - `model` → `[renderOAuthSettings(), renderHermesConfig()]`  ← Hermes config is mine; OAuth is referenced
  - `telegram` → `[renderTelegramAdminConfig()]`
  - `updates` → `[renderAutoUpdateConfig()]`
  - `security` → `[renderSecuritySettings()]`
  - `runtime` → `[renderRuntimeSettings()]`
  - `hermes` → `[renderHermesInternalConfig()]`
  - `cognee` → `[renderCogneeInternalConfig()]`
  - `secrets` → `[renderSecretsSettings()]`
- `renderAdminPager(activeId)` (1367): `<nav class="admin-pager" aria-label="管理面板分页">` of
  `<button class="admin-pager__item [is-active]" aria-current={active?"page":null}>`. On click sets
  `state.activeAdminPage = page.id`; for `messages`→`withBusy(loadMessageAudit)`,
  `tokens`→`withBusy(loadTokenUsage)`, else just `render()`. (Config pages do NOT lazy-load on
  click — their data must already be loaded by `loadAdminPanel()` → `loadSettings()`.)
- `adminPageBadge(pageId)` (1388): small numeric/`"on"` badge. For my pages:
  - `model`: `oauthProviders.providers.length`
  - `telegram`: `enabled ? (linked_users.length || "on") : 0`
  - `updates`: `config.enabled ? "on" : 0`
  - `security`: count of `[secure_cookie_enabled===false, admin_default_password_active, allow_default_admin_password, listen_restart_required]` truthy
  - `runtime`: `Object.keys(runtimes).length`
  - `secrets`: count of non-OAuth secrets
- Page header markup: `<div class="admin-page admin-page--{id}">` → `.admin-page__head` (eyebrow
  "管理分页", `<h2>{label}</h2>`, `<p>{description}</p>`, `<span class="status">{idx+1}/{total}</span>`)
  → `.admin-page__content` containing the sections.
- Post-render hook `syncActiveAdminPager()` (299): on mobile (`max-width:800px`) scrolls the active
  pager item into view (`scrollIntoView({block:"nearest",inline:"center"})`). Preserve in React via
  a `useEffect` + ref on the active pager button.

**React routing note:** convert `activeAdminPage` to a router param or `useState` in an
`AdminLayout`. Data loading for config pages should be lazy per-page (the legacy code eagerly loads
ALL settings up front via `loadAdminPanel`; a React rewrite can fetch per page with React Query /
`useEffect`, but must still call the same endpoints). Keep eager prefetch if you want the badges to
populate without visiting each page (badges read from the already-loaded state).

---

## 2. `SecuritySettings` — `renderSecuritySettings()` (1988–2093)

**Purpose:** Configure public-facing security (HTTPS reverse-proxy URL, trusted proxy, listen
host/port, session TTL, session-secret rotation) and show a read-only status board.

### Markup
```
<section class="card config-form security-config">
  cardHead("公网安全", "key", {desc:"公开到公网前确认 HTTPS 反代、Cookie、会话与监听边界。"})
  <form onsubmit=...>
    <div class="config-grid">
      <div class="field--full"> field("公网 URL", <div class="field-stack">[ publicBaseUrl, <div class="field-help">…</div> ]>) </div>
      <label class="check-row field--full"> trustedProxy(checkbox) <div class="check-row__text"><strong>信任反向代理头</strong><span>…</span></div> </label>
      field("监听 Host",  field-stack[ host,        field-help "当前进程：{applied_host}，修改后需重启/重新部署。" ])
      field("监听 Port",  field-stack[ port,        field-help "当前进程：{applied_port}，…" ])
      field("Session TTL 秒", field-stack[ sessionTtl, field-help "影响新签发的登录会话；…" ])
      field("轮换 Session Secret", field-stack[ sessionSecret, field-help "留空不修改；…" ])
    </div>
    <div class="form-actions"><button class="btn btn--primary" type="submit" disabled={busy}><span>保存安全配置</span></button></div>
  </form>
  <div class="security-status"> {statusRows} </div>
</section>
```

### Inputs (controlled, seeded from `state.securityConfig.config` = `security`)
- `publicBaseUrl`: text, value `security.public_base_url || ""`, placeholder `https://agent.example.com`.
- `trustedProxy`: checkbox, `.checked = !!security.trusted_proxy`.
- `host`: text, value `security.host || "127.0.0.1"`, placeholder `127.0.0.1`.
- `port`: number, `min=1 max=65535 step=1`, value `security.port || 8765`.
- `sessionTtl`: number, `min=60 max=2592000 step=60`, value `security.session_ttl_seconds || 28800`.
- `sessionSecret`: password, `autocomplete=off`, placeholder = `security.session_secret_configured ? "留空不修改" : "至少 32 字符"`. **Never seeded with a value.**

### Status rows (`securityStatusRow(label, ok, value)` → `.security-status__row` = `<span>{label}</span>{statusBadge(ok,value)}`)
Order + logic (all from `security`):
1. `"Secure Cookie"`, ok=`!!secure_cookie_enabled`, value=`已启用|未启用`.
2. `"Trusted Proxy"`, ok=`!!trusted_proxy`, value=`信任 X-Forwarded-* 头|未信任代理头`.
3. `"默认 admin/admin"`, ok=`!admin_default_password_active && !allow_default_admin_password`,
   value=`admin_default_password_active ? "当前可用" : (allow_default_admin_password ? "启动项允许" : "未启用")`.
4. `"Session Secret"`, ok=`!!session_secret_configured`, value=`session_secret_source==="env" ? "来自环境变量" : "已持久化"`.
5. `"监听地址"`, ok=`!listen_restart_required`, value=`${applied_host||"-"}:${applied_port||"-"}${listen_restart_required?"，有待重启配置":""}`.
6. `"Bootstrap 密码文件"`, ok=`!bootstrap_password_file_exists`, value=`仍存在|不存在`.

### Submit handler
```
PUT /api/system/security/config
body: {
  public_base_url: publicBaseUrl.value,   // string
  trusted_proxy:   trustedProxy.checked,  // boolean
  host:            host.value,            // string
  port:            port.value,            // STRING (raw input value, not Number)
  session_ttl_seconds: sessionTtl.value,  // STRING
  session_secret:  sessionSecret.value,   // string ("" = no change)
}
```
On success:
- `state.securityConfig = result` (whole response replaces state).
- `sessionSecret.value = ""` (clear the secret input).
- `needsRestart = !!result.restart_required`; `secretRestart = !!result.session_secret_restart_required`.
- toast: if `secretRestart` → "已保存；重启后所有会话会失效"; else if `needsRestart` →
  "已保存；部分启动项需要重启/重新部署后生效"; else "公网安全配置已保存". Title = "需要重启" if
  either restart flag, else "完成". type `ok`.
- `render()`.

**Response fields consumed:** the whole object becomes `state.securityConfig`, and
`.restart_required`, `.session_secret_restart_required` drive the toast; `.config` (re-read on next
render) drives the form + status board.

### React notes
- `SecuritySettings` component. Local form state via `useReducer` or one `useState` object seeded
  from `securityConfig.config`. Re-seed on `securityConfig` change (`useEffect` dep, or `key` prop).
- Keep `port`/`sessionTtl` as **string** state and send raw string (backend tolerant). Do NOT coerce
  to number before sending — preserve payload shape.
- Status board is pure derived render → a `SecurityStatusBoard` subcomponent or inline `.map`.
- Accessibility gaps: status rows are plain spans (no `role`); inputs rely on `<label class="field">`
  wrapping (implicit label association). Keep the label/control nesting. Consider adding `aria-live`
  on the status board so restart-required changes are announced (currently none).

---

## 3. `RuntimeSettings` — `renderRuntimeSettings()` (2095–2128) + `runHermesInstall()` (2130–2136)

**Purpose:** Health board for managed runtimes (Hermes / Cognee / Camofox / Firecrawl) with
per-runtime restart/refresh and a Hermes-only install action.

### Data source: `state.runtimes` — object keyed by runtime name; iterated via `Object.values`.
`RuntimeRow` fields read: `name`, `available` (bool), `state` (string), `detail`, `error`, `path`,
`managed` (bool). When `state.runtimes` is `null` → single `<div class="muted">正在读取运行时状态…</div>`.

### Markup (per runtime row)
```
<div class="runtime-row">
  <div class="runtime-row__main">
    <div class="runtime-row__title">
      <span class="dot dot--pulse|dot--off"/>            // pulse if available else off
      <span class="runtime-row__name">{name}</span>
      statusBadge(available, state || (available?"ready":"down"))
    </div>
    <div class="runtime-row__detail">{detail || error || path || ""}</div>
  </div>
  <div class="runtime-row__actions">
    {name==="hermes" ? <button class="btn btn--sm" disabled={busy} onclick=runHermesInstall>[icon download 14]<span>安装</span></button> : null}
    <button class="btn btn--sm" disabled={busy} onclick=restart>[icon refresh 14]<span>{managed && name!=="cognee" ? "重启" : "刷新"}</span></button>
  </div>
</div>
```
Wrapped in `<section class="card">[ cardHead("底层基座","server",{desc:"平台托管的 Hermes / Cognee / Camofox / Firecrawl 运行时健康状态。"}), <div class="list">{rows}</div> ]`.

### Actions
- **Restart/Refresh button** (every row): `withBusy(async () => { await api(`/api/system/runtime/${runtime.name}/restart`, { method:"POST", body:"{}" }); await loadSettings(); })`.
  Note: button label is "重启" only when `managed && name!=="cognee"`, else "刷新", but the endpoint
  is the same `.../restart` regardless. Reloads ALL settings (loadSettings), not just runtime.
- **Install button** (hermes only): `runHermesInstall()` →
  `withBusy(async () => { await api("/api/system/runtime/hermes/install", { method:"POST", body:"{}" }); await loadSettings(); toast("已触发 Hermes 安装", {type:"ok", title:"完成"}); })`.

### React notes
- `RuntimeSettings` maps `Object.values(runtimes)` to `RuntimeRow` components. No local state.
- After restart/install, refetch settings (or at least runtime + dependent configs — legacy refetches
  everything via `loadSettings`; safest to mirror that). Buttons disabled while `busy`.
- Loading state: `runtimes === null`. No explicit error row (errors surface via toast from withBusy).
- A11y gap: dots/badges are decorative spans; the row has no `role`/`aria-label`. Consider grouping
  with a list role and labeling the status.

---

## 4. Hermes model catalog helpers (used by Hermes config + accounts page)

These three pure helpers compute the model dropdown options from cached state. **No network calls.**

### `hermesModelCatalog(providerId)` (2138–2151)
- Normalize: providerId must be in `["openai-codex","xai-oauth"]`, else `"openai-codex"`.
- Prefer `state.hermesConfig.config.model_catalog[normalized]` if it's an object → return as-is
  (`{ models, default_model, error }`).
- Else find in `state.oauthProviders.providers` by `id===normalized` → return
  `{ models: provider.models||[], default_model: provider.default_model||"", error: provider.model_catalog_error||"" }`.
- Else `{ models: [], default_model: "", error: "Hermes 模型目录不可用" }`.

### `activeHermesProviderId()` (2153–2156)
`state.oauthProviders.active_provider || state.hermesConfig.config.provider || "openai-codex"`,
clamped to `["openai-codex","xai-oauth"]` (fallback `"openai-codex"`).

### `accountModelControl(selectedModel="")` (2158–2183)
Builds a `<select>` + hint `<div class="field-help">` wrapped in `<div class="field-stack">`. Used by
the **accounts page** create/edit forms (lines 1432, 1487 — other spec) but lives in my range.
- Provider = `activeHermesProviderId()`, catalog = `hermesModelCatalog(provider)`.
- Options: first `<option value="">系统默认 ({defaultModel})</option>` where
  `defaultModel = catalog.default_model || hermesConfig.config.model || "系统默认"`, then one option
  per `catalog.models` entry.
- Selected: if `selectedModel` (trimmed) is in `models` → select it, else select `""`.
- Hint text: if saved model not in catalog → "已保存模型 {clean} 不在当前 Hermes 目录，保存后将改为系统默认。";
  else if models present → "{n} 个模型,来源:Hermes"; else `catalog.error || "当前仅可使用系统默认模型。"`.
- Returns `{ select, control }` so callers can read `select.value`.

### React notes
- Convert to a `useHermesModelCatalog()` hook (memoized over `hermesConfig` + `oauthProviders`) and a
  `<ModelSelect value onChange catalog defaultModelLabel />` component returning `{value, hint}`.
- The legacy `{select, control}` return exists only because the imperative caller needs the live
  `<select>` DOM node to read `.value` at submit time → in React this is just controlled `value`.

---

## 5. `HermesConfig` — `renderHermesConfig()` (2185–2272)

**Purpose:** Configure the managed Hermes runtime source + OAuth provider + model + timeouts +
API-server key. Lives on the `model` admin page below `renderOAuthSettings()`.

### Inputs (seeded from `state.hermesConfig.config` = `hermes`)
- `manageHermes`: checkbox, `.checked = hermes.manage_hermes !== false` (default ON).
- `repoPath`: text, `hermes.repo_path || ""`.
- `apiUrl`: text, `hermes.api_url || ""`.
- `provider`: `<select>` with options `openai-codex`("Codex OAuth"), `xai-oauth`("Grok OAuth"); value
  clamped to those two (fallback `openai-codex`).
- `providerBaseUrl`: text, `hermes.provider_base_url || ""`, placeholder "默认使用所选 OAuth 供应商 endpoint".
- `model`: `<select>` + `modelHint` (`.field-help`), wrapped `<div class="field-stack">`. Populated by
  `syncModelOptions(preferred)` (see below).
- `installExtras`: text, `hermes.install_extras || ""`, placeholder "可选,例如 dev".
- `startupWait`: number `min=0 max=120 step=0.5`, value `hermes.startup_wait_seconds ?? 8`.
- `timeoutSeconds`: number `min=1 max=3600 step=1`, value `hermes.timeout_seconds ?? 240`.
- `apiKey`: password `autocomplete=off`, placeholder `hermes.api_key_configured ? "保持不变" : "API server key"`.

### `syncModelOptions(preferredModel="")` (2199–2215) — dynamic dependent dropdown
- `catalog = hermesModelCatalog(provider.value)`; `models = catalog.models`.
- If no models: replace options with single `<option value="">Hermes 模型目录不可用</option>`, set
  `model.value=""`, `model.disabled=true`, `modelHint = catalog.error || "需要先安装/启动托管 Hermes 后读取模型目录。"`.
- Else: `model.disabled=false`, options = models; selected = `current` if in models, else `fallback`
  (catalog.default_model) if in models, else `models[0]`; hint = "{n} 个模型,来源:Hermes".
- Wired: `provider.addEventListener("change", () => syncModelOptions(""))` (changing provider resets
  model to default for that provider). Initial call `syncModelOptions(hermes.model || "")`.

### Markup
```
<section class="card config-form">
  cardHead("Hermes 配置","settings",{desc:"运行时来源、API 供应商与模型参数。"})
  <form onsubmit=...>
    <label class="check-row">{manageHermes}<div class="check-row__text"><strong>由平台托管 Hermes</strong><span>自动安装与管理运行时生命周期</span></div></label>
    <div class="config-grid">
      <div class="field--full">field("源码路径", repoPath)</div>
      <div class="field--full">field("API URL", apiUrl)</div>
      field("API 供应商", provider)
      field("供应商 Base URL", providerBaseUrl)
      field("模型", modelControl)
      field("安装 extras", installExtras)
      field("启动等待秒数", startupWait)
      field("请求超时秒数", timeoutSeconds)
      field("API Server Key", apiKey)
    </div>
    <div class="form-actions">
      <button class="btn btn--primary" type="submit" disabled={busy}><span>保存配置</span></button>
      <button class="btn" type="button" disabled={busy} onclick=runHermesInstall>[icon download 15]<span>从源码重装</span></button>
    </div>
  </form>
</section>
```

### Submit handler
```
PUT /api/system/hermes/config
body: {
  manage_hermes:        manageHermes.checked,   // boolean
  repo_path:            repoPath.value,          // string
  api_url:              apiUrl.value,            // string
  provider:             provider.value,          // "openai-codex" | "xai-oauth"
  provider_base_url:    providerBaseUrl.value,   // string
  model:                model.value,             // string (may be "")
  install_extras:       installExtras.value,     // string
  startup_wait_seconds: startupWait.value,       // STRING
  timeout_seconds:      timeoutSeconds.value,    // STRING
  api_key:              apiKey.value,            // string ("" = keep existing)
}
```
On success: `apiKey.value=""`, `await loadSettings()`, toast "Hermes 配置已保存" {ok, 完成}.
The secondary "从源码重装" button calls `runHermesInstall()` (§3).

### React notes
- `HermesConfig` component, controlled form state seeded from `hermesConfig.config`.
- Model dropdown becomes a derived/dependent control: when `provider` changes, recompute options via
  `hermesModelCatalog(provider)` and reset selected model to default-for-provider (mirror
  `syncModelOptions("")`). Use `useMemo` over `(provider, hermesConfig, oauthProviders)`.
- Number inputs sent as strings — keep string state, send raw.
- Secret fields (`api_key`): empty means "no change"; never echo back; clear after save.

---

## 6. `TelegramAdminConfig` — `renderTelegramAdminConfig()` (2274–2362)

**Purpose:** Global Telegram bot gateway config + read-only table of users who linked their Telegram.

### Data: `state.telegramConfig` = `payload`; `config = payload.config`; `linked = payload.linked_users || []`.
`config` fields read: `enabled`, `polling`, `bot_username`, `bot_token_configured`,
`webhook_secret_configured`, `webhook_url`. `linked_users[]` items:
`{ display_name, username, external_id, telegram_username, updated_at }`.

### Inputs
- `enabled`: checkbox, `.checked = !!config.enabled`.
- `polling`: checkbox, `.checked = config.polling !== false` (default ON).
- `botUsername`: text, `config.bot_username || ""`, placeholder "your_bot_username".
- `botToken`: password `autocomplete=off`, placeholder `config.bot_token_configured ? "保持不变" : "BotFather token"`.
- `webhookSecret`: password `autocomplete=off`, placeholder `config.webhook_secret_configured ? "保持不变" : "8-128 位 URL-safe secret"`.
- `webhookUrl` (read-only display): `config.webhook_url || "保存 webhook secret 后生成 URL"`, shown in `<code class="mono">`.

### Markup
```
<section class="card config-form">
  cardHead("Telegram 私聊网关","message",{desc:"全局 bot 由管理员配置;...", extra: statusBadge(!!enabled && !!bot_token_configured, enabled?"已启用":"未启用")})
  <form onsubmit=...>
    <div class="config-grid">
      <label class="check-row">{enabled}<div class="check-row__text"><strong>启用 Telegram 私聊</strong><span>只接收 private chat,不处理群组或频道</span></div></label>
      <label class="check-row">{polling}<div class="check-row__text"><strong>Long polling</strong><span>关闭后使用 webhook URL 接收 update</span></div></label>
      field("Bot 用户名", botUsername)
      field("Bot Token", botToken)
      <div class="field--full">field("Webhook Secret", webhookSecret)</div>
      <div class="field--full field-stack"><span class="field-help">Webhook URL</span><code class="mono">{webhookUrl}</code></div>
    </div>
    <div class="form-actions"><button class="btn btn--primary" type="submit" disabled={busy}><span>保存 Telegram 配置</span></button></div>
  </form>
  <div class="usage-table" style="margin-top:14px">
    <div class="usage-table__row usage-table__row--head" style="--usage-cols:5"> 平台用户 | 用户名 | Telegram ID | Telegram 用户名 | 更新时间 </div>
    {linkedRows}
  </div>
</section>
```
Linked row (`--usage-cols:5`): `[ display_name||username, username, <div class="mono">external_id</div>, telegram_username?`@{x}`:"-", formatTime(updated_at) ]`.
Empty: `<div class="muted">暂无用户绑定 Telegram。</div>`.

### Submit handler
```
PUT /api/system/telegram/config
body: {
  enabled:        enabled.checked,        // boolean
  polling:        polling.checked,        // boolean
  bot_username:   botUsername.value,      // string
  bot_token:      botToken.value,         // string ("" = keep)
  webhook_secret: webhookSecret.value,    // string ("" = keep)
}
```
On success: `botToken.value=""`, `webhookSecret.value=""`, `await loadTelegramConfig()`, toast
"Telegram 配置已保存" {ok, 完成}. (Note: reloads ONLY telegram config, not all settings.)

### React notes
- `TelegramAdminConfig` with controlled form state from `config`. Linked table is a derived
  read-only subcomponent (`LinkedTelegramUsers`). Two secret fields clear after save.
- `--usage-cols` is a CSS custom property on the row controlling grid columns — preserve via inline
  `style={{ "--usage-cols": 5 }}`.

---

## 7. `AutoUpdateConfig` — `renderAutoUpdateConfig()` (2364–2456)

**Purpose:** Configure GitHub-webhook/polling auto-update watcher + show update status metrics.

### Data: `state.autoUpdateConfig` = `payload`; `config = payload.config`; `status = payload.status`.
`config`: `enabled`, `interval_seconds`, `remote`, `branch`, `webhook_secret_configured`, `webhook_url`.
`status`: `in_progress`, `update_started`, `update_available`, `dirty`, `current_revision`,
`remote_revision`, `last_check_at`, `last_trigger`, `last_error`, `dirty_summary`.

### Inputs
- `enabled`: checkbox `.checked = !!config.enabled`.
- `interval`: number `min=5 max=3600 step=1`, value `config.interval_seconds || 30`.
- `remote`: text, `config.remote || "origin"`, placeholder "origin".
- `branch`: text, `config.branch || ""`, placeholder "留空使用当前分支".
- `webhookSecret`: password `autocomplete=off`, placeholder `config.webhook_secret_configured ? "保持不变" : "至少 16 位 secret"`.
- `webhookUrl` (display): `config.webhook_url || "启用后自动生成 webhook URL"` in `<code class="mono">`.

### Derived display
- `updateState` = `status.in_progress?"检查中": status.update_started?"已触发更新": status.update_available?"发现更新":"待命"`.
- `clean = !status.dirty`.

### Markup
```
<section class="card config-form">
  cardHead("自动更新监听","refresh",{desc:"...", extra: statusBadge(!!enabled, enabled?"已启用":"未启用")})
  <form onsubmit=...>
    <div class="config-grid">
      <label class="check-row">{enabled}<div class="check-row__text"><strong>启用常驻监听</strong><span>...deploy.sh update</span></div></label>
      field("轮询间隔(秒)", interval)
      field("Git remote", remote)
      field("分支", branch)
      <div class="field--full">field("Webhook Secret", webhookSecret)</div>
      <div class="field--full field-stack"><span class="field-help">GitHub Webhook URL</span><code class="mono">{webhookUrl}</code></div>
    </div>
    <div class="form-actions">
      <button class="btn btn--primary" type="submit" disabled={busy}><span>保存自动更新配置</span></button>
      <button class="btn" type="button" disabled={busy || !config.enabled} onclick=checkNow>[icon refresh 15]<span>立即检查</span></button>
    </div>
  </form>
  <div class="metric-grid metric-grid--compact">
    usageMetric("状态", updateState)
    usageMetric("工作树", clean?"干净":"有本地改动")
    usageMetric("当前版本", shortSha(status.current_revision))
    usageMetric("远端版本", shortSha(status.remote_revision))
    usageMetric("最近检查", formatTime(status.last_check_at) || "-")
    usageMetric("最近触发", status.last_trigger || "-")
  </div>
  {status.last_error ? <div class="notice notice--warn">{status.last_error}</div> : null}
  {status.dirty_summary ? <pre class="config-preview">{status.dirty_summary}</pre> : null}
</section>
```

### Handlers
- **Save** submit:
  ```
  PUT /api/system/auto-update/config
  body: {
    enabled:          enabled.checked,    // boolean
    interval_seconds: interval.value,     // STRING
    remote:           remote.value,       // string
    branch:           branch.value,       // string
    webhook_secret:   webhookSecret.value,// string ("" = keep)
  }
  ```
  Then `webhookSecret.value=""`, `await loadAutoUpdateConfig()`, toast "自动更新配置已保存" {ok, 完成}.
- **立即检查** button (disabled when `busy || !config.enabled`):
  `withBusy(async()=>{ await api("/api/system/auto-update/check", {method:"POST", body:"{}"}); await loadAutoUpdateConfig(); toast("已触发自动更新检查", {type:"ok", title:"已发送"}); })`.

### React notes
- `AutoUpdateConfig` with controlled form + derived status metric grid (`AutoUpdateStatus`
  subcomponent). The status is NOT live-polled here — it only refreshes when the user saves or
  clicks "立即检查". A React rewrite MAY add polling, but legacy behavior is on-demand only; keep
  parity unless asked. `metric-grid--compact` and `usageMetric` reused from dashboard.

---

## 8. Generic Config-Form Engine (Hermes-internal + Cognee) — THE REUSABLE `<ConfigForm>`

This is the centerpiece: a **field-descriptor-driven** form used to edit Hermes `config.yaml` keys,
Hermes `.env`, and Cognee `.env`. It must become a reusable React `<ConfigForm>`.

### 8.1 Field descriptor shape (`item`)
Each descriptor (server-provided, in `internal.fields` / `internal.env`) has:
| key | meaning |
|---|---|
| `key` | the config key (sent back as the update map key; also rendered as `<code>`) |
| `label` | display label (falls back to `key`) |
| `group` | grouping bucket (falls back to `"配置"`) |
| `kind` | `"boolean"` \| `"number"` \| `"json"` \| (default text) |
| `options` | optional `string[]` → renders a select of those options |
| `value` | current value (string/bool/number) |
| `configured` | bool — whether a value is set (affects secret display + whether value shown) |
| `defaulted` | bool — value comes from a default (shows "默认值" pill; counts as displayable) |
| `secret` | bool — render password input, mask, omit-if-empty on submit |
| `masked` | masked display string for secrets (used as placeholder) |

Helper `hasDisplayValue = !!item.configured || !!item.defaulted` (configFieldControl:2589).

### 8.2 `renderConfigFieldsForm({ fields, attr, buttonText, onsubmit })` (2541–2557)
- If `!fields.length` → `<div class="muted">正在读取配置…</div>` (loading state).
- Else `<form class="config-fields-form" onsubmit=...>`:
  - `<div class="config-groups">{groupedConfigFields(fields, attr)}</div>`
  - `<div class="form-actions"><button class="btn btn--primary" type="submit" disabled={busy}><span>{buttonText}</span></button></div>`
- On submit: `event.preventDefault(); const updates = collectConfigUpdates(form, attr); if (!Object.keys(updates).length) return; await onsubmit(updates);`
- `attr` is either `"yamlKey"` or `"envKey"` — controls the `data-*` attribute used to tag controls
  and the diff selector.

### 8.3 `groupedConfigFields(fields, attr)` (2559–2571)
- Group fields by `item.group || "配置"` (insertion order preserved).
- Each group → `<details class="config-group" open={index<2}>` (first 2 groups open by default):
  - `<summary><span>{group}</span><span class="nav__badge">{count}</span></summary>`
  - `<div class="config-group__body">{items.map(renderConfigField)}</div>`

### 8.4 `renderConfigField(item, attr)` (2573–2584)
```
<label class="config-field">
  <span class="config-field__label">
    <strong>{item.label || item.key}</strong>
    <span class="config-field__meta">
      {item.defaulted ? <span class="config-field__source">默认值</span> : null}
      <code>{item.key}</code>
    </span>
  </span>
  {configFieldControl(item, attr)}
</label>
```

### 8.5 `configFieldControl(item, attr)` (2586–2625) — control type matrix
`dataAttr = attr==="yamlKey" ? "data-yaml-key" : "data-env-key"`; `common = { [dataAttr]: item.key }`.
Every control also gets `dataset.initial` set to its rendered value (used for diffing).

| Condition (in order) | Control | Value seeding | Notes |
|---|---|---|---|
| `item.kind === "boolean"` | `<select>` opts `["":"未设置", "true":"true", "false":"false"]` | if `hasDisplayValue`: `value = String(item.value===true || String(item.value).toLowerCase()==="true")` | tri-state incl. "unset" |
| `item.options?.length` | `<select>` opts `["":"未设置", ...options]` | `value = hasDisplayValue ? String(item.value ?? "") : ""` | enumerated |
| `item.kind === "json"` | `<textarea spellcheck=false>` | `value = hasDisplayValue ? String(item.value ?? "") : ""` | multiline JSON |
| default | `<input>` | `type = item.secret?"password": item.kind==="number"?"number":"text"`; `autocomplete=off`; `placeholder = item.secret && item.configured ? item.masked : ""`; value set ONLY if `!item.secret && hasDisplayValue` → `String(item.value ?? "")` | secrets never seeded with a value |

All controls: `control.dataset.initial = control.value` after seeding.

### 8.6 `collectConfigUpdates(form, attr)` (2627–2641) — the diff logic
```
selector = attr==="yamlKey" ? "[data-yaml-key]" : "[data-env-key]"
keyAttr  = attr==="yamlKey" ? "yamlKey" : "envKey"
updates = {}
for each control matching selector:
  key = control.dataset[keyAttr]; if !key continue
  value = control.value
  if value === control.dataset.initial: continue        // unchanged → skip
  if control.type === "password" && !value: continue     // empty secret → skip (keep existing)
  if attr === "envKey" && value === "": continue          // env: empty string never sent
  updates[key] = value
return updates
```
**Key semantics to preserve exactly:**
- Only **changed** fields (vs `dataset.initial`) are sent — partial diff PATCH-style payload.
- Empty password fields are dropped (don't overwrite secrets).
- For env forms, an empty value is dropped entirely (can't blank an env var via this UI); for yaml,
  an empty string *can* be sent (only the password/initial guards apply).
- If nothing changed, `renderConfigFieldsForm` short-circuits and does NOT call `onsubmit`.

### 8.7 `renderConfigSections(sections)` (2535–2539)
Read-only chips for top-level config sections (Hermes only). `if (!sections.length) return null`.
`<div class="config-sections">` of up to **18** (`slice(0,18)`) `<span class="chip"><span class="chip__id">{section.key}</span><span>{section.detail}</span></span>`.

### 8.8 React `<ConfigForm>` design
```ts
type ConfigFieldDescriptor = {
  key: string; label?: string; group?: string;
  kind?: "boolean" | "number" | "json" | "text";
  options?: string[]; value?: unknown;
  configured?: boolean; defaulted?: boolean; secret?: boolean; masked?: string;
};
type ConfigFormProps = {
  fields: ConfigFieldDescriptor[];
  buttonText: string;
  onSubmit: (updates: Record<string, string>) => Promise<void>;
  busy?: boolean;
};
```
- Internal state: a `Record<key, string>` of current values + a frozen `initial` map computed once
  from descriptors (re-init when `fields` identity changes — use `useMemo`/`useEffect` keyed on a
  stable signature, or remount via `key`). Drop the DOM `data-*` + `dataset.initial` mechanism; the
  diff becomes `Object.entries(values).filter(([k,v]) => v !== initial[k] && !(secret[k] && v==="") && !(isEnv && v===""))`.
- The `attr` ("yamlKey"/"envKey") only controlled two things: the diff selector (now irrelevant) and
  the env-specific empty-skip rule. Replace with an explicit prop, e.g. `dropEmpty?: boolean` (true
  for env forms) so the same component serves yaml + env.
- Control rendering: a `<ConfigFieldControl descriptor value onChange dropEmpty>` switch matching the
  matrix in 8.5. Keep the tri-state boolean select ("未设置"/"true"/"false") and the "未设置" option
  for enumerated selects — these encode "leave unset", which the diff/skip rules depend on.
- Grouping: `<details>`/`<summary>` with first-2-open default. In React, `open` on `<details>` is an
  uncontrolled default → use `defaultOpen={index<2}` via the `open` attribute on initial render; or
  manage open state if you want it controlled. Preserve the `.nav__badge` count.
- Loading state: render `<div class="muted">正在读取配置…</div>` when `fields.length===0`.
- Submit: if computed `updates` is empty, do nothing (no toast, no request).

---

## 9. `HermesInternalConfig` — `renderHermesInternalConfig()` (2458–2512)

**Purpose:** Edit Hermes `config.yaml` three ways: descriptor fields, raw YAML text, and `.env` vars.

### Data: `state.hermesInternalConfig` = `payload`; `internal = payload.internal`.
`internal` fields read: `fields` ([]), `env` ([]), `yaml_text`, `config_path`, `yaml_error`,
`default_error`, `sections` ([]).

### Markup / sub-forms
```
<section class="card config-software">
  cardHead("Hermes 内部配置","settings",{desc: internal.config_path || "config.yaml"})
  {internal.yaml_error ? <div class="config-warning">{yaml_error}</div> : null}
  {internal.default_error ? <div class="config-warning">{default_error}</div> : null}
  renderConfigSections(internal.sections || [])

  // (A) descriptor field form — attr "yamlKey"
  renderConfigFieldsForm({ fields: internal.fields, attr:"yamlKey", buttonText:"保存 Hermes 字段", onsubmit:(updates)=>... })

  // (B) raw YAML textarea form
  <form class="raw-config-form" onsubmit=...>
    <div class="section-label">config.yaml</div>
    <textarea class="raw-config" spellcheck="false" aria-label="Hermes config.yaml">{internal.yaml_text||""}</textarea>
    <div class="form-actions"><button class="btn btn--primary" type="submit" disabled={busy}><span>保存 YAML</span></button></div>
  </form>

  // (C) env field form — attr "envKey"
  renderConfigFieldsForm({ fields: internal.env, attr:"envKey", buttonText:"保存 Hermes 环境变量", onsubmit:(updates)=>... })
</section>
```

### Three distinct writes — all to the SAME endpoint, different body keys
All: `PUT /api/system/hermes/internal-config`, then `await loadHermesInternalConfig()` + success toast.

- **(A) Field updates:** `body: { yaml_updates: updates }` where `updates` is the diff map from
  `collectConfigUpdates(..., "yamlKey")`. Toast "Hermes 内部配置已保存".
- **(B) Raw YAML:** `body: { yaml_text: yaml.value }`. Toast "Hermes config.yaml 已保存".
- **(C) Env updates:** `body: { env: updates }` (diff map, attr `"envKey"`). Toast "Hermes .env 已保存".

### React notes
- `HermesInternalConfig` composes three children: `<ConfigForm fields=internal.fields dropEmpty=false
  buttonText="保存 Hermes 字段" onSubmit={u=>put({yaml_updates:u})}/>`, a `<RawYamlForm>` (single
  controlled textarea), and `<ConfigForm fields=internal.env dropEmpty buttonText="保存 Hermes 环境变量"
  onSubmit={u=>put({env:u})}/>`. After any save, refetch `hermes/internal-config`.
- `config-warning` blocks render server-side parse errors (`yaml_error`, `default_error`).
- Raw textarea has `aria-label` — keep it. `<details>` chips read-only.

---

## 10. `CogneeInternalConfig` — `renderCogneeInternalConfig()` (2514–2533)

**Purpose:** Edit Cognee `.env` via the descriptor field form.

### Data: `state.cogneeConfig` = `payload`; `internal = payload.internal`; reads `internal.env` ([]), `internal.env_path`.

### Markup
```
<section class="card config-software">
  cardHead("Cognee 内部配置","settings",{desc: internal.env_path || "Cognee .env"})
  renderConfigFieldsForm({ fields: internal.env || [], attr:"envKey", buttonText:"保存 Cognee 环境变量", onsubmit:(updates)=>... })
</section>
```

### Write
```
PUT /api/system/cognee/config
body: { env: updates }      // diff map from collectConfigUpdates(..., "envKey")
```
On success: `await loadCogneeConfig(); await loadRuntime(); toast("Cognee 内部配置已保存", {ok, 完成})`.
(Note: also reloads runtime status because env changes can affect Cognee health.)

### React notes
- `CogneeInternalConfig` = one `<ConfigForm dropEmpty>`; on save refetch BOTH cognee config and
  runtime (`loadCogneeConfig` + `loadRuntime`). Keep that dual refetch.

---

## 11. `SecretsSettings` — `renderSecretsSettings()` (2643–2666) [section start]

**Purpose:** List + set platform-internal secrets (excluding OAuth secrets, which are managed in the
OAuth card). Each secret has its own inline form.

### Data: `state.secrets` filtered by `!isOAuthSecret(secret.key)` (i.e. key NOT containing `_OAUTH_`).
`Secret` fields: `key`, `configured` (bool), `masked` (string).

### Markup (per secret row)
```
<div class="secret-row">
  <div class="secret-row__key">[icon key]<span class="secret-row__name">{secret.key}</span></div>
  <span class="secret-row__val">{secret.configured ? secret.masked : "empty"}</span>
  <form onsubmit=...>
    <input type="password" autocomplete="off" placeholder={secret.configured ? secret.masked : "未配置"} />
    <button class="btn btn--sm" type="submit">设置</button>
  </form>
</div>
```
Wrapper: `<section class="card">[ cardHead("平台内部密钥","key",{desc:"手动配置的平台级密钥,OAuth 凭据在上方管理。"}), rows.length ? <div class="list">{rows}</div> : <div class="muted">暂无可手动配置的内部密钥。</div> ]`.

### Write (per row)
```
PUT /api/settings/secrets/{secret.key}
body: { value: input.value }
```
On success: `input.value=""`, `await loadSecrets()`, `toast(`已更新 ${secret.key}`, {type:"ok", title:"完成"})`.
Wrapped in `withBusy`. NOTE: `secret.key` is interpolated into the URL path — must be URL-safe; legacy
does not `encodeURIComponent` it (preserve as-is, but consider encoding in React for safety — though
that would change the request for keys with special chars; keep verbatim unless backend confirms).

### React notes
- `SecretsSettings` → `SecretRow` per item with local `useState("")` for the input. Submit clears it
  and refetches `secrets`. Empty list → muted message. This view continues past line 2666 into the
  OAuth section (`renderOAuthSettings` at 2669, out of scope) — the OAuth card is rendered separately
  on the `model` page, NOT here.

---

## 12. Cross-cutting migration concerns (off full-teardown rendering)

1. **Form re-seeding:** Legacy rebuilds every input from `state.*.config` on each full re-render, so
   external refreshes (e.g. another save, `loadSettings`) silently reset fields. In React, controlled
   form state must decide when to re-seed: seed on mount and when the underlying config object
   identity changes. Use a `key={configVersion}` remount or `useEffect([config])` to re-init. Beware
   clobbering in-progress edits — legacy didn't protect against this (it just re-rendered), but a
   debounce/optimistic React form should avoid resetting while the user types.
2. **Secret/diff semantics live in the DOM today.** `collectConfigUpdates` reads `dataset.initial`
   and `control.type==="password"` off live DOM nodes. Moving to React, capture `initial` values in
   state at seed time and track which fields are secret in the descriptor — do NOT rely on input type.
3. **Number inputs are sent as raw strings** (`port.value`, `interval.value`, etc.). Keep string
   state and send strings; the backend parses them. Coercing to `number` would change payloads.
4. **"Empty = keep existing" for secrets** (security session_secret, hermes api_key, telegram
   bot_token/webhook_secret, auto-update webhook_secret, config-form password fields). Always clear
   the field after a successful save and never seed it with a value.
5. **Refetch scope differs per page** — replicate exactly: security replaces `state.securityConfig`
   with the PUT response (no GET); hermes config / runtime actions call `loadSettings()` (ALL);
   telegram → `loadTelegramConfig` only; auto-update → `loadAutoUpdateConfig` only; hermes-internal →
   `loadHermesInternalConfig` only; cognee → `loadCogneeConfig` + `loadRuntime`; secrets →
   `loadSecrets` only.
6. **`busy` is global** and disables every action across all admin sections at once. In React, decide
   whether to keep a single global `busy` (simplest parity) or per-form pending state. Legacy = global.
7. **`<details open>` defaults:** first two config groups open. `open` is uncontrolled in HTML; with
   full teardown the open/closed state resets every render (a real UX quirk — expanding group 3 then
   triggering any render collapses it). React can FIX this by keeping per-group open state, which is a
   behavior improvement; flag it as an intentional deviation if you do.
8. **No SSE/polling/RAF/debounce in this section.** Auto-update status is on-demand only. The only
   post-render side effect is `syncActiveAdminPager()` (mobile scroll-into-view). Safe to drop the
   global RAF `afterRender` pipeline for these pages and use a focused `useEffect`.
9. **Accessibility gaps to optionally close:** status rows/badges are non-semantic spans; the
   security status board and runtime list have no list/landmark roles or `aria-live`; only the raw
   YAML textarea has an `aria-label`. The admin pager uses `aria-current="page"` correctly. Inputs
   rely on `<label>` wrapping for association (no explicit `htmlFor`/`id`) — preserve label nesting.

---

## 13. Endpoint quick-reference (all admin-config writes/reads in this section)

| Method | Path | Body | Reads/updates |
|---|---|---|---|
| GET | `/api/system/security/config` | — | `state.securityConfig` |
| PUT | `/api/system/security/config` | `{public_base_url, trusted_proxy, host, port, session_ttl_seconds, session_secret}` | sets `state.securityConfig = result` |
| GET | `/api/system/runtime` | — | `state.runtimes` |
| POST | `/api/system/runtime/{name}/restart` | `"{}"` | then `loadSettings()` |
| POST | `/api/system/runtime/hermes/install` | `"{}"` | then `loadSettings()` |
| GET | `/api/system/hermes/config` | — | `state.hermesConfig` |
| PUT | `/api/system/hermes/config` | `{manage_hermes, repo_path, api_url, provider, provider_base_url, model, install_extras, startup_wait_seconds, timeout_seconds, api_key}` | then `loadSettings()` |
| GET | `/api/system/oauth/providers` | — | `state.oauthProviders` (model catalog source) |
| GET | `/api/system/telegram/config` | — | `state.telegramConfig` |
| PUT | `/api/system/telegram/config` | `{enabled, polling, bot_username, bot_token, webhook_secret}` | then `loadTelegramConfig()` |
| GET | `/api/system/auto-update/config` | — | `state.autoUpdateConfig` |
| PUT | `/api/system/auto-update/config` | `{enabled, interval_seconds, remote, branch, webhook_secret}` | then `loadAutoUpdateConfig()` |
| POST | `/api/system/auto-update/check` | `"{}"` | then `loadAutoUpdateConfig()` |
| GET | `/api/system/hermes/internal-config` | — | `state.hermesInternalConfig` |
| PUT | `/api/system/hermes/internal-config` | `{yaml_updates}` OR `{yaml_text}` OR `{env}` | then `loadHermesInternalConfig()` |
| GET | `/api/system/cognee/config` | — | `state.cogneeConfig` |
| PUT | `/api/system/cognee/config` | `{env}` | then `loadCogneeConfig()` + `loadRuntime()` |
| GET | `/api/settings/secrets` | — | `state.secrets` (response `{secrets}`) |
| PUT | `/api/settings/secrets/{key}` | `{value}` | then `loadSecrets()` |

All requests go through `api()`: `credentials: "include"`, `Content-Type: application/json`.
