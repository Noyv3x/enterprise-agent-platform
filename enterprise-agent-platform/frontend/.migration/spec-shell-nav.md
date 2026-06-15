# Migration Spec — App Shell, Login, Sidebar, Topbar, Navigation

Source: `frontend/src/legacy-app.js` (lines ~367–585 + cross-referenced helpers).
Stylesheet: `frontend/src/styles.css`.
Bootstrap host: `frontend/index.html`.

This section owns the application chrome: the unauthenticated login screen, the
authenticated two-column shell (sidebar + main column), the responsive mobile
drawer, the topbar, the workspace/channel navigation, theme toggle placement,
session lifecycle (boot / login / logout / 401 expiry), and the render
plumbing that everything else relies on. Chat/knowledge/admin **content** views
are owned by other specs and are referenced here only at their boundaries
(`renderContent` dispatch + the loaders the nav triggers).

---

## 0. Global infrastructure this section depends on (must be ported first)

### 0.1 `state` (the single global mutable object) — fields read/written here
Defined at `legacy-app.js:8–59`. Fields this section touches:

| Field | Type | Meaning / usage in this section |
|---|---|---|
| `user` | `object \| null` | Auth gate. `null` => render login; truthy => render shell. Holds `id`, `username`, `display_name`, `position`, `role`, `permission_group`, `permission_group_label`, `permissions[]`. |
| `activeView` | `"channel" \| "private" \| "knowledge" \| "admin"` | Which content view + which nav item is active. Default `"channel"`. |
| `activeChannelId` | `id \| null` | Selected channel; drives sidebar `.channel.is-active` and topbar title. |
| `channels` | `array` | Sidebar channel list + badge count. Each `{ id, name }`. |
| `messages` | `array` | Channel message count shown in topbar sub. |
| `documents` | `array` | Knowledge doc count in topbar sub. |
| `sidebarOpen` | `bool` | Mobile drawer open/closed. Drives `.shell.is-open`, scrim tabindex, inert. |
| `busy` | `bool` | Disables login button / drives spinner; set by `withBusy`. |
| `error` | `string` | Login error text (rendered in `.error[role=alert]`). |
| `privateTelegram` | `object \| null` | Topbar Telegram action gating (gateway/link). |
| `privateTelegramExpanded` | `bool` | Topbar Telegram popover toggle state. |
| `agentStatuses` | `{channels:{}, private:null}` | Topbar sub line ("Agent 正在回复 …"). |
| `_lastView` | `string \| null` | Used by `renderContent` to add `.view-enter` only on view change. |
| `_focusComposer` | `bool` | Post-render flag → focus composer textarea after render. Set when switching to channel/private. |
| `_scrollChatToBottom` | `bool` | Post-render scroll flag (consumed by chat spec). |

> Migration: replace the mutable global with React state. `user`, `activeView`,
> `activeChannelId`, `sidebarOpen`, `busy`, `error`, `privateTelegramExpanded`
> belong in an app-level store/context (see §9). `_lastView`, `_focusComposer`,
> `_scrollChatToBottom` are render-side-effect flags → become `useRef` +
> `useEffect`, NOT render-visible state.

### 0.2 `api(path, options)` — the single fetch wrapper (`legacy-app.js:73–94`)
```
fetch(path, {
  credentials: "include",
  headers: isForm ? (options.headers||{})
                  : { "Content-Type": "application/json", ...(options.headers||{}) },
  ...options,
})
```
- `isForm = options.body instanceof FormData` (skips JSON content-type).
- Reads `res.text()`, then `JSON.parse`; on parse failure → `data = {}` (tolerates
  HTML 502/504/login pages from a fronting proxy — must NOT throw).
- `res.status === 401 && !options.skipAuthHandling` → calls `handleSessionExpired()`.
- `!res.ok` → `throw new Error(data.error || data.detail || \`请求失败（${res.status}）\`)`.
- Returns parsed `data`.

> Migration: port verbatim as `apiClient.ts`. Preserve `credentials:"include"`,
> the tolerant JSON parse, the 401 hook, and the error-message precedence
> (`error` → `detail` → localized fallback). Keep `skipAuthHandling` opt-out.

### 0.3 `safeUrl(value, {allowData})` (`legacy-app.js:100–114`)
Allow-list URL sanitizer. Used by `h()` for `href`/`src`. For this section it
matters for `<img src="/ubitech-logo.png">` (relative → passes). Port verbatim;
React `src`/`href` should run through it for any backend-supplied URL.

### 0.4 `h()` / `icon()` / `svgNode()` (`legacy-app.js:117–227`)
The hyperscript builder + Lucide-style inline SVG factory. The whole DOM in this
section is built with `h()`. Notable `h()` behaviors to reproduce in JSX:
- `class` → `className`; `text` → text child.
- `on*` keys add event listeners (lowercased).
- `href` sanitized via `safeUrl`; `src`/`xlink:href` via `safeUrl({allowData:true})`.
- Attribute value `=== true` → empty-string attr (boolean attr); `false`/`null`
  → attribute omitted entirely. **This is how `inert`, `aria-hidden`, `disabled`
  get conditionally dropped.** In React: conditionally spread or pass `undefined`.

`icon(name, {size, cls, strokeWidth})` → `<svg viewBox="0 0 24 24" fill="none"
stroke="currentColor" stroke-width=1.7 stroke-linecap/linejoin="round"
aria-hidden="true">` with child primitives from the `ICONS` map (`legacy-app.js:135–166`).
Icons used in this section: `hash, bot, library, shield, menu, message, sun,
moon, logout, plus, loader`.

> Migration: build an `<Icon name size className strokeWidth/>` React component
> backed by the same `ICONS` map. Keep `aria-hidden="true"` default. The
> `cls:"spin"` variant (login loader) must keep the existing spin animation class.

