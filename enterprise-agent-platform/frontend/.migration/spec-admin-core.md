# Migration Spec — Admin Core

Scope: Admin panel shell + paging model, Account Management (user CRUD), Token-Usage
Monitoring (metrics + SVG curve + usage tables), and Message Audit (channel + private
delete flows).

Source: `frontend/src/legacy-app.js`
- Render functions: lines 1342–1987
- Delete/data-op functions: lines 3065–3147
- Loader functions: lines 3199–3262 (plus `loadUsers`/`loadPermissionGroups` at 3191–3198)
- Supporting helpers read: `h` (117), `svgNode` (215), `icon`+`ICONS` (135/196),
  `field` (331), `cardHead` (334), `statusBadge` (343), `emptyState` (358),
  `isAdmin`/`hasPermission`/`userPermissions` (349–357), `initials` (2807),
  `formatTimestamp` (2821), `formatNumber` (2827), `formatCompactNumber` (2835),
  `withBusy` (3466), `api` (73), `toast` (247), `unixFromDatetimeLocal` (2797),
  `messageAuditState` (2783), `accountModelControl` (2158), `hermesModelCatalog` (2138),
  `activeHermesProviderId` (2153), `renderMessageAttachments` (901), `render` (268),
  `ADMIN_PAGES` (182), `THINKING_DEPTH_OPTIONS` (174), `FALLBACK_PERMISSION_GROUPS` (168).

Stylesheet: `frontend/src/styles.css` — admin-pager/page 899–981, account 1038–1091,
token usage 1093–1278, audit 1280–1409, field-stack/help 307–308.

---

## 0. Critical conventions (preserve verbatim)

### `api(path, options)` (line 73)
- `fetch(path, { credentials: "include", headers: {"Content-Type":"application/json", ...}, ...options })`.
  If `options.body instanceof FormData`, the `Content-Type` header is omitted (not used in this section — all bodies here are JSON strings).
- Response body is read as text then `JSON.parse`d; parse failure yields `{}`.
- `401` (without `options.skipAuthHandling`) calls `handleSessionExpired()`.
- Non-OK throws `Error(data.error || data.detail || \`请求失败（${status}）\`)`.
- DELETE calls in this section ALWAYS send a body (even `"{}"`). Keep the bodies exactly.

### `withBusy(fn)` (line 3466)
Wraps every admin action:
1. `state.busy = true; state.error = ""; render()` (synchronous re-render → disables buttons).
2. `await fn()`.
3. On throw: `state.error = message`; if `state.user` truthy, `toast(message, {type:"error", title:"操作失败"})`.
4. `finally`: `state.busy = false; render()`.

In React this becomes an async helper that sets a `busy` flag in context and shows an error toast. The double-render (before + after) is what disables the submit/refresh buttons during the request — replicate via a `busy` boolean in shared state.

### `render()` (line 268) — full teardown
`app.replaceChildren(renderShell())` on every state change, then `requestAnimationFrame(afterRender)`.
`afterRender` calls `syncActiveAdminPager()` (line 299): on `activeView === "admin"` and viewport `max-width: 800px`, scroll the active `.admin-pager__item` into view (`scrollIntoView({block:"nearest", inline:"center"})`). This is the ONE imperative DOM concern for this section — see migration notes §6.

### Toast (line 247)
`toast(msg, {type, title})`. `type:"ok"` auto-dismisses at 3200ms (green check icon), else 6500ms (alert icon). Appends to `#toast-stack`. Replace with a toast context/portal.

### `h` attribute quirks to preserve
- `class` → `className`; `text` → `textContent`; `on*` → `addEventListener`.
- Boolean attrs: `value === false || value == null` ⇒ attribute omitted; `value === true` ⇒ empty-string attribute. (Matters for `aria-current`, `disabled`.)
- `disabled: state.busy` etc. become `disabled={busy}` in JSX.

---

## 1. Admin panel shell + paging model

### 1.1 `ADMIN_PAGES` constant (line 182)
Ordered array of 11 pages; order defines the pager and the `n/total` indicator.
Each item: `{ id, label, icon, description }`.

| id | label | icon | description |
|----|-------|------|-------------|
| accounts | 账户权限 | users | 企业账户、权限组与个人模型策略。 |
| tokens | Token 监控 | barChart | 按账户、私聊/频道、供应商和模型查看消耗。 |
| messages | 消息审计 | message | 频道消息删除与私人 Agent 会话审计。 |
| model | 模型接入 | shield | OAuth 供应商验证与 Hermes API 参数。 |
| telegram | Telegram | message | Telegram 私聊网关与用户绑定状态。 |
| updates | 自动更新 | refresh | 监听上游代码提交并自动拉取部署。 |
| security | 公网安全 | key | 反向代理、Cookie 与启动安全项。 |
| runtime | 运行时 | server | 底层基座服务健康状态。 |
| hermes | Hermes | settings | Hermes config.yaml 与环境变量。 |
| cognee | Cognee | library | Cognee 环境变量配置。 |
| secrets | 密钥 | key | 平台内部密钥。 |

Note: `accounts`, `tokens`, `messages` are owned by THIS spec. `model`, `telegram`,
`updates`, `security`, `runtime`, `hermes`, `cognee`, `secrets` are rendered by other
sections (`renderOAuthSettings`, `renderHermesConfig`, `renderTelegramAdminConfig`,
`renderAutoUpdateConfig`, `renderSecuritySettings`, `renderRuntimeSettings`,
`renderHermesInternalConfig`, `renderCogneeInternalConfig`, `renderSecretsSettings`).
The shell/pager/badges, however, are owned here and must drive ALL pages.

### 1.2 `renderAdminPanel()` (line 1342) — `AdminPanel`
Purpose: top-level admin view; permission gate + pager + active page header + content.

