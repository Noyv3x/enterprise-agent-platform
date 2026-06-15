# Migration Spec — OAuth Settings/Flows, Utility Formatters, Data-Loading Layer

Source: `/home/dev/code/enterprise-agent-platform/main/enterprise-agent-platform/frontend/src/legacy-app.js`
Styles: `/home/dev/code/enterprise-agent-platform/main/enterprise-agent-platform/frontend/src/styles.css`

This section covers three foundational areas for the React rewrite:

1. **Internal-secrets settings** (`renderSecretsSettings` + secrets CRUD).
2. **OAuth provider settings & verification flows** (Codex device-code flow + Grok manual-callback flow, credential import/export).
3. **Shared utility formatters** (become a `utils/format.ts` module) and the **complete data-loading map** (every loader → endpoint → state field), the backbone of the React data layer.

All endpoint paths, HTTP methods, request body shapes, and response field names below are **verbatim from the legacy code and MUST be preserved**. The backend is unchanged by this migration.

---

## 0. Cross-cutting infrastructure these views depend on

These are not in this section's render scope but are referenced everywhere here. The implementer needs them as React equivalents.

### `api(path, options)` — `legacy-app.js:73-94`
The single fetch wrapper. Behavior to preserve exactly:
- `fetch(path, { credentials: "include", headers, ...options })`.
- If `options.body` is a `FormData`, headers default to `options.headers || {}` (no Content-Type). Otherwise headers default to `{ "Content-Type": "application/json", ...options.headers }`.
- Reads `res.text()`, then `JSON.parse` inside try/catch (a fronting proxy may emit HTML 502/504 or login redirect → `data = {}` rather than throw).
- `res.status === 401 && !options.skipAuthHandling` → calls `handleSessionExpired()` (drops to login, stops polling, toasts "会话已过期，请重新登录").
- `!res.ok` → `throw new Error(data.error || data.detail || \`请求失败（${res.status}）\`)`.
- Returns parsed `data` object.
- React: implement as `apiClient` (e.g. in a `lib/api.ts`); 401 handling should dispatch a session-expired action (context/store), not call a global. Keep the `skipAuthHandling` escape hatch (used by SSE reconnect auth-probe via `/api/auth/me`).

### `withBusy(fn)` — `legacy-app.js:3466-3480`
Wraps an async action with the global busy/error lifecycle:
- Sets `state.busy = true`, `state.error = ""`, `render()`.
- `await fn()`; on throw: `state.error = message`; if `state.user`, `toast(message, { type: "error", title: "操作失败" })`.
- `finally`: `state.busy = false`, `render()`.
- React: a `useBusy()` hook or a mutation wrapper that toggles a shared `busy` flag and surfaces errors via toast. `state.busy` gates many buttons' `disabled` in this section (export/import, start/poll/complete buttons).

### `toast(message, { type = "error", title })` — `legacy-app.js:247-265`
Appends a dismissible toast node to `#toast-stack`. Auto-dismiss after `type === "ok" ? 3200 : 6500` ms; leave animation via `is-leaving` class + `animationend`. `role="status"`. React: a toast context/provider with `toast.ok(...)` / `toast.error(...)`.

### `safeUrl(value, { allowData })` — `legacy-app.js:100-114`
Allow-lists link schemes (`http`,`https`,`mailto`,`tel`,`blob`; `data` only when `allowData`). Used implicitly by `h()` for `href`. The OAuth flows render `<a href={flow.verification_url}>` / `<a href={flow.authorize_url}>` — **these backend-supplied URLs must be passed through `safeUrl` in React** (an unexpected `javascript:` value must not become a live href). The credential export uses an in-page `blob:` URL (allowed).

### `cardHead(title, iconName, { desc, extra })` — `legacy-app.js:334-342`
Renders `.card__head` → `<div>` containing `.card__title` (`icon(iconName)` + `<span>title</span>`) and optional `.card__desc`; plus an optional `extra` node placed after the title block. → React `<CardHead title icon desc extra>`.

### `statusBadge(ok, label)` — `legacy-app.js:343-348`
`<span class="status status--ok|status--warn">` with a `<span class="dot|dot dot--warn">` and a text node. → React `<StatusBadge ok label>`.

### `icon(name, { size, cls, strokeWidth })` — `legacy-app.js:196-213`
Builds an inline SVG from the `ICONS` registry; `aria-hidden="true"`, `stroke="currentColor"`. Icon names used in this section: `key`, `shield`, `download`, `upload`, `external`, `refresh`, `checkCircle`, `alert`. → React `<Icon name size strokeWidth />`.

### `render()` / full-teardown model — `legacy-app.js:268-298`
Every state mutation calls `render()` which does `app.replaceChildren(...)` (full DOM teardown) then `requestAnimationFrame(afterRender)`. `afterRender` restores message scroll, refocuses the composer if `state._focusComposer`, and crucially calls **`syncScopeStream()`** and `syncActiveAdminPager()`. In React this teardown disappears — see migration notes per view for the focus/scroll/stream concerns that the teardown currently hides.