### 0.5 Theme (`legacy-app.js:230–244` + `index.html:15–21`)
- `index.html` inline script (pre-paint, anti-FOUC): reads `localStorage["eap-theme"]`;
  if `"light"|"dark"` sets `document.documentElement.dataset.theme`. **Keep this
  inline script as-is** — it must run before React mounts.
- `currentTheme()`: returns `dataset.theme` if `light|dark`, else
  `matchMedia("(prefers-color-scheme: dark)")` → `"dark"` else `"light"`.
- `toggleTheme()`: flips, writes `document.documentElement.dataset.theme`,
  persists `localStorage["eap-theme"]` (wrapped in try/catch), then `render()`.
- `themeToggle()`: `<button class="icon-btn" title aria-label="切换主题">` with
  `sun` icon when dark / `moon` icon when light; onclick `toggleTheme`.

> Migration: a `ThemeProvider`/`useTheme` hook holding `'light'|'dark'|'system'`,
> writing `data-theme` on `<html>` and persisting to `eap-theme`. Theme toggle is
> rendered in the **topbar actions** (right side, after the optional private
> Telegram action). On `prefers-color-scheme` it derives via matchMedia.

### 0.6 `toast(message,{type,title})` (`legacy-app.js:247–265`)
Appends a `.toast` node into `#toast-stack` (`role=status`), auto-dismiss after
3200ms (ok) / 6500ms (error), close button, leave animation on `animationend`.
Used here by `handleSessionExpired` ("会话已过期，请重新登录" / "需要登录", error).
`withBusy` uses it for generic op failures. Port as a toast context/portal.

### 0.7 Render plumbing (`legacy-app.js:268–322`) — REPLACE, don't port literally
- `render()`: if `shouldDeferComposerRender()` set `composerState.renderDeferred=true`
  and bail (IME composition guard — chat spec concern). Else capture message
  scroll, `app.replaceChildren(state.user ? renderShell() : renderLogin())`, then
  `requestAnimationFrame(afterRender)`. **This is the full-teardown re-render the
  migration removes.**
- `afterRender(messageScroll)`: restores `.messages` scroll, resets
  `_scrollChatToBottom`, autogrows composer textarea, focuses composer if
  `_focusComposer`, `syncActiveAdminPager()`, `syncScopeStream()`.
- `syncActiveAdminPager()`: only on admin + `<=800px`, `scrollIntoView` the active
  admin pager item.
- `captureMessageScroll`/`restoreMessageScroll`: scroll preservation keyed off
  `.messages[data-chat-key]` (chat spec concern).

> Migration: React reconciles; there is no `replaceChildren`. The
> post-render effects become `useEffect`s in the relevant components:
> - composer focus → effect in Composer keyed on view/channel + a `focusToken`.
> - `syncScopeStream` → effect in the active chat view keyed on `activeView`/`activeChannelId`.
> - `syncActiveAdminPager` → effect in the Admin pager.

### 0.8 Permission helpers (`legacy-app.js:349–357`)
- `userPermissions()` → `new Set(state.user?.permissions || [])`.
- `isAdmin()` → `role === "admin" || permission_group === "admin" || permissions.has("system_settings")`.
- `hasPermission(p)` → `isAdmin() || permissions.has(p)`.

> Migration: `usePermissions()` hook returning `{ isAdmin, has(p) }` derived from
> `user` with `useMemo`. Used by sidebar nav gating, channel-create form gating,
> chat send gating, and the `renderShell` view-fallback guard.

### 0.9 Shared atoms used here
- `brand()` (`:325–330`): `<div class="brand"><img class="brand__logo"
  src="/ubitech-logo.png" alt="ubitech"><span class="brand__eyebrow">Agent
  Platform</span></div>`. Used in login card AND sidebar head. (CSS hides the
  logo inside `.auth__card` on desktop, restores it on `<=800px`.)
- `field(label, control)` (`:331–333`): `<label class="field"><span>{label}</span>{control}</label>`.
- `initials(name)` (`:2807–2813`): 2-letter avatar initials.
- `activeChannel()` (`:2850`): `state.channels.find(c => c.id === activeChannelId)`.
- `activeAdminPage()` (`:1363–1365`): finds `ADMIN_PAGES` entry by
  `state.activeAdminPage`, defaults to first. Used by topbar sub on admin view.
- `agentStatusFor(mode)` / `agentStatusText(status)` (`:2858–2874`): topbar sub
  "Agent 准备回复/正在回复 {username}". `isAgentActive` = state `queued|replying`.
- `scopeIdFor(mode)` (`:2852–2854`): `private` → `String(user.id)`, else
  `String(channelId)`.

---

## 1. Component: `LoginView` (from `renderLogin`, `legacy-app.js:367–404`)

**Purpose:** Unauthenticated full-screen split login (brand aside + centered card with username/password form).

### DOM / markup tree
```
<main class="auth">
  <aside class="auth__aside">
    <img class="auth__logo" src="/ubitech-logo.png" alt="ubitech">
  </aside>
  <div class="auth__main">
    <div class="auth__card">
      {brand()}                         // .brand (logo hidden on desktop via CSS)
      <h1>登录</h1>
      <form>                            // onsubmit handler below
        {field("用户名", usernameInput)}  // <label.field><span>用户名</span><input></label>
        {field("密码", passwordInput)}
        <button class="btn btn--primary btn--lg btn--block" type="submit" disabled={busy}>
          {busy ? <Icon loader cls="spin" size=18/> : null}
          <span>{busy ? "正在登录…" : "登录"}</span>
        </button>
        <div class="error" role="alert">{error}</div>
      </form>
    </div>
  </div>
</main>
```
Inputs:
- username: `<input name="username" autocomplete="username" placeholder="用户名">`
- password: `<input name="password" type="password" autocomplete="current-password" placeholder="密码">`

### State read
`state.busy` (button disabled + spinner + label), `state.error` (error box; CSS
`.error` is `display:none` when empty, shown when `:not(:empty)`).