Markup:
```
div.panel
  div.panel__inner.admin-panel
    <AdminPager>                      // renderAdminPager(page.id)
    div.admin-page.admin-page--{page.id}
      div.admin-page__head
        div
          div.eyebrow            text "管理分页"
          h2                     text page.label
          p                      text page.description
        span.status             text "{index+1}/{ADMIN_PAGES.length}"   // 1-based position
      div.admin-page__content    <-- renderAdminPageSections(page.id)
```
Gate: `if (!isAdmin()) return emptyState("shield", "需要管理员权限", "请使用管理员账户登录后访问管理面板。")`.
`isAdmin()` = `state.user.role === "admin" || state.user.permission_group === "admin" || permissions.has("system_settings")`.

State read: `state.activeAdminPage` (via `activeAdminPage()`), `state.user` (gate).

### 1.3 `activeAdminPage()` (line 1363)
`ADMIN_PAGES.find(p => p.id === state.activeAdminPage) || ADMIN_PAGES[0]`.
`state.activeAdminPage` default `"accounts"`.

### 1.4 `renderAdminPager(activeId)` (line 1367) — `AdminPager`
Markup: `nav.admin-pager[aria-label="管理面板分页"]` containing one button per page:
```
button.admin-pager__item{.is-active}[type=button][aria-current=page|null]
  <icon page.icon size16>
  span text page.label
  <AdminPageBadge page.id>          // may be null
```
- `aria-current` set to `"page"` only when active, else attribute omitted (h drops null).
- onclick (async):
  - `state.activeAdminPage = page.id`
  - if `page.id === "messages"` → `await withBusy(loadMessageAudit)`
  - else if `page.id === "tokens"` → `await withBusy(loadTokenUsage)`
  - else → `render()` (no fetch; data already loaded by `loadAdminPanel` at login, or lazily by other sections).
- CSS: `.admin-pager` is `position: sticky; top:0; z-index:5`, horizontally scrollable on mobile (`::-webkit-scrollbar{display:none}`), with blur backdrop. Active scroll-into-view handled by `syncActiveAdminPager`.

Note: switching to `messages`/`tokens` triggers a load every time the tab is clicked
(not memoized). Preserve this behavior so the data is fresh, OR convert to a
per-tab effect that fetches on mount + manual refresh.

### 1.5 `adminPageBadge(pageId)` (line 1388) — `AdminPageBadge`
Returns `span.admin-pager__badge` with a count/string, or `null` when value is falsy
(0 / "" / undefined → no badge). The value map by pageId:

- `accounts`: `state.users.length`
- `tokens`: `state.tokenUsage?.summary?.total_tokens ? formatCompactNumber(...) : 0`
- `messages`: `(state.messageAudit?.privateConversations || []).filter(c => c.message_count > 0).length`
- `model`: `state.oauthProviders?.providers?.length || 0`
- `telegram`: `state.telegramConfig?.config?.enabled ? (linked_users?.length || "on") : 0`
- `updates`: `state.autoUpdateConfig?.config?.enabled ? "on" : 0`
- `security`: count of truthy among `[secure_cookie_enabled === false, admin_default_password_active, allow_default_admin_password, listen_restart_required]` from `state.securityConfig?.config`
- `runtime`: `state.runtimes ? Object.keys(state.runtimes).length : 0`
- `secrets`: `state.secrets.filter(s => !isOAuthSecret(s.key)).length` where `isOAuthSecret = key.includes("_OAUTH_")`

Badges for non-owned pages depend on OTHER sections' state slices; the badge component
must read shared state, so keep these slices in shared context. `formatCompactNumber`
uses `Intl.NumberFormat(undefined,{notation:"compact",maximumFractionDigits:1})`.

### 1.6 `renderAdminPageSections(pageId)` (line 1410)
Dispatch table returning an ARRAY of sections:
- `accounts` → `[renderAccountManagement()]`
- `tokens` → `[renderTokenUsageMonitoring()]`
- `messages` → `[renderMessageAuditManagement()]`
- `model` → `[renderOAuthSettings(), renderHermesConfig()]` (2 cards; other section)
- `telegram`/`updates`/`security`/`runtime`/`hermes`/`cognee`/`secrets` → single other-section render
- default → `[renderAccountManagement()]`

React: `AdminPanel` renders `<AdminPageContent pageId>` which switches on pageId.

---

## 2. Account Management

### 2.1 `renderAccountManagement()` (line 1425) — `AccountManagement`
Purpose: create new enterprise account + list/edit existing accounts.

Markup:
```
section.card.account-admin
  <cardHead "企业账户" "users">          // div.card__head
  <CreateAccountForm form.account-create>
  div.account-list
    [ <AccountRow> per user ]  OR  div.muted text "暂无企业账户。"
```
State read: `state.permissionGroups` (fallback `FALLBACK_PERMISSION_GROUPS` if empty),
`state.users`, `state.busy`, plus (indirectly) `state.hermesConfig`/`state.oauthProviders`
for the model dropdown (see `accountModelControl`).

`groups = state.permissionGroups.length ? state.permissionGroups : FALLBACK_PERMISSION_GROUPS`.
`FALLBACK_PERMISSION_GROUPS` ids/labels: `admin/管理员`, `manager/经理`, `member/成员`, `viewer/只读`.

### 2.2 Create form — `CreateAccountForm`
Inputs (controlled refs in legacy; controlled state in React):
- `username`: `input[placeholder="username", autocomplete="off"]`
- `displayName`: `input[placeholder="显示名称"]`
- `password`: `input[type=password, autocomplete="new-password", placeholder="初始密码"]`
- `position`: `input[placeholder="职位，例如 项目经理"]`
- `permissionGroup`: `<PermissionGroupSelect groups selected="member">`
- `accountModel`: `accountModelControl("")` → `{select, control}` (see §2.5)
- `thinkingDepth`: `<ThinkingDepthSelect selected="medium">`