---

## 1. Internal Secrets settings

### Component: `SecretsSettings` (`renderSecretsSettings`, `legacy-app.js:2643-2666`)
One-line: Lists manually-configurable platform-internal secrets (excluding OAuth secrets) and lets an admin set each value.

#### DOM structure
```
section.card
  cardHead("平台内部密钥", "key", desc:"手动配置的平台级密钥，OAuth 凭据在上方管理。")
  if rows.length:
    div.list
      (per secret) div.secret-row
        div.secret-row__key      → icon("key") + span.secret-row__name {secret.key}
        span.secret-row__val     → secret.configured ? secret.masked : "empty"
        form (onsubmit)
          input[type=password, autocomplete=off,
                placeholder = secret.configured ? secret.masked : "未配置"]
          button.btn.btn--sm[type=submit] "设置"
  else:
    div.muted "暂无可手动配置的内部密钥。"
```
CSS: `.secret-row` is a 2-col grid (`1fr auto`); the `form` spans full width (`grid-column: 1 / -1`). `.secret-row__name`/`__val` are monospace. Mobile overrides at `styles.css:1873-1879`.

#### State read
- `state.secrets` (array). Each item shape (from `loadSecrets` / `/api/settings/secrets`): `{ key: string, configured: boolean, masked: string }`.
- Filter: `state.secrets.filter(s => !isOAuthSecret(s.key))` — i.e. **excludes any key containing `"_OAUTH_"`** (those are managed by the OAuth card).
- `state.busy` indirectly (form submit goes through `withBusy`).

#### Event handlers
- **`form onsubmit`** (`2650-2658`): `event.preventDefault()`, then `withBusy(async () => { ... })`:
  - `PUT /api/settings/secrets/{secret.key}` with body `JSON.stringify({ value: input.value })`.
  - On success: clear the input (`input.value = ""`), `await loadSecrets()`, `toast(\`已更新 ${secret.key}\`, { type:"ok", title:"完成" })`.
- The input is an **uncontrolled** local-DOM node in legacy (its `.value` is read directly at submit and cleared after). In React this becomes per-row controlled state or a ref.

#### API call
| Method | Path | Body | Response | State updated |
|---|---|---|---|---|
| `PUT` | `/api/settings/secrets/{key}` | `{ value: string }` | (ignored) | triggers `loadSecrets()` → `state.secrets` |

#### Edge / a11y
- Empty list → `.muted` placeholder text.
- No permission gating in the function itself — gating is done by whoever routes to the Settings page (admin panel; see `loadSettings`). The secrets card is rendered only inside the admin settings page.
- A11y gaps: the password `<input>` has a placeholder but **no associated `<label>`**; the `.secret-row__name` is not programmatically tied to the input. The "设置" button has visible text only. React should add `aria-label`/`<label htmlFor>` tying the key name to the input.

#### React notes
- `SecretsSettings` maps `secrets` → `SecretRow` children.
- `SecretRow` holds local `useState("")` for the input value (or a ref). On submit call the shared mutation (`PUT`), then invalidate/reload secrets via the data layer.
- Source of truth for `secrets` should live in a settings context/store, refreshed by `loadSecrets`.

---

## 2. OAuth provider settings & verification flows

> Product constraint (AGENTS.md): the UI supports **only Codex OAuth and Grok OAuth** as model providers, plus credential import/export. Do not reintroduce API-key provider flows. The two flow shapes are `kind: "device_code"` (Codex) and `kind: "manual_callback"` (Grok).

### Component: `OAuthSettings` (`renderOAuthSettings`, `legacy-app.js:2669-2702`)
One-line: Card listing OAuth-verifiable model providers with global import/export-credentials actions.

#### DOM structure
```
section.card
  cardHead("API 供应商验证", "shield",
           desc:"通过 OAuth 授权模型供应商，验证后 Hermes 自动切换。",
           extra: div.oauth-transfer)
      div.oauth-transfer
        button.btn.btn--sm[type=button, disabled=state.busy]  → icon("download",14) + span "导出凭据"   (onclick exportOAuthCredentials)
        button.btn.btn--sm[type=button, disabled=state.busy]  → icon("upload",14)   + span "导入凭据"   (onclick importInput.click())
        input[type=file, accept="application/json,.json", style="display:none"]  (onchange → importOAuthCredentials)
  if providers.length:
    div.oauth-grid  → providers.map(renderOAuthProviderCard)
  else:
    div.muted "未发现可验证的供应商。"
```

#### State read
- `state.oauthProviders?.providers || []` (the provider list).
- `state.busy` (disables both transfer buttons).