### Event handlers
- `form onsubmit` (async): `event.preventDefault()` then `withBusy(async () => {`
  - `POST /api/auth/login` (see §1 API).
  - On success: `state.user = result.user`, `await loadInitial()`, `startPolling()`.
  - `withBusy` sets `busy` true→render, catches error into `state.error` (and toasts
    only if `state.user` already truthy — on login it's still null so NO toast,
    error shows in the `.error` box), finally `busy=false`→render.

### API call
- **`POST /api/auth/login`**
  - Request body (JSON): `{ "username": <usernameInput.value>, "password": <passwordInput.value> }`
  - Response: `{ user: {...} }` → assigned to `state.user`.
  - Side effects on success: `loadInitial()` (see §6) + `startPolling()` (§7).

### Edge cases / states
- Empty fields are NOT pre-validated client-side; server returns the error which
  surfaces in `.error`.
- Wrong creds: `api()` throws → `withBusy` sets `state.error`; since `state.user`
  is still null, **no toast**, only the inline `.error` box.
- Loading: button disabled + spinning loader icon + label "正在登录…".

### Accessibility
- `.error` has `role="alert"` (live region for SR).
- Inputs use proper `autocomplete` tokens; password `type=password`.
- **Gap:** inputs have `placeholder` + a visible `<span>` label via `field()` but
  the `<label>` is not programmatically associated (`htmlFor`/`id`) — only visual
  wrapping. The wrapping `<label>` DOES associate implicitly (input is a descendant),
  so it is acceptable; keep the wrapping `<label>` in React.
- **Gap:** no autofocus on username. Optional improvement: `autoFocus` on username.

### React migration notes
- `LoginView` controlled component: `useState` for `username`, `password`. Local
  `error`/`busy` may come from an auth hook (`useAuth().login`).
- Replace `withBusy`+global `error` with `const { login, busy, error } = useAuth()`.
- `onSubmit` calls `login(username, password)` which performs the POST, sets user,
  triggers initial-load + polling start (those move into `AuthProvider`/effects).
- Keep field labels, placeholders, autocomplete, button classes, spinner icon, and
  the `role="alert"` error box exactly.

---

## 2. Component: `AppShell` (from `renderShell`, `legacy-app.js:407–415`)

**Purpose:** Authenticated two-column layout (sidebar + main) with the mobile
drawer scrim. Top-level switch is: `state.user ? <AppShell/> : <LoginView/>`.

### View-fallback guard (runs every render — IMPORTANT)
```
if (!isAdmin() && state.activeView === "admin") state.activeView = "channel";
if (!hasPermission("private_agent") && state.activeView === "private") state.activeView = "channel";
```
If the current user lacks permission for the active view, silently redirect to
`"channel"`. Must be preserved (e.g. a demoted user or a stale view).

### DOM / markup tree
```
<div class="shell {is-open if sidebarOpen}">
  {renderSidebar()}                 // <aside class="sidebar" id="app-sidebar">
  <button class="scrim" type="button" aria-label="关闭菜单"
          tabindex={sidebarOpen ? "0" : "-1"} onclick={closeSidebar}></button>
  <main class="main">
    {renderTopbar()}                // <header class="topbar">
    {renderContent()}              // <section class="content"> (other specs)
  </main>
</div>
```

### State read/write
- Reads `state.sidebarOpen` (→ `is-open` class + scrim tabindex), `state.activeView`.
- Writes `state.activeView` in the permission guard (redirect).

### Responsive layout (CSS, `styles.css:328–334`, `1789–1824`)
- Desktop: `.shell { display:grid; grid-template-columns: var(--sidebar-w 264px) 1fr; height:100dvh; overflow:hidden }`.
- `<=800px`: `.shell { grid-template-columns: 1fr }` (sidebar overlays, see §3),
  `.scrim { display:block; position:fixed; inset:0; z-index:20; background:var(--overlay); opacity:0; visibility:hidden; transition }` and
  `.shell.is-open .scrim { opacity:1; visibility:visible }`.
- The `.scrim` is a real `<button>` (keyboard-dismissable). Desktop `.scrim { display:none }`.

### React migration notes
- `AppShell` renders `<Sidebar/>`, scrim button, `<main>` with `<Topbar/>` +
  `<ContentRouter/>`.
- The permission guard becomes an effect/selector: derive the "effective view"
  (`if !canSee(activeView) -> 'channel'`) so you never render a view the user
  can't access. Prefer a `useEffect` that resets `activeView` when permissions
  change, plus a guarded render. Keep behavior identical (silent redirect).
- Scrim: keep as a focusable `<button>` with `tabIndex` toggling for a11y parity.

---

## 3. Responsive sidebar drawer behavior (a11y + focus) — CRITICAL

Functions: `sidebarHiddenForA11y` (`:419–421`), `openSidebar` (`:423–429`),
`closeSidebar` (`:431–437`), plus global listeners (`:3483–3518`).

### Off-canvas + a11y hiding
- `sidebarHiddenForA11y()` = `!state.sidebarOpen && matchMedia("(max-width:800px)").matches`.
  i.e. **mobile AND closed**.
- In `renderSidebar`, the `<aside>` gets `inert: hidden` and
  `aria-hidden: hidden ? "true" : null` so its controls are not focusable/announced
  while off-screen. On desktop or when open, both are dropped (no `inert`, no `aria-hidden`).
- CSS `<=800px`: `.sidebar { position:fixed; inset:0 auto 0 0; width:min(86vw,
  var(--sidebar-w)); transform:translateX(-102%); transition:transform .26s ...;
  box-shadow:var(--shadow-3) }`; `.shell.is-open .sidebar { transform:none }`.
  So it slides in/out via CSS transform; JS only toggles `is-open` + inert/aria.