Layout: `div.account-create__grid` with 7 `field(label, control)` wrappers:
`用户名, 显示名称, 初始密码, 职位, 权限组, 模型型号, 思考深度`.
Then submit button: `button.btn.btn--primary[type=submit][disabled=busy]` → `[icon plus 16] span "创建账户"`.
`field(label, control)` = `label.field > span(label) + control`.

onsubmit (preventDefault → `withBusy`):
```
POST /api/users
body JSON: {
  username, display_name, password, position,
  permission_group, model_name, thinking_depth
}
```
- Values come from each input's `.value` (model from `accountModel.select.value`).
- On success: clear `username/display_name/password/position/model_name` to `""`,
  reset `permission_group="member"`, `thinking_depth="medium"`,
  then `await loadUsers()`, then `toast("企业账户已创建", {type:"ok", title:"完成"})`.

### 2.3 `renderAccountRow(user, groups)` (line 1483) — `AccountRow`
Purpose: inline edit form for one user.

Markup:
```
form.account-row
  div.account-row__head
    div.account-row__identity
      div.avatar text initials(user.display_name||user.username)
      div
        strong text user.username
        span   text user.permission_group_label || user.permission_group || "member"
    <statusBadge user.active label=(user.active?"active":"disabled")>
  div.account-row__grid
    field 显示名称  -> input value=user.display_name
    field 职位      -> input value=user.position placeholder "职位"
    field 权限组    -> PermissionGroupSelect selected=user.permission_group||"member"
    field 模型型号  -> accountModel.control
    field 思考深度  -> ThinkingDepthSelect selected=user.thinking_depth||"medium"
    field 重置密码  -> input type=password autocomplete=new-password placeholder "留空不修改"
    label.check-row.account-row__active
      input[type=checkbox] (checked=user.active; disabled if user.id===state.user.id)
      div.check-row__text > strong "账户启用" + span "停用后无法登录"
  div.form-actions
    button.btn.btn--primary.btn--sm[type=submit][disabled=busy] > span "保存账户"
```
`statusBadge(ok,label)` = `span.status.status--{ok|ok:warn} > span.dot{.dot--warn} + textNode(label)`.

Key gating: the `active` checkbox is `disabled` when `user.id === state.user.id`
(cannot self-disable). Preserve.

onsubmit (preventDefault → `withBusy`):
```
PUT /api/users/{user.id}
body JSON: {
  display_name, position, permission_group, model_name,
  thinking_depth, active (boolean = checkbox.checked), password
}
```
- `password` sent as `""` when blank (server treats blank as "no change" — placeholder "留空不修改").
- On success: clear password field, `await loadUsers()`, `toast(\`已更新 ${user.username}\`, {type:"ok", title:"完成"})`.

NOTE the method asymmetry: CREATE is `POST /api/users`, UPDATE is `PUT /api/users/{id}`
(NOT PATCH). The task brief says "PATCH" but the actual code uses PUT — preserve PUT.

### 2.4 `permissionGroupSelect` (1545) / `thinkingDepthSelect` (1552)
- `PermissionGroupSelect(groups, selected)`: `select > option[value=group.id]{group.label||group.id}`; `select.value = selected` set AFTER options exist (important: in React just use `value={selected}`).
- `ThinkingDepthSelect(selected)`: options from `THINKING_DEPTH_OPTIONS`:
  `none/关闭, minimal/极低, low/低, medium/中, high/高, xhigh/超高`. `select.value = selected`.

### 2.5 `accountModelControl(selectedModel)` (line 2158)
Purpose: model `<select>` populated from the active Hermes provider's model catalog,
plus a help line. Returns `{select, control}`; control = `div.field-stack > select + div.field-help`.

Logic:
- `providerId = activeHermesProviderId()` = `state.oauthProviders?.active_provider || state.hermesConfig?.config?.provider || "openai-codex"`, normalized to one of `["openai-codex","xai-oauth"]`.
- `catalog = hermesModelCatalog(providerId)`:
  - prefer `state.hermesConfig.config.model_catalog[providerId]` (object `{models, default_model, error}`);
  - else from `state.oauthProviders.providers.find(p=>p.id===providerId)` → `{models, default_model: ..., error: model_catalog_error}`;
  - else `{models:[], default_model:"", error:"Hermes 模型目录不可用"}`.
- `defaultModel = catalog.default_model || state.hermesConfig?.config?.model || "系统默认"`.
- Options: first `option[value=""]{`系统默认 (${defaultModel})`}` then one per model.
- Selection: `clean = selectedModel.trim()`; if `clean && models.includes(clean)` → value=clean; else value="".
- Help text (`.field-help`):
  - if `clean && !models.includes(clean)`: `已保存模型 ${clean} 不在当前 Hermes 目录，保存后将改为系统默认。`
  - else if `models.length`: `${models.length} 个模型，来源：Hermes`
  - else: `catalog.error || "当前仅可使用系统默认模型。"`

React: `<AccountModelSelect value, onChange>` reading `hermesConfig`/`oauthProviders` from
context. Memoize the catalog with `useMemo` keyed on those two slices.

### 2.6 Loaders
- `loadUsers()` (3191): `GET /api/users` → `state.users = result.users`.
- `loadPermissionGroups()` (3195): `GET /api/permission-groups` → `state.permissionGroups = result.permission_groups`.
- These plus settings/audit/token are batched by `loadAdminPanel()` (3262):
  `Promise.all([loadUsers(), loadPermissionGroups(), loadSettings(), loadMessageAudit(), loadTokenUsage()])`. (`loadSettings` belongs to other sections but populates badge slices.)