#### Hidden file input behavior (`2671-2680`)
- `onchange`: `const file = event.target.files?.[0]; event.target.value = ""` (reset so the same file can be re-selected), then `if (file) await importOAuthCredentials(file)`.
- The visible "导入凭据" button calls `importInput.click()`.

#### React notes
- `OAuthSettings` owns a `useRef<HTMLInputElement>` for the hidden file input. Reset `e.target.value = ""` after read. The "import" button triggers `inputRef.current?.click()`.
- Both transfer buttons disabled while `busy`.

---

### Component: `OAuthProviderCard` (`renderOAuthProviderCard`, `legacy-app.js:2704-2738`)
One-line: A single provider's verification status, action button, and (if a flow is active) the embedded device-code or manual-callback flow UI.

#### Provider object shape (from `/api/system/oauth/providers`)
```
{
  id: string,                 // e.g. "codex", "grok"
  label: string,              // display name
  default_model?: string,     // shown under label as .oauth-card__model
  configured: boolean,        // → statusBadge "已验证"/"未验证"
  active: boolean,            // → "使用中" chip + .is-active card class
  last_refresh?: number|string, // → formatTimestamp(...) "更新于 …"
  last_auth_error?: { message?, detail?, code?, relogin_required? } | null,
  model_catalog_error?: string,
}
```

#### DOM structure
```
div.oauth-card{.is-active if provider.active}
  div.oauth-card__head
    div.oauth-card__id
      div.oauth-card__logo → strong.mono { (provider.label||"?").trim().charAt(0) }
      div
        div.oauth-card__label { provider.label }
        if provider.default_model: div.oauth-card__model { provider.default_model }
    statusBadge(!!provider.configured, configured ? "已验证" : "未验证")
  div.oauth-meta
    if provider.active: span.chip → span.dot + textNode("使用中")
    if provider.last_refresh: span.muted[style=font-size:12px] "更新于 {formatTimestamp(last_refresh)}"
  if errorText:                       div.oauth-error[role=alert] → icon("alert",15) + span {errorText}
  if (!default_model && model_catalog_error): div.oauth-error[role=alert] → icon("alert",15) + span {model_catalog_error}
  div.oauth-actions
    button (start/re-verify)          ← startButton
  if flow.kind === "device_code":     renderCodexOAuthFlow(provider.id, flow)
  else if flow.kind === "manual_callback": renderGrokOAuthFlow(provider.id, flow, callbackValue)
  if flow.complete:                   div.oauth-guide.complete → icon("checkCircle",16) + span "验证完成，Hermes 已切换到该供应商。"
```

**startButton** (`2722-2726`):
- class = `provider.configured ? "btn btn--sm" : "btn btn--primary btn--sm"`.
- `disabled: state.busy`.
- text = `provider.configured ? "重新验证" : "开始验证"`; leading `icon("shield",14)`.
- `onclick: () => startOAuthVerification(provider.id)`.

#### State read
- `state.oauthFlows[provider.id]` → the active flow object for this provider (or undefined).
- `state.oauthCallbackUrls[provider.id] || ""` → the in-progress Grok callback URL text.
- `state.busy` (disables start button).

#### `oauthProviderErrorText(provider)` (`legacy-app.js:2740-2746`)
Derives the human error string from `provider.last_auth_error`:
- If not a truthy object → `""`.
- `message = String(authError.message || authError.detail || authError.code || "").trim()`.
- If no message → `""`.
- If `authError.relogin_required` → `\`需要重新验证：${message}\``, else `message`.
- → Pure util `oauthProviderErrorText(provider)` in `utils/oauth.ts`.

---

### Component: `CodexOAuthFlow` (device-code) — `renderCodexOAuthFlow(providerId, flow)` `legacy-app.js:2748-2760`
One-line: Device-code verification UI — shows the verification URL, the user code, a manual "check status" poll button, and the current status label.

Flow object (`kind: "device_code"`): `{ flow_id, verification_url, user_code, status, complete? }`.

#### DOM structure
```
div.oauth-guide
  div.oauth-line
    span "验证页"
    a[href=flow.verification_url, target=_blank, rel=noreferrer] → span {verification_url} + icon("external",13)
  div.oauth-code { flow.user_code }
  div.oauth-actions
    button.btn.btn--sm[disabled=state.busy]  → icon("refresh",14) + span "检查状态"   (onclick pollOAuthVerification(providerId, flow.flow_id))
    span.muted[style=font-size:12px] "状态：{oauthStatusLabel(flow.status)}"
```
- `.oauth-code` is the large monospace code block (`styles.css:1530`).
- No automatic polling; the user clicks "检查状态" to poll. (This is the only "poll" trigger — there is no interval timer for OAuth.)

---