### Open flow (`openSidebar`)
1. `state.sidebarOpen = true`; `render()`.
2. `requestAnimationFrame(() => app.querySelector("#app-sidebar .nav__item")?.focus())`
   — moves focus into the drawer (first nav item) on the next frame, after
   `afterRender` runs. **This is a deliberate focus move into the disclosure.**

### Close flow (`closeSidebar`)
1. capture `wasOpen`; set `state.sidebarOpen = false`; `render()`.
2. if `wasOpen`: `requestAnimationFrame(() => app.querySelector(".menu-btn")?.focus())`
   — returns focus to the hamburger that opened it.

### Triggers that close the drawer
- Scrim click → `closeSidebar`.
- Selecting any nav item (`navItem.onclick` sets `state.sidebarOpen = false`).
- Selecting a channel (channel button onclick sets `state.sidebarOpen = false`).
- `Escape` key (global listener `:3488–3493`): if `sidebarOpen`,
  `preventDefault()` + `closeSidebar()`.

### Breakpoint change re-render (`:3497–3500`)
`matchMedia("(max-width:800px)")` `change` listener → `if (state.user) render()`
so `inert`/`aria-hidden` recompute when crossing 800px (e.g. rotate / resize).

### Notes / observations
- There is **NO full focus trap** — only "focus first nav item on open" and
  "restore focus to menu button on close". A keyboard user could tab past the
  drawer to the (inert? no) scrim/main. Scrim is focusable when open
  (`tabindex=0`). Main content on mobile is NOT `inert` when the drawer is open
  — **this is a gap** (focus can escape into the page behind the overlay).

### React migration notes
- `useSidebar()` context: `{ open, openSidebar, closeSidebar }`.
- A11y hidden: compute `hidden = !open && isMobile` via a `useMediaQuery("(max-width:800px)")`
  hook; pass `inert={hidden ? '' : undefined}` and `aria-hidden={hidden || undefined}`
  to `<aside>`. React 19 supports the `inert` prop natively (boolean).
- Open focus: `useEffect(() => { if (open) requestAnimationFrame(() => sidebarRef.current?.querySelector('.nav__item')?.focus()) }, [open])`.
- Close focus restore: store the opener element ref (menu button) and focus it on
  close (track previous `open`). Use a `usePrevious(open)` or a ref guard.