Account row response field names consumed: `id, username, display_name, position,
permission_group, permission_group_label, model_name, thinking_depth, active`.

---

## 3. Token Usage Monitoring

### 3.1 `renderTokenUsageMonitoring()` (line 1559) — `TokenUsageMonitoring`
Purpose: token consumption dashboard (metrics + 7-day SVG curve + 4 usage tables).

State read: `state.tokenUsage` (whole report), `state.tokenUsageDays` (default 30),
`state.busy`, `state.oauthProviders` (via `oauthProviderLabel`).

Report shape (`state.tokenUsage`, populated by `loadTokenUsage`):
```
{
  window: { days, since, until },
  summary: { total_tokens, input_tokens, output_tokens, event_count,
             account_count, channel_event_count, private_event_count },
  today:   { total_tokens },
  last_7_days: { total_tokens },
  daily_usage: [ { date, label, start_at, input_tokens, output_tokens, total_tokens, event_count } ],
  by_account: [ {user_id, username, display_name, event_count, input_tokens, output_tokens, total_tokens, last_used_at} ],
  details:    [ {user_id, username, display_name, scope_type, scope_name, scope_id, provider, model, event_count, input_tokens, output_tokens, total_tokens} ],
  by_scope:   [ {scope_type, scope_name, scope_id, display_name, username, event_count, input_tokens, output_tokens, total_tokens} ],
  by_model:   [ {provider, model, event_count, input_tokens, output_tokens, total_tokens} ]
}
```

Markup:
```
div.token-usage
  section.card.token-usage__overview
    cardHead("Token 消耗总览","barChart", {desc, extra})
      desc = report.window ? `${formatTimestamp(window.since)} 至 ${formatTimestamp(window.until)}` : "暂无 token usage 数据"
      extra = div.token-usage__filters [
        field("时间范围", <days select>),
        button.btn.btn--sm[type=button][disabled=busy] onclick=withBusy(loadTokenUsage) > [icon refresh 14] span "刷新"
      ]
    div.metric-grid [ 8x usageMetric ... ]
    <renderTokenUsageCurve daily_usage>
  <renderUsageTable 按账户汇总 ...>            // by_account
  <renderUsageTable 账户/渠道/模型明细 ...>     // details
  div.token-usage__columns [
    <renderUsageTable 按渠道汇总 ...>           // by_scope
    <renderUsageTable 按供应商和模型汇总 ...>   // by_model
  ]
```

Days `<select>` (line 1565): options `[7,30,90,365]` → `${value} 天`;
`select.value = String(state.tokenUsageDays || report.window?.days || 30)`.
onchange: `state.tokenUsageDays = Number(value)||30; await withBusy(loadTokenUsage)`.

### 3.2 Metric tiles (8) — `usageMetric(label, value, suffix="")` (line 1671)
`div.metric-tile > span(label) + strong(text) + small(suffix?)`.
`strong` text = `formatNumber(value)` unless `value` is a string (then verbatim).
The 8 tiles:
1. 本日消耗 = `today.total_tokens`
2. 近 7 日消耗 = `last7.total_tokens`
3. 总 Token = `summary.total_tokens`
4. 输入 Token = `summary.input_tokens`
5. 输出 Token = `summary.output_tokens`
6. Agent 调用 = `summary.event_count`, suffix `次`
7. 涉及账户 = `summary.account_count`, suffix `个`
8. 频道/私聊 = `\`${channel_event_count||0}/${private_event_count||0}\`` (STRING → verbatim), suffix `次`

`formatNumber` = `Intl.NumberFormat().format(Number(value)||0)`.

### 3.3 `renderTokenUsageCurve(rows)` (line 1680) — `TokenUsageCurve` ★ SVG chart

This is the notable migration item. Geometry (exact constants):
```
width=640, height=170, padX=26, padY=18
usableWidth  = width - padX*2  = 588
usableHeight = height - padY*2 = 134
```
Data prep:
- `daily = normalizeTokenDailyUsage(rows)` → ALWAYS exactly 7 items (see §3.4).
- `maxTotal = Math.max(1, ...daily.map(r => Number(r.total_tokens)||0))` (floor of 1 avoids /0).
- For each row at `index`:
  - `ratio = max(0, (total_tokens||0) / maxTotal)`
  - `x = padX + (daily.length <= 1 ? 0 : index * (usableWidth / (daily.length - 1)))`
    → with 7 points: `x = 26 + index * (588/6) = 26 + index*98`. (x: 26,124,...,614.)
  - `y = height - padY - ratio * usableHeight` = `152 - ratio*134`. (Baseline y=152 at ratio 0; top y=18 at ratio 1.)
  - keep `{...row, x, y}`.
- `linePath` = points joined as `"M x y"` for index 0 then `"L x y"` after, coords `.toFixed(1)`.
- `areaPath` = (only if points): `linePath + ` L ${last.x} ${height-padY} L ${first.x} ${height-padY} Z`` (drop down to baseline 152 and close).
- `total = sum(total_tokens)`.

Markup:
```
div.token-curve
  div.token-curve__head
    div
      strong text "近 7 日消耗曲线"
      span   text `${formatNumber(total)} tokens`
    span.muted text daily.length ? `${daily[0].label} - ${daily[6].label}` : ""
  svg.token-curve__svg[viewBox="0 0 640 170"][role=img][aria-label="近 7 日 token 消耗曲线"][preserveAspectRatio=none]
    line.token-curve__axis  x1=26 y1=152 x2=614 y2=152          // baseline axis
    path.token-curve__area  d=areaPath        (if areaPath)
    path.token-curve__line  d=linePath        (if linePath)
    circle.token-curve__point cx cy r=4   (one per point)
      title text `${point.date}: ${formatNumber(point.total_tokens)} tokens`   // native tooltip
  div.token-curve__labels
    [ div.token-curve__label > span(row.label) + strong(formatCompactNumber(row.total_tokens)) ] x7
```
CSS hooks: svg `width:100%; height:190px; overflow:visible`. `.token-curve__line`
stroke `var(--sky)` width 3 round caps. `.token-curve__area` fill sky@16%.
`.token-curve__point` fill surface, stroke sky width 2. `.token-curve__labels` is a
`grid-template-columns: repeat(7, 1fr)`.