### Component: `GrokOAuthFlow` (manual-callback) — `renderGrokOAuthFlow(providerId, flow, callbackValue)` `legacy-app.js:2762-2780`
One-line: Manual OAuth-callback UI — opens the authorize URL, displays the redirect URI, lets the user paste the full callback URL, and completes verification.

Flow object (`kind: "manual_callback"`): `{ flow_id, authorize_url, redirect_uri, status, complete? }`.

#### DOM structure
```
div.oauth-guide
  div.oauth-line
    span "授权页"
    a[href=flow.authorize_url, target=_blank, rel=noreferrer] → span "打开 Grok OAuth" + icon("external",13)
  div.oauth-line
    span "回调地址"
    code { flow.redirect_uri }
  textarea[placeholder="粘贴浏览器跳转后的完整 callback URL"]   (value = callbackValue; oninput → state.oauthCallbackUrls[providerId] = value)
  div.oauth-actions
    button.btn.btn--primary.btn--sm[disabled=state.busy] → icon("checkCircle",14) + span "完成验证"  (onclick completeOAuthVerification(providerId, flow.flow_id))
    span.muted[style=font-size:12px] "状态：{oauthStatusLabel(flow.status)}"
```
- The textarea is **controlled by `state.oauthCallbackUrls[providerId]`**: legacy sets `callbackInput.value = callbackValue` after creation and writes back on `oninput`. This survives full re-renders because the value is stored in global state, not the DOM. In React it is straightforward controlled state.

#### `oauthStatusLabel(status)` (`legacy-app.js:2804-2806`)
Maps status → Chinese label:
```
waiting_for_user     → "等待网页登录"
waiting_for_callback → "等待回调 URL"
complete             → "已完成"
(other / falsy)      → status || "等待中"
```
→ Pure util.

---

### OAuth flow actions (the verification state machine) — `legacy-app.js:3366-3428`

All four go through `withBusy` (so they toggle `state.busy` and surface errors as toasts). Each then calls `updateOAuthState(...)` and reloads dependent config.

#### `startOAuthVerification(providerId)` — `3366-3372`
| Method | Path | Body | Response | State |
|---|---|---|---|---|
| `POST` | `/api/system/oauth/{providerId}/start` | `"{}"` (literal empty-object string) | `{ providers, active_provider, flow }` | `updateOAuthState(providerId, result)` then `await loadHermesConfig()` |
- **Note the body is the literal string `"{}"`, not `JSON.stringify({})`** — preserve exactly (Content-Type still JSON via `api`).

#### `pollOAuthVerification(providerId, flowId)` — `3373-3379`
| Method | Path | Body | Response | State |
|---|---|---|---|---|
| `POST` | `/api/system/oauth/{providerId}/poll` | `{ flow_id: flowId }` | `{ providers, active_provider, flow }` | `updateOAuthState(...)` then `loadHermesConfig()` |
- Manual, user-triggered (the "检查状态" button). **No polling interval** — do not add one.

#### `completeOAuthVerification(providerId, flowId)` — `3380-3390`
| Method | Path | Body | Response | State |
|---|---|---|---|---|
| `POST` | `/api/system/oauth/{providerId}/complete` | `{ flow_id: flowId, callback_url: state.oauthCallbackUrls[providerId] || "" }` | `{ providers, active_provider, flow }` | `updateOAuthState(...)`; if `result.flow?.complete` → clear `state.oauthCallbackUrls[providerId] = ""`; then `loadHermesConfig()` |

#### `exportOAuthCredentials()` — `3391-3406`
| Method | Path | Body | Response | State |
|---|---|---|---|---|
| `GET` | `/api/system/oauth/credentials/export` | — | arbitrary JSON `payload` (the credentials bundle) | none (client download only) |
- Builds `new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })`, creates an object URL, programmatically clicks an `<a download="enterprise-oauth-credentials-{YYYY-MM-DD}.json">`, removes it, `URL.revokeObjectURL(url)`.
- Filename date = `new Date().toISOString().slice(0, 10)`.
- Toast: `"OAuth 凭据文件已生成"` (ok / "完成").
- React: use a `downloadJson(payload, filename)` helper; the anchor click + revoke pattern stays the same (no React node needed).

#### `importOAuthCredentials(file)` — `3407-3424`
- `credentials = JSON.parse(await file.text())`; on parse failure throw `new Error("OAuth 凭据文件不是有效 JSON")` (surfaced via `withBusy` toast).
| Method | Path | Body | Response | State |
|---|---|---|---|---|
| `POST` | `/api/system/oauth/credentials/import` | `{ credentials }` (the parsed JSON object) | `{ providers, active_provider, imported?: { keys?: string[] } }` | `updateOAuthState(result.active_provider, result)`; then `Promise.all([loadSecrets(), loadHermesConfig()])` |
- Toast: `\`已导入 ${result.imported?.keys?.length || 0} 个 OAuth 凭据\`` (ok / "完成").