- Escape handler: `useEffect` adding a `keydown` listener while `open`.
- **Improvement opportunity (call out, don't silently change behavior):** consider
  marking `<main>` inert while the mobile drawer is open to add a real focus trap;
  current behavior does not do this, so preserving exact behavior = no trap.
- Keep the breakpoint-change re-render: `useMediaQuery` naturally re-renders.

---

## 4. Component: `Sidebar` (from `renderSidebar`, `legacy-app.js:439–487`)

**Purpose:** Brand head, workspace nav (4 items, permission-gated), channel list
+ create form, user footer.

### Nav spec (permission-gated)
```
navSpecs = [
  ["channel",   "频道",       "hash"],
  hasPermission("private_agent") ? ["private", "私人 Agent", "bot"] : null,
  ["knowledge", "知识库",     "library"],
  isAdmin() ? ["admin", "管理面板", "shield"] : null,
].filter(Boolean)
```
- "频道" and "知识库" always present.
- "私人 Agent" only if `hasPermission("private_agent")`.
- "管理面板" only if `isAdmin()`.

### DOM / markup tree
```
<aside class="sidebar" id="app-sidebar" inert?={hidden} aria-hidden?={hidden}>
  <div class="sidebar__head">{brand()}</div>
  <div class="sidebar__scroll">
    <div>
      <div class="section-label">工作区</div>
      <nav class="nav">{navItems}</nav>          // see §4.1 navItem
    </div>
    <div>
      <div class="section-label">
        <span>频道</span>
        <span class="nav__badge">{channels.length}</span>
      </div>
      <div class="channels">{channelButtons}</div> // see §4.2
      {hasPermission("manage_channels") ? channelCreateForm : null}  // §4.3
    </div>
  </div>
  {renderSidebarFoot()}                            // §5
</aside>
```

### 4.1 `navItem(view, label, iconName)` (`:489–502`)
```
<button class="nav__item {is-active if activeView===view}" onclick={...}>
  <Icon name={iconName}/>
  <span class="nav__label">{label}</span>
</button>
```
onclick (async):
1. `state.activeView = view`
2. `state.sidebarOpen = false`
3. if `view === "channel" || "private"` → `state._focusComposer = true`
4. dispatch loader:
   - `private` → `await withBusy(loadPrivateMessages)`
   - `knowledge` → `await withBusy(loadDocuments)`
   - `admin` → `await withBusy(loadAdminPanel)`
   - else (`channel`) → `render()` (no load; channel messages load via channel click / already loaded)

### 4.2 Channel list (`channelButtons`, `:449–461`)
If `state.channels.length`:
```
state.channels.map(channel =>
  <button class="channel {is-active if activeView==='channel' && activeChannelId===channel.id}"
          onclick={...}>
    <span class="channel__hash">#</span>
    <span class="channel__name">{channel.name}</span>
  </button>)
```
else (empty): `<div class="muted" style="padding:4px 10px;font-size:12.5px">暂无频道,创建一个开始协作。</div>`

Channel button onclick (async):
1. `state.activeView = "channel"`
2. `state.activeChannelId = channel.id`
3. `state._focusComposer = true`
4. `state.sidebarOpen = false`
5. `await withBusy(loadChannelMessages)` (see §6 — `GET /api/channels/{id}/messages`)

### 4.3 Channel-create form (`:471–482`, gated by `hasPermission("manage_channels")`)
```
<form class="channel-create" onsubmit={...}>
  <input placeholder="新频道名称" aria-label="新频道名称">
  <button class="icon-btn" type="submit" title="创建频道" aria-label="创建频道"
          style="border:1px solid var(--line-strong)"><Icon plus size=16/></button>
</form>
```
onsubmit (async):
1. `event.preventDefault()`
2. if `!channelName.value.trim()` → return (no-op on empty/whitespace)
3. `withBusy(async () => { await api("/api/channels", {method:"POST", body: JSON.stringify({name: channelName.value})}); channelName.value=""; await loadChannels(); })`

**API: `POST /api/channels`** — body `{ "name": <raw input value> }` (note: sends
the raw value, not the trimmed one; only the guard uses `.trim()`). Response not
read directly; `loadChannels()` re-fetches list afterward.

### State read
`channels`, `activeView`, `activeChannelId`, permission flags, `sidebarHiddenForA11y()`.

### Accessibility
- `<aside id="app-sidebar">` referenced by topbar menu button `aria-controls`.
- `inert` + `aria-hidden` when off-canvas (see §3).
- Channel-create input has `aria-label="新频道名称"`; submit button has title + aria-label.
- `.section-label` are plain `<div>`s (not `<h2>`), and `<nav class="nav">` has no
  `aria-label` — **gap**: the workspace nav and channels region are not labeled
  landmarks. Improvement: add `aria-label` to the nav(s) and consider headings.

### React migration notes
- `Sidebar` composed of `SidebarHead`, `WorkspaceNav` (maps a config array →
  `NavItem`), `ChannelList` (+ empty state), `ChannelCreateForm` (gated),
  `SidebarFoot`.
- Nav config: derive from permissions with `useMemo` (same filter logic).
- `NavItem` onclick → a `navigate(view)` action that sets `activeView`,
  closes sidebar, sets focus-composer intent, and triggers the appropriate
  data load (move loaders into React Query / effect per view, see §6). Keep the
  exact view→loader mapping.
- `ChannelCreateForm`: controlled input; on submit POST then invalidate/refetch
  channel list. Preserve the empty-trim guard and that the **raw** (untrimmed)
  value is sent in the payload.
- `is-active` classes derived from current `activeView`/`activeChannelId`.

---

## 5. Component: `SidebarFoot` (from `renderSidebarFoot`, `legacy-app.js:504–517`)

**Purpose:** Current-user identity chip + logout.

### DOM
```
<div class="sidebar__foot">
  <div class="user">
    <div class="avatar">{initials(name)}</div>
    <div class="user__meta">
      <span class="user__name">{name}</span>
      <span class="user__role">{role}</span>
    </div>
  </div>
  <button class="icon-btn" title="退出登录" aria-label="退出登录" onclick={logout}>
    <Icon logout/>
  </button>
</div>
```
- `name = user.display_name || user.username || "用户"`.
- `role = user.position || user.permission_group_label || (user.role || "member").toUpperCase()`.
  (precedence: position → group label → uppercased role → "MEMBER")

### Event: logout (`logout`, `:3443–3464`)
1. `await api("/api/auth/logout", {method:"POST"}).catch(()=>{})` (fire-and-forget; swallow errors).
2. `stopPolling()` (clears poll timer, closes SSE, clears typing timers).
3. For each pending message: `revokeAttachmentUrls(message)` (frees object URLs — chat spec).
4. Reset state: `user=null`, `sidebarOpen=false`, `pendingMessages=[]`, `draftFiles={}`,
   `mentionTargets=[]`, `typingUsers=[]`, full `messageAudit` reset.
5. `hideMentionMenu()`.
6. `render()` → drops to login.

**API: `POST /api/auth/logout`** — no body; errors ignored.

### React migration notes
- `SidebarFoot` reads `user` from auth context; logout calls `useAuth().logout()`.
- `logout()` in the provider performs the POST, stops polling/SSE (effects keyed
  on `user` will auto-tear-down on `user=null`), revokes attachment URLs, and
  resets all session-scoped state (lift these into their owning stores;
  `messageAudit`/chat resets belong to those specs but must still fire on logout —
  use a central "session reset" event or clear on `user` transition to null).

---

## 6. Data loaders triggered by navigation (cross-section, MUST preserve)

These are invoked by nav/channel clicks and on login boot. Document the API
contracts so the nav wiring is faithful.

| Loader | Trigger | API | State written |
|---|---|---|---|
| `loadInitial` (`:3148–3151`) | after login + on boot | `Promise.all([loadChannels(), loadMentionTargets()])` then `loadChannelMessages()` | channels, mentionTargets, messages |
| `loadChannels` (`:3152–3156`) | initial, channel-create, audit | **GET `/api/channels`** → `{channels}`. Sets `state.channels`. If no `activeChannelId` and channels exist → `activeChannelId = channels[0].id`. | channels, activeChannelId |
| `loadMentionTargets` (`:3157–3164`) | initial | **GET `/api/mention-targets`** → `{targets}` (try/catch → `[]`). | mentionTargets |
| `loadChannelMessages` (`:3165–3173`) | channel click, channel nav | **GET `/api/channels/{channelId}/messages`** → `{messages, agent_status, typing}`. Guards against channel switch race (`String(activeChannelId)!==channelId` → bail). | messages (via `mergePendingMessages`), agentStatuses.channels, typingUsers |
| `loadPrivateMessages` (`:3174–3182`) | private nav | `Promise.all([` **GET `/api/private-agent/messages`** `, loadPrivateTelegram()])` → `{messages, agent_status}`. | privateMessages, agentStatuses.private |
| `loadPrivateTelegram` (`:3183–3185`) | with private | **GET `/api/private-agent/telegram`** → stored whole in `state.privateTelegram`. | privateTelegram |
| `loadDocuments` (`:3186–3190`) | knowledge nav | **GET `/api/knowledge/documents`** → `{documents}`. Also resets `knowledgeSearch`. | documents, knowledgeSearch |
| `loadAdminPanel` (`:3262`) | admin nav | `Promise.all([loadUsers(), loadPermissionGroups(), loadSettings(), loadMessageAudit(), loadTokenUsage()])` (admin spec). | many admin fields |

> Migration: these become React Query queries keyed by view/channel, fetched
> when the relevant view mounts/activates. The nav action just switches the
> active view; the data fetch is the view's own effect/query. Preserve every
> path, the channel-switch race guard, and the `loadInitial` ordering (channels +
> mention-targets in parallel, THEN channel messages).

---

## 7. Polling + SSE lifecycle (cross-section, owned-by-shell)

### Polling (`startPolling`/`stopPolling`/`refreshActiveChat`, `:3263–3302`)
- `startPolling()`: if no `pollTimer`, `setInterval(() => refreshActiveChat(), 4000)`.
  Described as a low-frequency safety net behind SSE.
- `refreshActiveChat({renderAfter=true})`: bails if `!user || pollInFlight`.
  Captures composer focus, computes a `chatSnapshot` before/after, reloads the
  active scope's messages (`loadChannelMessages`/`loadPrivateMessages`), and
  re-renders only if the snapshot changed (preserving composer focus). Best-effort
  (swallows errors). `pollInFlight` guards re-entrancy.
- `stopPolling()`: clears `pollTimer`, `closeScopeStream()`, clears typing timers,
  `typingState.active=false`.
- Started after login (`renderLogin` submit) and on boot; stopped on logout / 401.

### SSE (`syncScopeStream`/`closeScopeStream`/`currentScopeStreamUrl`, `:3304–3363`)
- `currentScopeStreamUrl()`:
  - channel view + channelId → **`/api/channels/{activeChannelId}/events`**
  - private view → **`/api/private-agent/events`**
  - else `null`.
- `syncScopeStream()`: requires `user` + `EventSource` support. Computes url; if
  `null` closes stream. If same `scopeStreamKey` and stream open (readyState !== 2)
  → no-op. Else opens `new EventSource(url, {withCredentials:true})`.
  - `"update"` event → `refreshActiveChat()` (only if still the current stream).
  - `"error"` event with `readyState === 2` (CLOSED, terminal) → close, probe
    `GET /api/auth/me`; on success schedule a `setTimeout` reconnect after
    `SSE_RECONNECT_MS=3000` (if still logged in + tab visible); on failure rely on
    `api()` 401 handling to drop to login.
- Called in `afterRender` (every render) so the stream tracks the active scope.

### Visibility / pagehide (`setupGlobalListeners`, `:3502–3517`)
- `visibilitychange`: if hidden → clear `pollTimer` + `closeScopeStream()`; if
  visible → `refreshActiveChat()` + `startPolling()` + `syncScopeStream()`.
- `pagehide` → `closeScopeStream()`.

### React migration notes
- Move polling + SSE into hooks scoped to the active chat view:
  `useScopeStream(view, scopeId)` opens/closes an `EventSource` in `useEffect`
  (cleanup closes it; deps `[view, activeChannelId, user]`). On `"update"` →
  invalidate the active chat query. Keep the readyState-2 reconnect-with-auth-probe.
- `usePolling`: an interval effect (4s) gated on `user` + visibility, invalidating
  the active chat query; guard re-entrancy. Or rely on React Query
  `refetchInterval` + `refetchOnWindowFocus`.
- Visibility/pagehide handling becomes effect cleanup + a `useVisibility` hook.
- Keep `syncScopeStream` keyed on `activeView`/`activeChannelId` so switching
  channels reopens the right stream (replaces the per-render call in afterRender).

---

## 8. Component: `Topbar` (from `renderTopbar`, `legacy-app.js:519–536`)

**Purpose:** Mobile hamburger, contextual title/subtitle, right-aligned actions
(theme toggle + optional private-Telegram trigger).

### DOM / markup tree
```
<header class="topbar">
  <button class="icon-btn menu-btn" title="打开菜单" aria-label="打开菜单"
          aria-expanded={String(sidebarOpen)} aria-controls="app-sidebar"
          onclick={openSidebar}><Icon menu/></button>
  <div class="topbar__title-wrap">
    <div class="topbar__title">
      {info.hash ? <span class="hash">#</span> : <Icon name={info.icon} size=18 cls="muted"/>}
      <span>{info.title}</span>
    </div>
    {info.sub ? <div class="topbar__sub">{info.sub}</div> : null}
  </div>
  <div class="topbar__actions">{actions}</div>
</header>
```
- `actions = [ activeView==='private' ? renderPrivateTelegramAction() : null, themeToggle() ]`
  → private-Telegram trigger only on the private view; **theme toggle always last/right**.
- `.menu-btn` is `display:none` on desktop, `inline-grid` at `<=800px`.
- `aria-expanded` reflects `sidebarOpen`; `aria-controls="app-sidebar"` ties to the
  sidebar `<aside id="app-sidebar">`.
- menu button onclick = `openSidebar` (sets open + focuses first nav item, §3).

### 8.1 `topbarInfo()` (`:561–571`) → `{title, icon?, hash?, sub?}`
- `private`: `{title:"私人 Agent", icon:"bot", sub: agentStatusText(...) || "仅你可见的私有助手会话"}`.
- `knowledge`: `{title:"企业知识库", icon:"library", sub: \`${documents.length} 篇文档\`}`.
- `admin`: `{title:"管理面板", icon:"shield", sub: activeAdminPage().description}`.
- channel (default): `ch = activeChannel()`;
  `{title: ch?.name || "频道", hash:true, sub: ch ? (agentStatusText(...) || \`${messages.length} 条消息\`) : "选择或创建一个频道"}`.
  - When `hash:true`, title prefix is a `#` span (not an icon); otherwise an icon.

### 8.2 `renderPrivateTelegramAction()` (`:538–559`)
```
payload = state.privateTelegram || {}; gateway = payload.gateway||{}; link = payload.link||{}
expanded = !!state.privateTelegramExpanded; linked = !!link.telegram_user_id
title = gateway.enabled ? (linked ? "Telegram 私聊已绑定" : "配置 Telegram 私聊")
                        : "Telegram 私聊未启用"
<button class="icon-btn private-telegram-trigger {is-active if expanded} {is-linked if linked}"
        type="button" title={title} aria-label="Telegram 私聊设置"
        aria-expanded={expanded?"true":"false"} aria-controls="private-telegram-popover"
        onclick={() => { state.privateTelegramExpanded = !expanded; render(); }}>
  <Icon message/>
</button>
```
- Toggles `state.privateTelegramExpanded`. The popover itself
  (`renderPrivateTelegramConfig`, `:745`) is rendered by `renderContent` when
  `activeView==='private' && privateTelegramExpanded` — **private-agent spec**.
- `.is-linked::after` is a green dot (CSS) indicating a bound Telegram user.
- `aria-controls="private-telegram-popover"` references the popover (owned by the
  private-agent spec; ensure that element keeps `id="private-telegram-popover"`).

### State read
`sidebarOpen`, `activeView`, `privateTelegram`, `privateTelegramExpanded`,
`documents.length`, `messages.length`, `agentStatuses`, `activeChannel()`, `activeAdminPage()`.

### Accessibility
- Menu button: `aria-expanded`, `aria-controls`, aria-label, title. Good.
- Telegram trigger: `aria-expanded`, `aria-controls`, aria-label, dynamic title. Good.
- Title icon has `aria-hidden` (from `icon()`); title text is plain. The topbar is
  a `<header>` landmark. No `aria-live` on `topbar__sub` (agent status changes are
  not announced) — **gap**; could add `aria-live="polite"` to the sub line if
  surfacing agent status to SR is desired (behavior change — call out, don't auto-add).

### React migration notes
- `Topbar` composed of `MenuButton`, `TopbarTitle` (consumes a `useTopbarInfo()`
  selector deriving `{title, icon, hash, sub}` from view/state via `useMemo`),
  `TopbarActions` (renders `PrivateTelegramTrigger` only on private view, then
  `ThemeToggle`).
- `useTopbarInfo()` centralizes the per-view title/sub mapping; depends on
  `activeView`, channels, messages.length, documents.length, agentStatuses,
  activeAdminPage.
- `PrivateTelegramTrigger`: local/store boolean `privateTelegramExpanded` (shared
  with the popover component — lift to private-agent context). Keep classes
  `private-telegram-trigger is-active is-linked` and all aria attributes.
- `MenuButton.onClick` → `openSidebar` from sidebar context (focus management in §3).
- Keep `aria-expanded` string/boolean parity (React serializes booleans for
  `aria-expanded` correctly; ensure it renders `"true"/"false"`).

---

## 9. Component: `ContentRouter` (from `renderContent`, `legacy-app.js:573–585`)

**Purpose:** Switches the main content view and applies the per-view entrance
animation; also renders the private-Telegram popover overlay.

```
animate = state._lastView !== state.activeView; state._lastView = state.activeView
view = { private: renderChat("private"), knowledge: renderKnowledge(),
         admin: renderAdminPanel(), default: renderChat("channel") }[activeView]
<section class="content {view-enter if animate}">
  {view}
  {activeView==='private' && privateTelegramExpanded ? renderPrivateTelegramConfig() : null}
</section>
```
- `.view-enter` animation (CSS `:503–504`) applied ONLY when the active view
  changed since last render (slide+fade in). Disabled under
  `prefers-reduced-motion` (media query at `styles.css:2071`).

### React migration notes
- `ContentRouter` renders one of `<ChannelChat/>`, `<PrivateChat/>`, `<Knowledge/>`,
  `<AdminPanel/>` based on `activeView` (those are other specs).
- View-change animation: track previous view with a ref; add `view-enter` class
  only when changed (or use a keyed remount + CSS animation, or
  `framer-motion`/CSS keyed on `activeView`). Keep `prefers-reduced-motion` opt-out.
- The private-Telegram popover (`renderPrivateTelegramConfig`) is conditionally
  rendered as a sibling of the active view inside `.content`; keep that placement
  and the `id="private-telegram-popover"` for the topbar `aria-controls`.

---

## 10. Session lifecycle & boot (cross-section)

### `boot()` (`:3520–3533`) / `startEnterpriseApp()` (`:3535–3541`)
- `startEnterpriseApp()` is the exported entry (called from `main.tsx`); guards
  against double-boot (`bootStarted`).
- `boot()`: `setupGlobalListeners()`, then **GET `/api/auth/me`** → `state.user`,
  `_focusComposer=true`, `loadInitial()`, `startPolling()`. On failure: `user=null`,
  `stopPolling()`. Then `render()`.

**API: `GET /api/auth/me`** → `{ user }`. (Session restore on page load.)

### `handleSessionExpired()` (`:3431–3441`)
Triggered by `api()` on any 401 while `state.user` is truthy:
- if `!user` → no-op.
- else `stopPolling()`, `user=null`, `sidebarOpen=false`, `hideMentionMenu()`,
  `toast("会话已过期,请重新登录", {type:"error", title:"需要登录"})`, `render()`.

### `withBusy(fn)` (`:3466–3480`)
- `busy=true`, `error=""`, `render()`; `await fn()`; catch → `error = message`, and
  if `state.user` truthy → `toast(message, {type:"error", title:"操作失败"})`;
  finally `busy=false`, `render()`.
- **Key nuance:** on the login screen (`user` null) errors are NOT toasted (only
  inline `.error`); once logged in, op errors ARE toasted. Preserve this.

### React migration notes
- `AuthProvider` with `useEffect` on mount: call `GET /api/auth/me`; set user;
  kick off initial load + polling/SSE (via the data hooks). Provide
  `{ user, login, logout, busy, error }`.
- `handleSessionExpired`: the shared `apiClient` needs a way to signal 401 to the
  auth provider (e.g. an event emitter or a registered callback) so it can clear
  `user`, close streams, and toast. Keep the "only if currently logged in" guard.
- `withBusy` → an async-action helper/hook (`useAsyncAction`) that sets local
  `busy`/`error`, and conditionally toasts only when authenticated.
- `startEnterpriseApp`/`bootStarted` double-boot guard disappears (React mounts
  once). `setupGlobalListeners` global listeners become effects in the providers.
- Keep both legacy mount points discipline: `index.html` currently has
  `#react-root` (new) and `#app` (legacy) + `#toast-stack`. The migration mounts
  React at `#react-root`; the anti-FOUC theme `<script>` and `#toast-stack`
  `aria-live` region stay.

---

## 11. CSS class inventory for this section (selectors to keep / map to CSS Modules)

Auth: `.auth`, `.auth__aside`, `.auth__logo`, `.auth__main`, `.auth__card`,
`.field`, `.field > span`, `.error`, `.error:not(:empty)`.

Shell: `.shell`, `.shell.is-open`, `.sidebar`, `.sidebar__head`, `.brand`,
`.brand__logo`, `.brand__eyebrow`, `.sidebar__scroll`, `.section-label`, `.nav`,
`.nav__item`, `.nav__item.is-active`, `.nav__label`, `.nav__badge`, `.channels`,
`.channel`, `.channel.is-active`, `.channel__hash`, `.channel__name`,
`.channel-create`, `.sidebar__foot`, `.user`, `.avatar`, `.user__meta`,
`.user__name`, `.user__role`, `.scrim`.

Main/topbar: `.main`, `.topbar`, `.topbar__title-wrap`, `.topbar__title`,
`.topbar__title .hash`, `.topbar__sub`, `.topbar__actions`, `.menu-btn`,
`.private-telegram-trigger`, `.private-telegram-trigger.is-active`,
`.private-telegram-trigger.is-linked::after`, `.content`, `.view-enter`.

Buttons/icons: `.btn`, `.btn--primary`, `.btn--lg`, `.btn--block`, `.icon-btn`,
`.spin` (loader). Tokens: `--sidebar-w: 264px`.

Breakpoints: `<=940px`, `<=800px` (drawer/auth collapse — primary), `<=520px`,
`<=360px`, `prefers-reduced-motion` (disables `view-enter`).

---

## 12. Endpoint quick-reference (verbatim — preserve method + path + payload)

| Method | Path | Body | Response (used fields) | Triggered by |
|---|---|---|---|---|
| POST | `/api/auth/login` | `{username, password}` | `{user}` | Login form submit |
| POST | `/api/auth/logout` | — | (ignored) | Sidebar foot logout |
| GET | `/api/auth/me` | — | `{user}` | boot, SSE reconnect auth probe |
| GET | `/api/channels` | — | `{channels:[{id,name}]}` | loadChannels / loadInitial / channel-create |
| POST | `/api/channels` | `{name}` (raw input value) | (re-fetch) | Sidebar channel-create form |
| GET | `/api/mention-targets` | — | `{targets}` | loadInitial (try/catch → []) |
| GET | `/api/channels/{channelId}/messages` | — | `{messages, agent_status, typing}` | channel click / channel nav |
| GET | `/api/private-agent/messages` | — | `{messages, agent_status}` | private nav |
| GET | `/api/private-agent/telegram` | — | `{gateway, link, ...}` (stored whole) | private nav (with messages) |
| GET | `/api/knowledge/documents` | — | `{documents}` | knowledge nav |
| GET | `/api/channels/{id}/events` | — | SSE `update` events | active channel scope stream |
| GET | `/api/private-agent/events` | — | SSE `update` events | active private scope stream |

(Admin loaders under `/api/admin/*`, `/api/system/*`, `/api/users`,
`/api/permission-groups`, `/api/settings/*` are owned by the Admin spec; the
nav only triggers `loadAdminPanel()`.)

---

## 13. Migration risk summary (shell/nav specific)

1. **Focus management on full-teardown removal.** Open-sidebar focuses first
   `.nav__item`; close restores `.menu-btn` focus; login submit + nav switch set
   `_focusComposer`. Without `replaceChildren` these RAF-based focus moves must
   become deterministic `useEffect`s keyed on the right state transitions, or
   focus will jump/lost. The biggest reconciliation hazard.
2. **`inert`/`aria-hidden` toggling on the drawer** across the 800px breakpoint —
   must recompute on resize (matchMedia) exactly as the legacy `change` listener does.
3. **No focus trap today** — replicate (no trap) for behavior parity, but flag
   that `<main>` is not inert under the mobile overlay (a11y gap to optionally fix).
4. **Permission view-fallback guard** in `renderShell` runs on every render and can
   silently rewrite `activeView`; must be reproduced so a demoted/limited user is
   never stuck on a forbidden view.
5. **SSE + poll lifecycle** moving from per-render `syncScopeStream`/`afterRender`
   to effects: risk of duplicate EventSource connections or leaks if deps/cleanup
   are wrong; preserve the readyState-2 reconnect + auth-probe and the
   visibility/pagehide pause-resume.
6. **`withBusy` toast-vs-inline error duality** (no toast pre-login, toast
   post-login) — easy to regress; keep the `state.user` guard.
7. **Channel-create payload sends the raw (untrimmed) `name`** while only the
   empty-guard trims — preserve exact payload to avoid backend behavior drift.
8. **Theme anti-FOUC inline script** in `index.html` must remain and run before
   React; theme state must read/write the same `data-theme` attr + `eap-theme` key.
9. **Race guard in `loadChannelMessages`** (bail if active channel changed mid-fetch)
   — replicate via React Query keys or an abort/stale check to avoid showing a
   previous channel's messages.
10. **Logout / 401 must tear down everything** (poll, SSE, typing timers, pending
    attachment object URLs, audit + chat state). Centralize a session-reset on
    `user → null` so no stream/timer/objectURL leaks across sessions.