Note: SVG uses a fixed 640×170 viewBox with `preserveAspectRatio="none"` and CSS
`width:100%`, so it stretches horizontally to the container — points are NOT recomputed
on resize. React reimplementation: compute the path strings with the SAME formulas in
a `useMemo` and emit a static `<svg>`. No charting library needed; no resize listener
needed (viewBox + preserveAspectRatio handles it). `svgNode` is the SVG-namespace
analog of `h` (uses `setAttribute`); in JSX just write the elements directly.

### 3.4 `normalizeTokenDailyUsage(rows)` (line 1726)
- Take last 7 rows: `rows.slice(-7)`, map to `{date, label, input_tokens, output_tokens, total_tokens, event_count}` (all numeric coerced via `Number(x)||0`).
  - `label = row.label || tokenUsageDateLabel(row.start_at || row.date)`.
- Left-pad with empty placeholders `{date:"", label:"-", ...zeros}` via `unshift` until length===7.
- Always returns exactly 7 items (so the curve + label grid are stable width).

### 3.5 `tokenUsageDateLabel(value)` (line 1748)
`-` if falsy/invalid. Number → `new Date(value*1000)` (unix seconds); else `new Date(value)`.
Returns `MM/DD` zero-padded.

### 3.6 `renderUsageTable(title, desc, iconName, headers, rows, renderCells, emptyText)` (line 1755) — `UsageTable`
```
section.card.usage-card
  cardHead(title, iconName, {desc})
  rows.length
    ? div.usage-table[style="--usage-cols:{headers.length}"]
        div.usage-table__row.usage-table__head [ span(header) per header ]
        [ div.usage-table__row [ ...renderCells(row) ] per row ]
    : div.muted text emptyText
```
The `--usage-cols` CSS var drives `grid-template-columns: repeat(var(--usage-cols), minmax(120px,1fr))`. Rows are horizontally scrollable (`min-width:max(900px,100%)`).
React: `<UsageTable cols={headers} rows renderRow emptyText>`; pass `style={{"--usage-cols": headers.length}}`.

Four instantiations (rows + cell renderers):
1. **按账户汇总** (icon users), headers `[账户,调用,输入,输出,总计,最近使用]`, rows=`by_account`,
   cells: `userUsageCell(row)`, `formatNumber(event_count)`, `formatNumber(input_tokens)`,
   `formatNumber(output_tokens)`, `strong formatNumber(total_tokens)`, `formatTimestamp(last_used_at)||"-"`.
   empty `暂无账户 token 数据。`
2. **账户 / 渠道 / 模型明细** (icon barChart), headers `[账户,渠道,供应商/模型,调用,输入,输出,总计]`, rows=`details`,
   cells: `userUsageCell`, `tokenScopeLabel(row)`, `tokenModelLabel(row)`, then 4 numbers (last is strong total).
   empty `暂无 token 明细。`
3. **按渠道汇总** (icon message), headers `[渠道,调用,输入,输出,总计]`, rows=`by_scope`,
   cells: `tokenScopeLabel`, 4 numbers. empty `暂无渠道汇总。`
4. **按供应商和模型汇总** (icon shield), headers `[供应商/模型,调用,输入,输出,总计]`, rows=`by_model`,
   cells: `tokenModelLabel`, 4 numbers. empty `暂无模型汇总。`

Cell helpers:
- `userUsageCell(row)` (1767): `span.usage-user > strong(name) + small(@username | ID {user_id})`.
  `name = display_name || username || \`u${user_id||""}\``; small = `username ? @username : ID ${user_id||"-"}`.
- `tokenScopeLabel(row)` (1775): `private` → `私聊：${scope_name||display_name||username||scope_id}`;
  `channel` → `scope_name || 频道 {scope_id}`; else `scope_name||scope_id||"-"`.
- `tokenModelLabel(row)` (1781): `provider = oauthProviderLabel(row.provider)`; `model = row.model||"unknown"`;
  → `provider ? \`${provider} / ${model}\` : model`.
- `oauthProviderLabel(id)` (1787): label of matching `state.oauthProviders.providers[*].id`, else id.

### 3.7 `loadTokenUsage()` (line 3247)
```
days = encodeURIComponent(String(state.tokenUsageDays || 30))
GET /api/admin/token-usage?days={days}&limit=200
state.tokenUsage = result
state.tokenUsageDays = result?.window?.days || state.tokenUsageDays || 30   // server may clamp
```
Always `limit=200`. Re-syncs `tokenUsageDays` from response window.

---

## 4. Message Audit

### 4.1 `messageAuditState()` (line 2783)
Lazily ensures `state.messageAudit` exists with keys:
`auditChannelId, channelMessages, channelTotal, privateConversations, auditPrivateUserId, privateMessages, privateTotal`.
This is the audit substate slice. In React, make this its own reducer/context slice.

### 4.2 `renderMessageAuditManagement()` (line 1792) — `MessageAuditManagement`
Purpose: channel message deletion + private agent conversation audit/deletion. Two cards.