#### `updateOAuthState(providerId, result)` — `3425-3428`
Central reducer for all OAuth responses:
```js
state.oauthProviders = { providers: result.providers || [], active_provider: result.active_provider || providerId };
if (result.flow) state.oauthFlows[providerId] = result.flow;
```
- Note: it **replaces** `state.oauthProviders` entirely (only `providers` + `active_provider`) and **merges** `flow` into the `oauthFlows` map keyed by provider id. Flows are never deleted here — a completed flow stays in the map with `complete: true` (driving the green "验证完成" guide) until the next full provider reload (`loadOAuthProviders`) which replaces `oauthProviders` but leaves `oauthFlows` untouched.

#### OAuth state fields summary
| Field | Type | Written by | Read by |
|---|---|---|---|
| `state.oauthProviders` | `{ providers: Provider[], active_provider?: string } \| null` | `loadOAuthProviders`, `updateOAuthState` | `renderOAuthSettings`, `renderOAuthProviderCard` |
| `state.oauthFlows` | `{ [providerId]: Flow }` | `updateOAuthState` | `renderOAuthProviderCard` |
| `state.oauthCallbackUrls` | `{ [providerId]: string }` | Grok textarea `oninput`, cleared on complete | `renderOAuthProviderCard`, `completeOAuthVerification` |
| `state.busy` | boolean | `withBusy` | all OAuth buttons (`disabled`) |

#### Real-time / async behaviors
- **No SSE, no interval polling for OAuth.** All transitions are user-initiated (start → poll/complete buttons). The only "polling" is the manual "检查状态" button (Codex) / "完成验证" (Grok).
- Optimistic: none — every action shows `busy` and awaits the server response before re-render.
- Side effect coupling: every successful OAuth action reloads `hermesConfig` (because "验证后 Hermes 自动切换"); import additionally reloads `secrets`.

#### Edge cases / permission gating
- Empty providers → `.muted "未发现可验证的供应商。"`.
- `last_auth_error` present → red `.oauth-error[role=alert]` with derived message (relogin prefix if `relogin_required`).
- `!default_model && model_catalog_error` → a second `.oauth-error[role=alert]` (model catalog fetch failed).
- `flow.complete` → green `.oauth-guide.complete` banner (rendered in addition to the action button; the flow guide block is only rendered while `kind` matches, but `complete` banner is independent).
- Permission: rendered only within the admin Settings page (gated upstream; `isAdmin()`/`hasPermission("system_settings")`).

#### A11y
- Error blocks use `role="alert"` (good).
- Gaps: the Grok textarea has only a placeholder (no `<label>`); the device "检查状态"/"完成验证" buttons rely on text; status labels are plain `span.muted` (not `aria-live`) — consider `aria-live="polite"` on the status text in React so screen readers announce status transitions after poll. External links correctly use `rel="noreferrer"` + `target="_blank"`.

#### React migration notes (OAuth)
- Boundaries: `OAuthSettings` (card + transfer actions + grid) → `OAuthProviderCard` → `CodexOAuthFlow` / `GrokOAuthFlow` / `OAuthCompleteBanner`.
- Props: `OAuthProviderCard({ provider, flow, callbackValue, busy, onStart, onPoll, onComplete, onCallbackChange })`.
- State location: `oauthProviders`, `oauthFlows`, `oauthCallbackUrls`, `busy` belong in a settings/OAuth context or store (e.g. a `useOAuth()` reducer mirroring `updateOAuthState`). Keep `updateOAuthState` semantics exactly (replace providers, merge flow, never auto-clear completed flows except callbackUrl on complete).
- The hidden file `<input type=file>` → `useRef`; reset `value=""` after read.
- Export: keep the blob-download helper; no need for an in-tree anchor.
- Tricky: in legacy, the Grok textarea value persists across full teardown because it lives in `state.oauthCallbackUrls`. In React it's just controlled state — but ensure the card is keyed by `provider.id` so React reconciliation doesn't carry one provider's textarea into another's slot when the providers array reorders.

---

## 3. Small helpers in range

### `messageAuditState()` — `legacy-app.js:2783-2796`
Lazily initializes & returns `state.messageAudit` with the default shape `{ auditChannelId, channelMessages:[], channelTotal:0, privateConversations:[], auditPrivateUserId:null, privateMessages:[], privateTotal:0 }`. Used by the admin message-audit loaders. React: this is just the initial slice of the audit store; the lazy-init pattern becomes the reducer's `initialState`.

### `unixFromDatetimeLocal(value)` — `legacy-app.js:2797-2802`
Converts a `<input type=datetime-local>` value to a Unix seconds integer: `null` if empty/invalid, else `Math.floor(new Date(value).getTime()/1000)`. → util.

### `isOAuthSecret(key)` — `legacy-app.js:2803`
`key.includes("_OAUTH_")`. Used to exclude OAuth-managed secrets from the manual secrets list. → util.

---

## 4. Utility formatters → shared `utils/format.ts`

These are pure, dependency-free, and used across many sections. They MUST keep identical output (some are used in payloads/labels; locale-formatting differences are acceptable only where already locale-dependent). Source `legacy-app.js:2807-2849`.

| Function | Lines | Signature | Behavior (exact) |
|---|---|---|---|
| `initials(name)` | 2807-2813 | `(name) → string` | `s = String(name||"?").trim()`; if empty → `"?"`. Split on `\s+`; if ≥2 parts **and** `/[a-zA-Z]/.test(s)` → `(parts[0][0]+parts[1][0]).toUpperCase()`; else `s.slice(0,2).toUpperCase()`. |
| `formatTime(value)` | 2814-2820 | `(unixSeconds) → string` | `""` if falsy; `d = new Date(value*1000)`; `""` if NaN. `hm = d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})`. If same calendar day as now → `hm`, else `\`${d.getMonth()+1}/${d.getDate()} ${hm}\``. **Input is seconds.** |
| `formatTimestamp(value)` | 2821-2826 | `(number\|string) → string` | `""` if falsy; if `typeof value === "number"` → `new Date(value*1000)` (**seconds**) else `new Date(value)`; if NaN → `String(value)`; else `date.toLocaleString()`. (Used by OAuth `last_refresh`.) |
| `formatNumber(value)` | 2827-2830 | `(value) → string` | `new Intl.NumberFormat().format(Number(value)||0)`. |
| `shortSha(value)` | 2831-2834 | `(value) → string` | `String(value||"").trim()`; `""` → `"-"`, else `.slice(0,7)`. |
| `formatCompactNumber(value)` | 2835-2838 | `(value) → string` | `Intl.NumberFormat(undefined,{notation:"compact",maximumFractionDigits:1}).format(Number(value)||0)`. |
| `formatFileSize(value)` | 2839-2849 | `(bytes) → string` | `size = Math.max(0, Number(value)||0)`; units `["B","KB","MB","GB"]`. Loop: when `size < 1024` or last unit → return `"B" ? \`${Math.round(size)} B\` : \`${size.toFixed(1)} ${unit}\``; else `size /= 1024`. Fallback `"0 B"`. |

Plus from §3: `unixFromDatetimeLocal`, `isOAuthSecret`, and OAuth-specific `oauthStatusLabel`, `oauthProviderErrorText` (put the latter two in `utils/oauth.ts`).

React: export all as named pure functions; no hooks. `formatTime`/`formatTimestamp` are time-relative ("today") — components that display them should not memoize across day boundaries, but that's negligible.

---

## 5. The data-loading map (foundation of the React data layer)

Every loader is `async`, calls `api(...)`, and writes into one or more `state.*` fields. Loaders themselves do NOT call `render()` — callers wrap them (usually `withBusy`) and re-render. In React, model each as a fetch function feeding a store slice / React-Query key.

### Per-loader endpoint → state map