Derivations at top:
- `audit = messageAuditState()`.
- `channelId = String(audit.auditChannelId || state.activeChannelId || state.channels[0]?.id || "")`.
- Side effect: `if (!audit.auditChannelId && channelId) audit.auditChannelId = channelId;` (sets default). In React, do this in an effect, not during render.
- `channel = state.channels.find(c => String(c.id) === channelId)`.
- `channelMessages = audit.channelMessages || []`.
- `conversations = audit.privateConversations || []`.
- `selectedPrivateUserId = String(audit.auditPrivateUserId || "")`.
- `selectedConversation = conversations.find(c => String(c.user_id) === selectedPrivateUserId)`.

Form controls (4 transient inputs, not persisted to state):
- `messageId`: `input[type=number, min=1, step=1, placeholder="消息 ID"]`
- `beforeTime`: `input[type=datetime-local]`
- `privateMessageId`: same as messageId
- `privateBeforeTime`: same as beforeTime

Top-level wrapper: `div.audit-grid` with two `section.card.audit-card`.

#### Card A — 频道消息管理
```
cardHead("频道消息管理","message",{desc, extra})
  desc = channel ? `#${channel.name}：${audit.channelTotal||0} 条消息` : "选择频道后查看和删除消息"
  extra = button.btn.btn--sm[type=button][disabled=(busy||!channelId)]
            onclick=withBusy(()=>loadAuditChannelMessages(channelId)) > [icon refresh 14] span "刷新"