| Loader | Lines | METHOD + Path | Query params | Writes state | Response fields used |
|---|---|---|---|---|---|
| `loadInitial` | 3148-3151 | (orchestrator) | — | — | `Promise.all([loadChannels, loadMentionTargets])` then `loadChannelMessages` |
| `loadChannels` | 3152-3156 | `GET /api/channels` | — | `state.channels`; sets `state.activeChannelId` to `channels[0].id` if unset & non-empty | `result.channels` |
| `loadMentionTargets` | 3157-3164 | `GET /api/mention-targets` | — | `state.mentionTargets` (`result.targets \|\| []`); **swallows errors** → `[]` | `result.targets` |
| `loadChannelMessages` | 3165-3173 | `GET /api/channels/{activeChannelId}/messages` | — | `state.messages` (via `mergePendingMessages("channel", id, result.messages)`); `setAgentStatus("channel", id, result.agent_status)`; `state.typingUsers = result.typing \|\| []` | `result.messages`, `result.agent_status`, `result.typing` |
| `loadPrivateMessages` | 3174-3182 | `GET /api/private-agent/messages` (parallel `loadPrivateTelegram`) | — | `state.privateMessages` (via `mergePendingMessages("private", scopeId, result.messages)`); `setAgentStatus("private", scopeId, result.agent_status)` | `result.messages`, `result.agent_status` |
| `loadPrivateTelegram` | 3183-3185 | `GET /api/private-agent/telegram` | — | `state.privateTelegram` (entire response) | (whole object) |
| `loadDocuments` | 3186-3190 | `GET /api/knowledge/documents` | — | `state.documents = result.documents`; resets `state.knowledgeSearch = { query:"", results:null }` | `result.documents` |
| `loadUsers` | 3191-3194 | `GET /api/users` | — | `state.users = result.users` | `result.users` |
| `loadPermissionGroups` | 3195-3198 | `GET /api/permission-groups` | — | `state.permissionGroups = result.permission_groups` | `result.permission_groups` |
| `loadAuditChannelMessages` | 3199-3210 | `GET /api/admin/channels/{channelId}/messages?limit=200` | `limit=200` | `messageAudit.channelMessages = result.messages \|\| []`; `messageAudit.channelTotal = result.total \|\| 0`; sets `auditChannelId`; if no `channelId` → clears both | `result.messages`, `result.total` |
| `loadPrivateConversations` | 3211-3222 | `GET /api/admin/private-agent/conversations` | — | `messageAudit.privateConversations = result.conversations \|\| []`; reselects `auditPrivateUserId` (first conv with `message_count>0`, else first) if current selection absent | `result.conversations` (`item.user_id`, `item.message_count`) |
| `loadAuditPrivateMessages` | 3223-3234 | `GET /api/admin/private-agent/conversations/{userId}/messages?limit=200` | `limit=200` | `messageAudit.privateMessages = result.messages \|\| []`; `messageAudit.privateTotal = result.total \|\| 0`; sets `auditPrivateUserId`; if no `userId` → clears both | `result.messages`, `result.total` |
| `loadSecrets` | 3235-3238 | `GET /api/settings/secrets` | — | `state.secrets = result.secrets` | `result.secrets` (`{key,configured,masked}[]`) |
| `loadOAuthProviders` | 3239 | `GET /api/system/oauth/providers` | — | `state.oauthProviders` (entire response: `{providers, active_provider?}`) | (whole object) |
| `loadRuntime` | 3240 | `GET /api/system/runtime` | — | `state.runtimes` (entire response) | (whole) |
| `loadSecurityConfig` | 3241 | `GET /api/system/security/config` | — | `state.securityConfig` (whole) | (whole) |
| `loadHermesConfig` | 3242 | `GET /api/system/hermes/config` | — | `state.hermesConfig` (whole) | (whole) |
| `loadTelegramConfig` | 3243 | `GET /api/system/telegram/config` | — | `state.telegramConfig` (whole) | (whole) |
| `loadAutoUpdateConfig` | 3244 | `GET /api/system/auto-update/config` | — | `state.autoUpdateConfig` (whole) | (whole) |
| `loadHermesInternalConfig` | 3245 | `GET /api/system/hermes/internal-config` | — | `state.hermesInternalConfig` (whole) | (whole) |
| `loadCogneeConfig` | 3246 | `GET /api/system/cognee/config` | — | `state.cogneeConfig` (whole) | (whole) |
| `loadTokenUsage` | 3247-3251 | `GET /api/admin/token-usage?days={days}&limit=200` | `days=encodeURIComponent(state.tokenUsageDays\|\|30)`, `limit=200` | `state.tokenUsage` (whole); `state.tokenUsageDays = result.window?.days \|\| prev \|\| 30` | `result.window.days` |
| `loadSettings` | 3252 | (orchestrator) | — | — | `Promise.all([loadSecrets, loadRuntime, loadSecurityConfig, loadHermesConfig, loadTelegramConfig, loadAutoUpdateConfig, loadHermesInternalConfig, loadCogneeConfig, loadOAuthProviders])` |
| `loadMessageAudit` | 3253-3261 | (orchestrator) | — | — | ensures channels loaded; sets default `auditChannelId`; `Promise.all([loadAuditChannelMessages, loadPrivateConversations])` then `loadAuditPrivateMessages` |
| `loadAdminPanel` | 3262 | (orchestrator) | — | — | `Promise.all([loadUsers, loadPermissionGroups, loadSettings, loadMessageAudit, loadTokenUsage])` |

### Loader call-site / trigger map (when loaders fire)
- **Boot** (`boot`, `3520-3533`): `GET /api/auth/me` → `state.user = result.user`; `state._focusComposer = true`; `loadInitial()`; `startPolling()`; then `render()`. On failure → `state.user = null`, `stopPolling()`.
- **Nav switching** (`navItem`, `489-502`): sets `state.activeView`; private → `withBusy(loadPrivateMessages)`; knowledge → `withBusy(loadDocuments)`; admin → `withBusy(loadAdminPanel)`; channel/other → just `render()`.
- **Admin sub-page tabs** (`1376-1377`): messages page → `withBusy(loadMessageAudit)`; tokens page → `withBusy(loadTokenUsage)`.
- **Refresh buttons**: token usage refresh (`1568`,`1587`), message-audit refresh (`1887`).
- **Settings mutations** elsewhere re-call `loadSettings()` (`2117`,`2133`,`2246`).
- **Secrets set** → `loadSecrets()` (`2655`). **OAuth actions** → `loadHermesConfig()` (+`loadSecrets` on import).

### `loadInitial` orchestration nuance
`loadChannels` + `loadMentionTargets` run in parallel, **then** `loadChannelMessages` (depends on `activeChannelId` set by `loadChannels`). Preserve this ordering — `loadChannelMessages` early-returns if `!state.activeChannelId`.

### Polling & SSE (real-time layer feeding the loaders) — `3263-3363`
- `startPolling()` (`3285-3290`): `setInterval(() => refreshActiveChat(), 4000)` — a **4s low-frequency safety-net poll**. Single timer (`pollTimer`); idempotent.
- `refreshActiveChat({ renderAfter=true })` (`3263-3284`): guarded by `state.user` and a `pollInFlight` mutex. Captures composer focus (`keepFocus`) and a `chatSnapshot` before; calls `loadChannelMessages`/`loadPrivateMessages` per `activeView`; only re-renders if the snapshot changed (`changed`), restoring composer focus via `state._focusComposer`. Errors are swallowed (best-effort).
- `syncScopeStream()` (`3331-3363`): opens **one SSE `EventSource`** per active scope: `GET /api/channels/{id}/events` (channel) or `GET /api/private-agent/events` (private), `withCredentials`. On `"update"` event → `refreshActiveChat()`. On terminal error (`readyState === 2`) → close, probe `GET /api/auth/me` (`skipAuthHandling` path via api), and schedule a reconnect after `SSE_RECONNECT_MS = 3000` ms if session still valid and tab visible. Called from `afterRender` and torn down in `stopPolling`/`closeScopeStream`; `pagehide` closes the stream.
- `stopPolling()` (`3291-3302`): clears `pollTimer`, `closeScopeStream()`, clears typing timers.

(These belong primarily to the chat section, but the data-layer rewrite must own the loader/poll/SSE coupling: SSE `"update"` and the 4s poll both call `refreshActiveChat`, which calls the channel/private message loaders. In React, model this as a `useChatSync(scope)` hook owning the `EventSource` + interval + in-flight mutex + change-detection, calling React-Query `invalidate`/`refetch` instead of `render()`.)

---

## 6. Consolidated React migration guidance for this section

### Module layout
- `utils/format.ts`: `initials, formatTime, formatTimestamp, formatNumber, shortSha, formatCompactNumber, formatFileSize, unixFromDatetimeLocal`.
- `utils/oauth.ts`: `isOAuthSecret, oauthStatusLabel, oauthProviderErrorText`.
- `lib/api.ts`: `api()` wrapper (credentials include, JSON-or-formdata headers, 401 → session-expired, error extraction), `safeUrl`, `downloadJson`.
- `data/loaders.ts` (or React-Query query/mutation defs): one function per loader above, each typed to its response.
- `features/settings/OAuthSettings.tsx`, `OAuthProviderCard.tsx`, `CodexOAuthFlow.tsx`, `GrokOAuthFlow.tsx`.
- `features/settings/SecretsSettings.tsx`, `SecretRow.tsx`.

### State ownership
- A settings store/context holding: `secrets`, `oauthProviders`, `oauthFlows`, `oauthCallbackUrls`, plus the rest of `loadSettings` configs. The OAuth slice reducer must replicate `updateOAuthState` exactly.
- `busy`/`error` → a global mutation-status context (or React-Query `isPending`/`error`) wired to toasts, mirroring `withBusy`.

### Preserve verbatim (do NOT change)
- All paths/methods/bodies in §2 and §5 tables. Especially: `start` body is the literal `"{}"`; `complete` body includes `callback_url` from `oauthCallbackUrls`; `import` body wraps as `{ credentials }`; export is GET (no body); query params `?limit=200` and token-usage `?days=&limit=200`.
- Side-effect chains: start/poll/complete → `loadHermesConfig`; import → `loadSecrets` + `loadHermesConfig`; secret PUT → `loadSecrets`.
- `mergePendingMessages` semantics when writing `messages`/`privateMessages` (keeps optimistic pending items).

### Reconciliation / focus / scroll concerns moving off full-teardown
- Legacy survives many "controlled input" cases only because values live in global `state` (Grok callback textarea) or are read at submit time (secret inputs). In React these become genuine controlled inputs/refs — straightforward, but **key OAuth cards by `provider.id`** and **key secret rows by `secret.key`** so input state doesn't bleed across reorders.
- `afterRender` currently re-invokes `syncScopeStream()` on every render; in React that coupling must move into a dedicated effect (`useEffect` with scope dep) so the stream is created/torn down on scope change, not on every state update. Do not recreate the `EventSource` on unrelated re-renders (legacy guards this with `scopeStreamKey === url && readyState !== 2`).
- The OAuth status `span` should gain `aria-live="polite"`; secret inputs and Grok textarea should gain real labels (a11y gaps noted above).
- No OAuth auto-poll exists — do not introduce one; keep poll/complete user-triggered.