state.channels.length ? field("频道", channelSelect) : null
div.audit-tools [
  form.audit-tool (精确删除 by ID)
  form.audit-tool (删除时间点前)
  div.audit-tool.audit-tool--compact (全部清空)
]
div.audit-list  -> channelRows
```
- `channelSelect`: `select` of `option[value=item.id]{#item.name}`; `value=channelId`.
  onchange: `audit.auditChannelId = String(value); await withBusy(()=>loadAuditChannelMessages(nextId))`.
- Form 1 (精确删除): `field("精确删除", messageId)` + `button.btn.btn--danger[type=submit][disabled=(busy||!channelId)]` ([icon trash 15] span "删除 ID").
  onsubmit: `id = Number(messageId.value)`; if !id → `toast("请输入要删除的消息 ID",{title:"缺少消息 ID"})`; else `await deleteChannelMessage(channelId,id); messageId.value=""`.
- Form 2 (删除时间点前): `field("删除时间点前", beforeTime)` + danger submit ([icon trash] span "删除之前").
  onsubmit: `ts = unixFromDatetimeLocal(beforeTime.value)`; if !ts → `toast("请选择删除截止时间",{title:"缺少时间"})`; else `await deleteChannelMessagesBefore(channelId,ts); beforeTime.value=""`.
- Compact (全部清空): `span.field > span("全部清空") + span.muted("清空当前频道消息")` + `button.btn.btn--danger[type=button][disabled=(busy||!channelId)]` onclick=`clearChannelMessages(channelId)` ([icon trash] span "清空频道").
- `channelRows` = each `renderAuditMessageRow(message, {deletable:true, onDelete:()=>deleteChannelMessage(channelId, message.id)})`,
  or `div.muted text (channel ? "当前频道暂无消息。" : "暂无频道。")` when empty.

#### Card B — 私人 Agent 审计
```
cardHead("私人 Agent 审计","bot",{desc, extra})
  desc = `${conversations.filter(c=>c.message_count>0).length} 个用户有私人会话记录`
  extra = refresh button [disabled=busy] onclick=withBusy(loadMessageAudit)
div.audit-tools [
  form.audit-tool (精确删除 by ID)     -> deletePrivateMessage(selectedPrivateUserId, id)
  form.audit-tool (删除时间点前)       -> deletePrivateMessagesBefore(selectedPrivateUserId, ts)
  div.audit-tool.audit-tool--compact   -> clearPrivateMessages(selectedPrivateUserId)
]
div.audit-private [
  div.audit-conversations -> conversations.map(renderPrivateConversationItem) | div.muted "暂无用户可审计。"
  div.audit-private__messages [
    selectedConversation ? div.audit-subhead [ div > strong(name) + span(@username), span.status `${audit.privateTotal||0} messages` ] : null
    div.audit-list -> privateRows
  ]
]
```
- Private forms mirror channel forms but disabled when `!selectedPrivateUserId`; same toast guards.
- `privateRows` = each `renderAuditMessageRow(message, {deletable:true, onDelete:()=>deletePrivateMessage(selectedPrivateUserId, message.id)})`,
  or `div.muted text (selectedConversation ? "该用户暂无私人 Agent 消息。" : "选择一个用户查看私人 Agent 会话。")`.

### 4.3 `renderPrivateConversationItem(item)` (line 1946) — `PrivateConversationItem`
```
button.audit-conversation{.is-active}[type=button]
  div.avatar text initials(item.display_name||item.username)
  div.audit-conversation__main
    strong text item.display_name||item.username
    span   text item.last_message_at ? formatTimestamp(item.last_message_at) : "暂无记录"
  span.nav__badge text String(item.message_count||0)
```
- `active = String(audit.auditPrivateUserId||"") === String(item.user_id)`.
- onclick: `audit.auditPrivateUserId = String(item.user_id); await withBusy(()=>loadAuditPrivateMessages(item.user_id))`.
- Conversation fields used: `user_id, display_name, username, last_message_at, message_count`.

### 4.4 `renderAuditMessageRow(message, {deletable, onDelete})` (line 1966) — `AuditMessageRow`
```
article.audit-message.audit-message--{message.author_type}
  div.audit-message__meta
    span.mono text `#${message.id}`
    strong   text author                      // message.username || (author_type==="agent" ? "Agent":"User")
    span     text message.author_type
    span     text formatTimestamp(message.created_at)
  div.audit-message__body text message.content
  message.attachments?.length ? renderMessageAttachments(message.attachments) : null
  deletable ? div.audit-message__actions > button.icon-btn[title="删除消息"][aria-label="删除消息"] onclick=onDelete > [icon trash 16] : null
```
Message fields: `id, username, author_type, created_at, content, attachments[]`.
`renderMessageAttachments` (901): renders `div.msg-attachments` of image/file anchors
(`download_url||url`, `target=_blank rel=noreferrer`); reuse the shared component.
`formatTimestamp` = number→`new Date(v*1000)` else `new Date(v)`, `toLocaleString()`,
falls back to `String(value)` if invalid.

### 4.5 Delete data-ops (lines 3065–3135) — ALL use `window.confirm` then `withBusy`
All resolve `result.deleted || 0` for the success toast. Confirmations are native
`window.confirm` (blocking) — in React replace with a confirm dialog/modal but PRESERVE
the prompt text and the "cancel = no-op" behavior.

| fn | guard | confirm text | request | post |
|----|-------|-------------|---------|------|
| `deleteChannelMessage(channelId, messageId)` | both truthy | `删除频道消息 #${messageId}？` | `DELETE /api/admin/channels/{channelId}/messages/{messageId}` body `"{}"` | `reloadAfterChannelAuditChange(channelId)`; toast `已删除 ${deleted} 条频道消息` ok |
| `deleteChannelMessagesBefore(channelId, beforeCreatedAt)` | both truthy | `删除该时间点之前的频道消息？` | `DELETE /api/admin/channels/{channelId}/messages` body `{before_created_at}` | same reload + toast |
| `clearChannelMessages(channelId)` | channelId | `清空当前频道的全部消息？` | `DELETE /api/admin/channels/{channelId}/messages` body `{clear_all:true}` | same reload; toast `已清空 ${deleted} 条频道消息` |
| `deletePrivateMessage(userId, messageId)` | both | `删除私人 Agent 消息 #${messageId}？` | `DELETE /api/admin/private-agent/conversations/{userId}/messages/{messageId}` body `"{}"` | `reloadAfterPrivateAuditChange(userId)`; toast `已删除 ${deleted} 条私人 Agent 消息` |
| `deletePrivateMessagesBefore(userId, beforeCreatedAt)` | both | `删除该时间点之前的私人 Agent 消息？` | `DELETE /api/admin/private-agent/conversations/{userId}/messages` body `{before_created_at}` | same reload + toast |
| `clearPrivateMessages(userId)` | userId | `清空当前用户的全部私人 Agent 消息？` | `DELETE /api/admin/private-agent/conversations/{userId}/messages` body `{clear_all:true}` | same reload; toast `已清空 ${deleted} 条私人 Agent 消息` |

`before_created_at` is a UNIX SECONDS integer from `unixFromDatetimeLocal` (`Math.floor(Date(value).getTime()/1000)`; `null` if blank/invalid — guarded by the toast in the form handler before reaching the data-op).

Cascade reloads:
- `reloadAfterChannelAuditChange(channelId)` (3137): `Promise.all([loadChannels(), loadAuditChannelMessages(channelId)])`; then if `String(state.activeChannelId)===String(channelId)` also `loadChannelMessages()` (keeps the live channel view consistent — cross-section dependency).
- `reloadAfterPrivateAuditChange(userId)` (3142): `Promise.all([loadPrivateConversations(), loadAuditPrivateMessages(userId)])`; then if `String(state.user?.id)===String(userId)` also `loadPrivateMessages()`.

### 4.6 Audit loaders (3199–3262)
- `loadAuditChannelMessages(channelId=audit.auditChannelId)` (3199): if no id → `channelMessages=[]; channelTotal=0; return`. Else set `audit.auditChannelId=String(channelId)`; `GET /api/admin/channels/{channelId}/messages?limit=200` → `audit.channelMessages = result.messages||[]; audit.channelTotal = result.total||0`.
- `loadPrivateConversations()` (3211): `GET /api/admin/private-agent/conversations` → `audit.privateConversations = result.conversations||[]`. Then auto-select: if current `auditPrivateUserId` not in list, pick first with `message_count>0`, else first conversation's `user_id` (as String), else `""`.
- `loadAuditPrivateMessages(userId=audit.auditPrivateUserId)` (3223): if no id → clear `privateMessages=[]; privateTotal=0`. Else set id; `GET /api/admin/private-agent/conversations/{userId}/messages?limit=200` → `audit.privateMessages=result.messages||[]; audit.privateTotal=result.total||0`.
- `loadMessageAudit()` (3253): ensure channels loaded (`if (!state.channels.length) await loadChannels()`); default `auditChannelId` to `state.activeChannelId||channels[0].id`; `Promise.all([loadAuditChannelMessages(auditChannelId), loadPrivateConversations()])` then `loadAuditPrivateMessages(auditPrivateUserId)` (depends on auto-select from privateConversations — keep the sequencing: conversations first, then private messages).

All audit message GETs use `limit=200`.

---

## 5. State fields summary (read/write)

| field | read | write | who |
|-------|------|-------|-----|
| `state.activeAdminPage` | pager, shell | pager onclick | shell |
| `state.user` | gate, self-disable, reloadAfterPrivate | – | shell/account |
| `state.users` | account list, badge | `loadUsers` | account |
| `state.permissionGroups` | group select | `loadPermissionGroups` | account |
| `state.busy` | every disabled= | `withBusy` | global |
| `state.hermesConfig` / `state.oauthProviders` | model select, tokenModelLabel, badges | other loaders | shared |
| `state.tokenUsage` | token view + badge | `loadTokenUsage` | tokens |
| `state.tokenUsageDays` | days select | days onchange / `loadTokenUsage` | tokens |
| `state.channels` / `state.activeChannelId` | audit channel select/default | `loadChannels` | shared |
| `state.messageAudit.*` | audit view | audit loaders + onclick handlers | audit |
| `state.securityConfig/telegramConfig/autoUpdateConfig/runtimes/secrets` | badges only | other loaders | shared (badges) |

---

## 6. React migration notes

### Component tree
```
<AdminPanel>                       // gate via useAuth(); reads activeAdminPage
  <AdminPager>                     // ADMIN_PAGES.map -> <AdminPagerItem>
    <AdminPageBadge pageId/>       // reads many state slices via context
  <AdminPageHeader page/>
  <AdminPageContent pageId>
    accounts -> <AccountManagement>
                  <CreateAccountForm/>
                  <AccountRow user/> (list)   // shared <PermissionGroupSelect> <ThinkingDepthSelect> <AccountModelSelect>
    tokens   -> <TokenUsageMonitoring>
                  <UsageMetricTile/> x8
                  <TokenUsageCurve daily/>     // pure SVG, useMemo path strings
                  <UsageTable/> x4
    messages -> <MessageAuditManagement>
                  <ChannelAuditCard>  (select + 3 tools + <AuditMessageRow> list)
                  <PrivateAuditCard>  (<PrivateConversationItem> list + subhead + <AuditMessageRow> list)
```

### State ownership / hooks
- Global shared state (user, busy, channels, hermesConfig, oauthProviders, the various
  config slices used by badges) → React Context + `useReducer` (or a store like Zustand).
  Badges force the pager to read many slices; a single `AdminContext` exposing all of
  them avoids prop drilling.
- `activeAdminPage` → context (or URL route param — better: map each page to a route so
  the sticky pager becomes nav links; preserves deep-link + the per-tab fetch becomes a
  route loader/effect).
- Account form fields → local `useState` per input (controlled). On submit, build the
  exact JSON body. After success reset to defaults (`member`/`medium`/empty).
- Audit substate (`messageAudit`) → its own reducer slice; the four transient inputs
  (`messageId`, `beforeTime`, ...) are LOCAL `useState`, NOT global (they were transient
  refs in legacy). Clear them on successful submit.
- `tokenUsageDays` → context (drives refetch). Refetch on change via effect or explicit
  handler calling the same `GET /api/admin/token-usage?days=&limit=200`.

### Data fetching
- Replace `withBusy(loadX)` calls with an async action that toggles `busy` and calls
  the same endpoints. The double-`render()` in `withBusy` is just for the disabled state —
  React handles that with the `busy` flag.
- Per-tab fetch on pager click (`messages`→loadMessageAudit, `tokens`→loadTokenUsage)
  becomes a `useEffect`/route-loader keyed on the active tab + a manual refresh button.
  Keep the SAME sequencing inside `loadMessageAudit` (conversations before private msgs)
  and `loadTokenUsage` (re-sync `tokenUsageDays` from `window.days`).
- Keep cascade reloads: after a channel delete, also refresh the live channel view if it
  is the active channel; after a private delete, refresh the user's own private thread if
  it is the current user. These are cross-section dependencies — expose `loadChannels`,
  `loadChannelMessages`, `loadPrivateConversations`, `loadPrivateMessages` from shared store.

### SVG curve (the notable item)
- Reimplement with the EXACT geometry (640×170, padX 26, padY 18, 7 points, x step 98,
  baseline y 152). Compute `linePath`/`areaPath`/points in `useMemo([daily])`. Render a
  static `<svg viewBox="0 0 640 170" preserveAspectRatio="none">` with the same classes
  (`token-curve__axis|area|line|point`). Per-point `<title>` for the native tooltip.
  No chart library; no resize handling (viewBox + CSS width:100% scales it). Keep
  `normalizeTokenDailyUsage` (always 7 items via left-pad) so the layout never jumps.

### Confirmations & toasts
- `window.confirm` is synchronous/blocking; legacy returns early on cancel. In React,
  prefer a promise-based confirm modal but keep the exact prompt strings and the
  cancel-is-noop semantics. Toasts → toast context/portal; keep `type:"ok"` (3.2s) vs
  error (6.5s) timing and titles.

### Reconciliation / focus / scroll concerns (moving off full teardown)
- `syncActiveAdminPager`: on mobile, the active pager item must `scrollIntoView`. With
  React this becomes a `useEffect([activeAdminPage])` + `ref` on the active item +
  matchMedia `(max-width:800px)` check.
- The legacy full-teardown discards form input values on every `render()`. Because
  `withBusy` re-renders mid-action, account/audit inputs were RE-CREATED from `user.*`
  on each render — meaning unsaved edits in an `AccountRow` are LOST whenever any
  re-render fires (e.g. another action setting `busy`). React controlled state will
  PRESERVE edits across re-renders; this is a behavior improvement but could surprise
  parity testing — note it. Conversely, ensure the model-select help line and the
  permission/thinking selects derive their value from props, not uncontrolled DOM.
- `.audit-list` (max-height 520px) and `.audit-conversations` (560px) are
  independently scrollable; preserve their scroll position across refreshes (React keeps
  the node mounted, so this is free as long as keys are stable — key message rows by
  `message.id`, conversations by `user_id`).
- Tables are horizontally scrollable via `--usage-cols` + `min-width:max(900px,100%)`.
  Pass `style={{["--usage-cols"]: headers.length}}`.
- `aria-current="page"` on active pager item, `role="img"`+`aria-label` on the SVG, and
  the trash button `aria-label="删除消息"` are the only a11y attributes present. GAPS to
  consider adding (not required for parity): the pager `nav` could use `role="tablist"`/
  `tab`/`tabpanel` semantics; the days/channel/group `<select>`s lack explicit labels
  beyond the visual `field` `<span>` (wrap with `htmlFor`/`id` or `aria-label`); the
  native `window.confirm` has no focus management — a custom dialog should trap focus.
