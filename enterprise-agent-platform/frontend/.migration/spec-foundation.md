# Migration Spec — Section: Foundation, render plumbing & app lifecycle

Source: `frontend/src/legacy-app.js` (lines 1-365 + 3148-3541, plus referenced helpers).
Mount host: `frontend/index.html` + `frontend/src/main.tsx`.
Stylesheet: `frontend/src/styles.css`.

This section is the **plumbing layer** that every other section depends on:
the global `state` object (the future React store), the `api()` fetch wrapper,
the `h()`/`icon()` DOM builders, the theme system, the toast system, the
full-teardown `render()` lifecycle with all its post-render hooks, the shared UI
atoms (`brand`, `field`, `cardHead`, `statusBadge`, `emptyState`), permission
gates (`isAdmin`/`hasPermission`), the polling + SSE real-time engine, and the
boot/logout/session lifecycle.

---

## 0. Mount architecture (critical, easy to get wrong)

`index.html` defines THREE top-level DOM nodes:

```html
<div id="react-root"></div>   <!-- React mounts here -->
<div id="app"></div>          <!-- legacy vanilla app renders here -->
<div id="toast-stack" class="toast-stack" aria-live="polite" aria-atomic="false"></div>
```

- `main.tsx` calls `createRoot(document.getElementById("react-root")).render(<EnterpriseAppRuntime/>)`.
- `EnterpriseAppRuntime` is a render-null component whose only job is to call
  `startEnterpriseApp()` once in a `useEffect` (guarded by a `useRef` so React 19
  StrictMode double-invoke does not double-boot).
- The legacy app then takes over `#app` entirely via `app.replaceChildren(...)`.
- Toasts are imperatively appended to the standalone `#toast-stack` element
  (NOT inside `#app`), so they survive the full teardown of `#app`.

**Pre-paint theme bootstrap** lives in an inline `<head>` script in `index.html`:
reads `localStorage["eap-theme"]` and, if `"light"`/`"dark"`, sets
`document.documentElement.dataset.theme` before first paint to avoid a flash.

### Migration implication
In React the entire app should mount in ONE root. Recommended: keep a single
React root (rename/repurpose `#react-root`), drop the separate `#app` div, and
either (a) render `<ToastStack/>` via a React portal into `#toast-stack`, or (b)
keep `#toast-stack` as a portal target (preferred — preserves `aria-live`
region identity across re-renders). Keep the inline pre-paint theme script in
`index.html` verbatim (React cannot run before first paint).

---

## 1. THE GLOBAL `state` OBJECT — full field-by-field spec (THE STORE)

Declared at lines 8-59. This is a single mutable module-level object; every
mutation is followed by an explicit `render()` call. In React this becomes the
canonical global store (recommend a `useReducer`/Zustand/Context store). Types
below are inferred from usage across the whole file; field owner = the section
that primarily reads/writes it.

| Field | Initial | Type | Meaning / who writes it |
|---|---|---|---|
| `user` | `null` | `User \| null` | Current authenticated user. `null` = show login. Shape: `{ id, username, role, permission_group, permissions: string[], ... }` (see §6). Set by `/api/auth/me`, `/api/auth/login`; cleared by `logout()`/`handleSessionExpired()`. **This is the master auth gate.** |
| `channels` | `[]` | `Channel[]` | All channels visible to user. Set by `loadChannels()` (`/api/channels`). Each: `{ id, name, ... }`. |
| `activeView` | `"channel"` | `"channel"\|"private"\|"knowledge"\|"admin"` | Which top-level view is shown. Coerced back to `"channel"` in `renderShell()` if user lacks permission (see §6). |
| `activeChannelId` | `null` | `string\|number\|null` | Selected channel. Auto-set to first channel in `loadChannels()` if unset. Compared with `String()` coercion throughout. |
| `messages` | `[]` | `Message[]` | Messages for the active channel (server + merged pending). Set by `loadChannelMessages()`. |
| `privateMessages` | `[]` | `Message[]` | Messages for the user's private agent (server + merged pending). Set by `loadPrivateMessages()`. |
| `pendingMessages` | `[]` | `Message[]` | Optimistic, not-yet-acked messages. Each tagged with `scope_type` (`"channel"`/`"private"`) + `scope_id`. Merged into `messages`/`privateMessages` by `mergePendingMessages()`. Cleared on logout (after revoking blob URLs). |
| `drafts` | `{}` | `Record<draftKey,string>` | Per-conversation composer text. Key = `composerDraftKey(mode,scopeId)` = `` `${scopeType}:${scopeId}` ``. |
| `draftFiles` | `{}` | `Record<draftKey, File[]>` | Per-conversation pending attachments (raw `File` objects). Same key scheme. Reset to `{}` on logout. |
| `agentStatuses` | `{ channels:{}, private:null }` | `{channels: Record<channelId, AgentStatus>, private: AgentStatus\|null}` | Per-scope agent run status. Written by `setAgentStatus(mode,scopeId,status)`. |
| `expandedAgentRuns` | `{}` | `Record<runId, boolean>` | UI toggle: whether an agent-run activity log is expanded. `hasOwnProperty` check distinguishes "never toggled" (defaults to active state) from explicit collapse. |
| `mentionTargets` | `[]` | `MentionTarget[]` | `@`-mention autocomplete candidates. Set by `loadMentionTargets()` (`/api/mention-targets`). |
| `typingUsers` | `[]` | `{user_id, username}[]` | Who is typing in the active **channel** (channel-only; always `[]` for private). Set by `loadChannelMessages()`. Cleared on logout. |
| `documents` | `[]` | `Document[]` | Knowledge-base docs. Set by `loadDocuments()` (`/api/knowledge/documents`). |
| `knowledgeSearch` | `{query:"",results:null}` | `{query:string, results: Result[]\|null}` | KB search box state. `results:null` = not searched yet. Reset on `loadDocuments()`. |
| `selectedDocument` | `null` | `Document\|null` | Doc open in the side viewer. `{ title, content, ... }`. |
| `users` | `[]` | `User[]` | Admin: all accounts. `loadUsers()` (`/api/users`). |
| `permissionGroups` | `[]` | `PermissionGroup[]` | Admin: permission groups. `loadPermissionGroups()` (`/api/permission-groups`). Fallback constant `FALLBACK_PERMISSION_GROUPS` exists. |
| `activeAdminPage` | `"accounts"` | one of `ADMIN_PAGES[].id` | Which admin sub-page is shown. Valid ids: `accounts, tokens, messages, model, telegram, updates, security, runtime, hermes, cognee, secrets`. |
| `messageAudit` | object (see below) | `MessageAudit` | Admin message-audit sub-state. Re-initialized identically on logout and lazily by `messageAuditState()`. |
| `tokenUsage` | `null` | `TokenUsage\|null` | Admin token-usage report. `loadTokenUsage()` (`/api/admin/token-usage`). Has `.window.days`. |
| `tokenUsageDays` | `30` | `number` | Token usage window (days). Echoed back from server response `.window.days`. |
| `secrets` | `[]` | `Secret[]` | Admin platform secrets. `loadSecrets()` (`/api/settings/secrets`). |
| `runtimes` | `null` | `Runtime\|null` | Admin runtime health. `loadRuntime()` (`/api/system/runtime`). |
| `hermesConfig` | `null` | `object\|null` | `/api/system/hermes/config`. |
| `telegramConfig` | `null` | `object\|null` | `/api/system/telegram/config`. |
| `autoUpdateConfig` | `null` | `object\|null` | `/api/system/auto-update/config`. |
| `privateTelegram` | `null` | `object\|null` | The current user's private-agent Telegram binding. `loadPrivateTelegram()` (`/api/private-agent/telegram`). |
| `privateTelegramExpanded` | `false` | `boolean` | UI toggle for the private Telegram config panel (shown in private view). |
| `hermesInternalConfig` | `null` | `object\|null` | `/api/system/hermes/internal-config`. |
| `cogneeConfig` | `null` | `object\|null` | `/api/system/cognee/config`. |
| `securityConfig` | `null` | `object\|null` | `/api/system/security/config`. |
| `oauthProviders` | `null` | `{providers:[], active_provider}\|null` | `/api/system/oauth/providers`. Updated by `updateOAuthState()`. |
| `oauthFlows` | `{}` | `Record<providerId, Flow>` | In-progress OAuth verification flows (per provider). |
| `oauthCallbackUrls` | `{}` | `Record<providerId, string>` | User-entered OAuth callback URL per provider. Cleared to `""` when flow completes. |
| `busy` | `false` | `boolean` | Global "operation in flight" flag set by `withBusy()`. Disables buttons + shows spinners. |
| `sending` | `false` | `boolean` | **DEAD FIELD** — declared but never read or written anywhere in the file. Do not port (or keep only if message-send section re-introduces it). |
| `sidebarOpen` | `false` | `boolean` | Mobile drawer open state. |
| `error` | `""` | `string` | Last operation error message (shown on login screen `.error`; set by `withBusy()`). |
| `_lastView` | `null` | `string\|null` | Tracks previous `activeView` to drive a content cross-fade animation (line 574-575: `animate = _lastView !== activeView`). Render-internal. |
| `_focusComposer` | `false` | `boolean` | One-shot flag: after next render, focus the composer textarea. Consumed + reset in `afterRender()`. Set in many places (nav switch, send, deferred flush, poll-with-focus, boot). |
| `_scrollChatToBottom` | `false` | `boolean` | One-shot flag: after next render, force-scroll messages to bottom regardless of prior position. Consumed + reset in `afterRender()`. |

### `state.messageAudit` shape (initial AND logout-reset are identical):
```js
{
  auditChannelId: null,        // string|null  selected channel for audit
  channelMessages: [],         // Message[]
  channelTotal: 0,             // number
  privateConversations: [],    // {user_id, message_count, ...}[]
  auditPrivateUserId: null,    // string|null  selected user for private audit
  privateMessages: [],         // Message[]
  privateTotal: 0,             // number
}
```

### Module-level mutable singletons (NOT in `state`, but part of the store concern)
Declared at lines 61-70 and 3304-3307. These are imperative globals the React
version must relocate (into refs/context/store):

| Name | Init | Purpose |
|---|---|---|
| `app` | `getElementById("app")` | Render target. (Goes away in React.) |
| `toastStack` | `getElementById("toast-stack")` | Toast container. Keep as portal target. |
| `pollTimer` | `null` | `setInterval` handle for the 4s safety-net poll. |
| `pollInFlight` | `false` | Guard so overlapping polls don't stack. |
| `localMessageSeq` | `0` | Monotonic counter for optimistic message/attachment temp ids. |
| `MAX_ATTACHMENTS_PER_MESSAGE` | `10` | Hard cap. |
| `MAX_ATTACHMENT_BYTES` | `50*1024*1024` (50 MB) | Per-file cap. |
| `typingState` | `{key,active,lastSent,stopTimer}` | Typing-indicator throttle state. |
| `composerState` | `{composing:false, renderDeferred:false}` | IME-composition + deferred-render flag (see §4). |
| `mentionState` | `{active,selected,options,range,menu,input}` | `@`-mention menu state. |
| `scopeStream` | `null` | Active `EventSource`. |
| `scopeStreamKey` | `null` | URL of the active stream (dedupe key). |
| `scopeStreamReconnect` | `null` | `setTimeout` handle for SSE reconnect. |
| `SSE_RECONNECT_MS` | `3000` | Reconnect delay. |
| `globalListenersReady` | `false` | One-shot guard for `setupGlobalListeners()`. |
| `bootStarted` | `false` | One-shot guard for `startEnterpriseApp()`. |

---

## 2. `api(path, options)` — the fetch contract (lines 73-94)

THE single network primitive. Must be preserved byte-for-byte in semantics.

```
async function api(path, options = {})
```

Behavior:
1. `isForm = options.body instanceof FormData`.
2. `fetch(path, { credentials: "include", headers, ...options })`.
   - **Always cookie-credentialed** (`credentials: "include"`). No bearer tokens.
   - Headers: if `isForm`, pass through `options.headers || {}` (let browser set
     the multipart boundary — do NOT set Content-Type). Otherwise
     `{ "Content-Type": "application/json", ...(options.headers||{}) }`.
   - `path` is used as-is (relative `/api/...`); Vite dev server proxies `/api`.
3. Read body as text first (`await res.text()`), then `JSON.parse` inside a
   try/catch. **On parse failure → `data = {}`** (a fronting proxy may emit an
   HTML 502/504 or login-redirect page; must not throw on that).
4. `if (res.status === 401 && !options.skipAuthHandling) handleSessionExpired();`
   — opt-out flag `skipAuthHandling` lets specific callers (e.g. the SSE auth
   probe) suppress the auto-logout.
5. `if (!res.ok) throw new Error(data.error || data.detail || `请求失败（${res.status}）`)`.
   — error precedence: server `error` field → server `detail` field → generic
   Chinese "request failed (status)".
6. Returns parsed `data` (the JSON object) on success.

Notable call conventions used elsewhere in this section:
- POST with empty JSON body uses `body: "{}"` (a string) — e.g. OAuth start.
- POST with payload uses `body: JSON.stringify({...})`.
- GET is the default (no `method`).

### Migration notes
Port `api()` verbatim as a standalone module function (framework-agnostic). Keep
the text-then-parse, the `{}` fallback, the `skipAuthHandling` opt-out, and the
exact error-message precedence + the Chinese fallback string. The 401 handler
must call into the store's session-expiry action. Do NOT switch to `res.json()`
(it would throw on HTML proxy pages). Consider returning a typed result but keep
runtime shape identical.

---

## 3. `safeUrl(value, {allowData})` — URL sanitizer (lines 100-114)

XSS guard for any backend-supplied URL placed into `href`/`src`.

- Strips control chars `[ -]` (defeats `java\tscript:`), trims.
- Empty → `""`.
- Starts with `/ . # ?` → returned as-is (relative).
- No scheme → returned as-is.
- Has scheme → allowed only if in allow-list:
  - href default: `["http","https","mailto","tel","blob"]`
  - `allowData:true` (for `src`): `["http","https","blob","data"]`
- Disallowed scheme → `""` (attribute omitted).

`h()` applies it automatically: `href` → `safeUrl(v)`; `src`/`xlink:href` →
`safeUrl(v,{allowData:true})`. **In React, replicate this in any component that
renders backend-controlled URLs** (helper `safeUrl` reused; don't rely on JSX to
sanitize — `javascript:` in href is not auto-blocked by React).

---

## 4. `h()` hyperscript, `icon()`, `svgNode()` (lines 117-227)

### `h(tag, attrs, children)` — HTML element builder
- `class` → `node.className`.
- `text` → `node.textContent`.
- `on*` + function → `addEventListener(name.slice(2).toLowerCase(), fn)` (e.g.
  `onclick` → `click`, `onkeydown` → `keydown`).
- `href` → sanitized via `safeUrl`, set only if non-empty.
- `src` / `xlink:href` → sanitized via `safeUrl(...,{allowData:true})`.
- other attrs: skipped if `false`/`null`; `true` → empty-string attribute
  (boolean attr); else `String(value)`.
- children: array-flattened one level; `null`/`false` skipped; non-Node coerced
  via `document.createTextNode(String(child))`.

### `icon(name, {size, cls, strokeWidth})` — SVG icon factory
- Creates `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width=strokeWidth||1.7 stroke-linecap=round stroke-linejoin=round
  aria-hidden="true">`.
- Optional `width`/`height` = `size`; optional `class` = `cls`.
- Children from `ICONS[name]` (array of `[tag, attrs]`). Unknown name → empty svg.

### `ICONS` map (lines 135-166) — 30 icons
Keys: `hash, bot, library, settings, send, search, sun, moon, logout, plus,
checkCircle, alert, refresh, download, upload, paperclip, close, menu, external,
loader, key, server, shield, doc, image, message, barChart, trash, link, users`.
Each value is an array of `[svgTag, attrsObject]` primitives (line/path/circle/rect).

### `svgNode(tag, attrs, children)` — generic SVG builder (used by chart code).

### Migration notes
- Replace `h()` with JSX. The `on*`-lowercasing and boolean-attr handling map
  naturally to JSX, EXCEPT: keep `safeUrl` wrapping on href/src.
- Convert `ICONS` to a typed icon component set: `<Icon name="hash" size={18}
  className="spin" strokeWidth={1.7}/>`. Preserve `aria-hidden="true"`, the
  `currentColor` stroke, the exact path `d`/coords (they're hand-tuned), and the
  default stroke-width `1.7`. Keep `viewBox="0 0 24 24"`. A single
  `<Icon>` component reading a record keyed by name is the cleanest port.
- Also port the data constants `FALLBACK_PERMISSION_GROUPS`,
  `THINKING_DEPTH_OPTIONS`, `ADMIN_PAGES` (shared by other sections) — move to a
  shared `constants.ts`.

---

## 5. Theme system (lines 230-244) + design tokens

- `currentTheme()`: returns `documentElement.dataset.theme` if it's
  `"light"`/`"dark"`, else falls back to `matchMedia("(prefers-color-scheme:
  dark)")`. So an UNSET attribute means "follow OS".
- `toggleTheme()`: flips, writes `documentElement.dataset.theme`, persists to
  `localStorage["eap-theme"]` (try/catch), then `render()`.
- `themeToggle()`: an `.icon-btn` button, `title` + `aria-label="切换主题"`,
  icon = `sun` when dark / `moon` when light, `onclick: toggleTheme`.

CSS: `:root` (styles.css:9-89) defines all design tokens using CSS
`light-dark()` so values respond to `color-scheme`. `:root[data-theme="light"]`
and `:root[data-theme="dark"]` (91-92) pin `color-scheme`. Tokens include brand
palette (`--brand/--accent...`), surfaces, lines, text (`--ink/--muted/--faint`),
status (`--ok/--warn/--danger` + soft/line variants), elevation shadows
(`--shadow-1..3`), `--ring`, radii (`--r-xs..--r-pill`), fonts
(`--font-display` serif for Latin, `--font-sans`, `--font-mono`), transitions
(`--t-fast`,`--t`), and `--sidebar-w:264px`. `.spin{animation:spin .7s linear
infinite}` + `@keyframes spin` (styles.css:256-257) power the loader icon.

### Migration notes
Use a `ThemeContext`/hook exposing `theme: "light"|"dark"` (resolved) and
`toggleTheme()`. Keep writing `document.documentElement.dataset.theme` (CSS is
attribute-driven) and `localStorage["eap-theme"]`. Keep the inline pre-paint
script. Subscribe to the OS `matchMedia` change when no explicit attribute is set
(currently the legacy code only re-renders on the mobile breakpoint query, not on
OS theme change — minor; React effect can improve this without behavior loss).
Do NOT migrate the color tokens to JS — they stay in `styles.css`.

---

## 6. Permission gates (lines 349-357)

- `userPermissions()` → `new Set(state.user?.permissions || [])`.
- `isAdmin()` → `user.role === "admin"` **OR** `user.permission_group ===
  "admin"` **OR** permissions set has `"system_settings"`.
- `hasPermission(p)` → `isAdmin() || userPermissions().has(p)`. (Admins implicitly
  hold every permission.)

Known permission strings (from `FALLBACK_PERMISSION_GROUPS`): `read_workspace,
chat, private_agent, manage_channels, manage_knowledge, manage_users,
system_settings`.

Gating enforced in `renderShell()` (lines 408-409):
- non-admin on `activeView==="admin"` → forced to `"channel"`.
- no `private_agent` perm on `activeView==="private"` → forced to `"channel"`.

### Migration notes
Provide `usePermissions()` returning `{isAdmin, has(p)}` derived from
`state.user` (useMemo on `user`). The view-coercion guard should live in a route
guard / effect (or directly in the shell's view selection) so an unauthorized
`activeView` can never render. Keep the exact 3-way `isAdmin` logic.

---

## 7. Toast system (lines 247-265) + `#toast-stack`

`toast(message, {type="error", title})`:
- No-op if `toastStack` missing.
- Builds `.toast.toast--{type}` with `role="status"`, an `.toast__icon`
  (`checkCircle` for `type==="ok"`, else `alert`, size 18), `.toast__body`
  (optional `.toast__title`, `.toast__msg`), and an `.icon-btn.toast__close`
  (title 关闭, close icon size 16).
- Appends to `#toast-stack` (the aria-live region).
- Auto-dismiss timer: `3200ms` for `ok`, `6500ms` otherwise.
- `dismiss()`: clears timer, adds `.is-leaving`, removes node on `animationend`
  (one-shot listener). Manual close button calls the same `dismiss`.
- `type` values used across app: `"error"` (default) and `"ok"`.

CSS: `.toast-stack` fixed bottom-right, `pointer-events:none` (children
re-enable). Enter/leave keyframes `toast-in`/`toast-out`. Color border-left by
type.

### Migration notes
Implement an imperative toast API (`toast.error()`, `toast.ok()`) backed by a
React `<ToastStack>` portaled into `#toast-stack`, OR keep the existing element
and a small imperative store (array of `{id,type,title,message}`) with timers in
an effect. Preserve: exact durations (3200/6500), `role="status"`,
`aria-live="polite" aria-atomic="false"` on the container, leave animation
before unmount (use the CSS class + `onAnimationEnd`), and that toasts are
OUTSIDE the main app subtree so they persist across view changes. The imperative
`toast(...)` is called from non-component code (api errors, withBusy, lifecycle)
— expose it as a module-level singleton, not only via hook.

---

## 8. Render lifecycle (lines 268-322) — THE part React replaces wholesale

The legacy model: **every** state mutation calls `render()`, which does a FULL
teardown (`app.replaceChildren(...)`) and rebuilds the whole tree, then runs
post-render hooks on the next animation frame. React's reconciliation replaces
this entirely, but each hook compensates for a real UX concern that must be
reproduced with refs/effects.

### `render()` (268-276)
```
if (shouldDeferComposerRender()) { composerState.renderDeferred = true; return; }
const messageScroll = captureMessageScroll();
app.replaceChildren(state.user ? renderShell() : renderLogin());
requestAnimationFrame(() => afterRender(messageScroll));
```
- **Composer-defer guard**: if the user is actively IME-composing in the
  composer textarea, SKIP the re-render entirely and set a "deferred" flag (so a
  background poll/SSE update cannot nuke the textarea mid-composition). The
  pending render is flushed later by `flushDeferredRender()`.
- **Top-level branch**: `state.user ? shell : login`. This is THE auth switch.
- Captures scroll BEFORE teardown, restores AFTER, on next frame.

### `shouldDeferComposerRender()` (277-279)
`composerState.composing && document.activeElement matches ".composer textarea"`.
True only while an IME composition session is in progress in the focused composer.

### `flushDeferredRender()` (280-285)
If a render was deferred, clear the flag, set `state._focusComposer = true`
(refocus composer after the flushed render), and `render()`. Called when
composition ends (`compositionend`).

### `afterRender(messageScroll)` (286-298) — runs in `requestAnimationFrame`
1. `restoreMessageScroll(.messages, messageScroll)` if a `.messages` el exists.
2. `state._scrollChatToBottom = false` (consume the one-shot).
3. If `.composer textarea` exists → `autoGrow(ta, {animate:false})` (size to
   content without animation).
4. If `state._focusComposer` → focus the textarea + `autoGrow(ta)` (animated),
   then reset `_focusComposer=false`.
5. `syncActiveAdminPager()`.
6. `syncScopeStream()` (re-evaluate the SSE connection for the current view).

### `syncActiveAdminPager()` (299-304)
Only when `activeView==="admin"` AND viewport `<=800px`: scroll the
`.admin-pager__item.is-active` into view (`block:nearest, inline:center`). Keeps
the active mobile admin tab visible after a re-render.

### `captureMessageScroll()` (305-313)
Reads `.messages` element: returns `{ key: dataset.chatKey, top: scrollTop,
bottom: scrollHeight - scrollTop - clientHeight }` (or `null`). `data-chat-key`
is set on the `.messages` element (line 716) as `` `${scopeType}:${scopeId}` ``.

### `restoreMessageScroll(msgs, previous)` (314-322)
- `sameChat = previous && previous.key === current chatKey`.
- If `state._scrollChatToBottom` OR not same chat OR `previous.bottom < 32` (was
  within 32px of bottom) → snap to bottom (`scrollTop = scrollHeight`).
- Else restore `min(previous.top, maxTop)` (preserve reading position).

So the scroll heuristic: **stick to bottom if the user was already near bottom or
switched conversations; otherwise preserve exact scroll offset across re-renders.**

### Migration notes (high priority)
React must reproduce these behaviors WITHOUT full teardown:
- **Composer defer**: With React, an uncontrolled textarea (or a controlled one
  whose value is local state) won't be destroyed by sibling re-renders, so the
  IME problem largely disappears. BUT keep `compositionstart`/`compositionend`
  handlers and DON'T commit external (poll/SSE) message updates that reorder the
  list while composing if it would steal focus — safest is to keep the composer
  as isolated local state and only sync drafts to the store on change/blur.
- **Scroll restore**: implement in the messages component with a `useRef` to the
  scroll container + a `useLayoutEffect` keyed on messages identity. Reproduce
  the exact heuristic: capture `{top,bottom,chatKey}` before commit (in a
  `useLayoutEffect` cleanup or a ref snapshot), and after commit snap-to-bottom
  when `_scrollChatToBottom` or chat changed or was within 32px of bottom; else
  restore `min(prevTop,maxTop)`. The `chatKey` = `${scopeType}:${scopeId}`.
- **`_scrollChatToBottom` / `_focusComposer`**: model as transient "effects"
  rather than persistent state — e.g. an event the messages/composer components
  consume once (a ref flag, or a small action queue). After consuming, reset.
- **autoGrow**: port as a hook on the textarea (`useAutoGrow(ref)`) running on
  input + on mount; preserve the 200px max, the `is-scrollable` toggle, and the
  height-animation trick (set prev height, force reflow `void offsetHeight`, set
  next height) when animating.
- **admin pager scroll-into-view**: a `useEffect` in the admin pager keyed on
  `activeAdminPage` + breakpoint.
- **syncScopeStream**: move into a `useEffect` keyed on
  `[user, activeView, activeChannelId, document visibility]` (see §10).

---

## 9. Shared UI atoms (lines 325-364)

These are tiny pure builders — straight ports to presentational React components.

| Fn | Output (markup) | Notes |
|---|---|---|
| `brand()` | `.brand` > `img.brand__logo[src=/ubitech-logo.png alt=ubitech]` + `span.brand__eyebrow "agent"` | Static. |
| `field(label, control)` | `label.field` > `span{label}` + control | Wrap a labeled control. In React: `<Field label>{control}</Field>`. The `<label>` wraps the control (implicit association) — preserve for a11y. |
| `cardHead(title, iconName, {desc, extra})` | `.card__head` > `div`( `.card__title`(optional icon + `span{title}`) + optional `.card__desc{desc}` ) + optional `extra` | Reusable card header. |
| `statusBadge(ok, label)` | `span.status.status--{ok?ok:warn}` > `span.dot[.dot--warn if !ok]` + textNode(label) | Status pill. |
| `emptyState(iconName, title, text)` | `.empty` > `.empty__icon`(icon size 26) + `h3{title}` + `p{text}` | Empty-state placeholder. |

### `renderLogin()` (367-404) — the unauthenticated view
- `<main.auth>` > `<aside.auth__aside>`(`img.auth__logo` ubitech) +
  `<div.auth__main>` > `<div.auth__card>`( `brand()`, `h1 "登录"`, form ).
- Form fields: `field("用户名", username-input)`,
  `field("密码", password-input)`.
  - username `<input name=username autocomplete=username placeholder=用户名>`.
  - password `<input name=password type=password autocomplete=current-password
    placeholder=密码>`.
- Submit button: `.btn.btn--primary.btn--lg.btn--block type=submit
  disabled={state.busy}`; shows `loader` spinner + "正在登录…" when busy, else
  "登录".
- `.error[role=alert]` bound to `state.error`.
- **onsubmit**: `preventDefault()`, then `withBusy(async()=>{ POST /api/auth/login
  {username,password} → state.user=result.user; await loadInitial();
  startPolling(); })`. (See §11 for `withBusy`, §12 for the API.)

### Migration notes
Login → `<LoginView>` with local `useState` for username/password (or
uncontrolled refs reading `.value` like the legacy code), calling a
`useAuth().login()` action. Keep `autocomplete` attrs (password managers).
Keep the `role="alert"` error region. Render this component when `!user`.

---

## 10. Polling + SSE real-time engine (lines 3263-3363)

### `refreshActiveChat({renderAfter=true})` (3263-3284)
The shared "pull latest for the active conversation" routine; used by the poll,
the SSE `update` event, and visibility-change catch-up.
- Bails if `!state.user` or `pollInFlight`.
- `keepFocus = !!app.querySelector(".composer textarea:focus")`.
- `mode` = `"private"` if private view, `"channel"` if channel view, else `""`.
- `before = chatSnapshot(mode, scopeId)` (a JSON fingerprint of messages + agent
  status + typing — see helper §10.1).
- Sets `pollInFlight=true`; then:
  - channel + activeChannelId → `await loadChannelMessages()`.
  - private → `await loadPrivateMessages()`.
  - else `return` (nothing to do).
  - `changed = before !== chatSnapshot(...)`.
  - If `renderAfter && changed`: if `keepFocus` set `_focusComposer=true`, then
    `render()`. **Only re-renders when content actually changed** (avoids
    clobbering composer/scroll on no-op polls).
- Errors swallowed (best-effort). `finally { pollInFlight=false }`.

### `startPolling()` / `stopPolling()` (3285-3302)
- `startPolling`: if no timer, `setInterval(()=>refreshActiveChat(), 4000)`.
  This is a low-frequency **safety net**; SSE is the primary realtime channel.
- `stopPolling`: clear interval, `closeScopeStream()`, clear typing stop-timer,
  `typingState.active=false`.

### SSE: `syncScopeStream()` (3331-3363) + helpers
- `currentScopeStreamUrl()`: channel → `/api/channels/{id}/events`; private →
  `/api/private-agent/events`; else `null`.
- `syncScopeStream()`:
  - Bail if `!user` or `EventSource` undefined.
  - No URL (e.g. knowledge/admin view) → `closeScopeStream()`.
  - If the same URL already has a live stream (`readyState !== 2`) → return
    (dedupe, keep the connection).
  - Else close old, open `new EventSource(url, {withCredentials:true})`.
  - On `"update"` event → `refreshActiveChat()` (guarded `scopeStream===es`).
  - On `"error"`: if `readyState===2` (CLOSED, terminal): close, then PROBE auth
    via `api("/api/auth/me")` — on success schedule a single reconnect after
    `SSE_RECONNECT_MS` (3000ms) IF `user && !document.hidden`; on failure do
    nothing (the `api()` 401 path already dropped to login). `readyState===0`
    (CONNECTING) is left to the browser's native auto-reconnect.
- `closeScopeStream()`: clears reconnect timer, closes stream, nulls
  `scopeStream`/`scopeStreamKey`.

### 10.1 Snapshot/merge helpers (used by polling)
- `chatSnapshot(mode, scopeId)` (2928): `JSON.stringify` of
  `{scope, messages.map(messageFingerprint), agent: agentStatusFingerprint(...),
  typing}` — a deep change-detector. Typing only included for channel mode.
- `messageFingerprint(m)` (2875): id, author_type, user_id, username, content,
  attachments (id/filename/mime_type/size_bytes/url), created_at, pending
  (`!!metadata.local_pending`), and agent_work (run_id/state/current_step +
  flattened activity strings).
- `agentStatusFingerprint(s)` (2902): run_id, state, queued_count, current_step,
  activity[], stream_message, stream_messages[], replying_to.
- `mergePendingMessages(mode, scopeId, messages)` (2937): appends
  `state.pendingMessages` filtered by matching `scope_type`/`scope_id` to the
  server list.
- `setAgentStatus(mode, scopeId, status)` (2862): writes
  `agentStatuses.private` or `agentStatuses.channels[scopeId]` (no-op if falsy).
- `scopeIdFor(mode, channelId)` (2852): private → `String(user.id)`; channel →
  `String(channelId)`.

### Migration notes (critical realtime behavior to preserve)
- **One SSE connection per active scope**, deduped by URL, with the EXACT
  reconnect logic: browser handles transient (readyState 0); we manually probe
  `/api/auth/me` and reconnect once after 3s only on terminal CLOSED. Use
  `skipAuthHandling`? — note the legacy probe does NOT pass it, so a real 401
  during the probe WILL trigger `handleSessionExpired` (desired). Preserve that.
- Put the SSE lifecycle in a `useEffect` keyed on
  `[user?.id, activeView, activeChannelId]` returning a cleanup that closes the
  stream. Pause on `document.hidden` and resume on visible (see §13). Keep a ref
  to the current `EventSource` + reconnect timer.
- **Change-detection gate**: keep `chatSnapshot` comparison so realtime updates
  don't cause needless re-renders / focus loss. In React this maps to: only
  `setState(messages)` when the new fingerprint differs (or rely on React's own
  bailout + careful key stability). The composer/scroll focus concerns make the
  explicit gate worth preserving.
- **4000ms safety poll**: a `setInterval` effect that calls the same refresh.
- `pollInFlight` guard → a `useRef(false)`.
- Keep typing-state teardown in stop logic.

---

## 11. `withBusy(fn)` (3466-3480) — global async-op wrapper

```
state.busy = true; state.error = ""; render();
try { await fn(); }
catch(e){ state.error = e.message||String(e); if(state.user) toast(message,{type:"error",title:"操作失败"}); }
finally { state.busy = false; render(); }
```
- Sets global `busy` (disables buttons, shows spinners), clears prior error,
  renders immediately so the UI reflects busy.
- On error: stores message in `state.error` AND toasts it (title "操作失败"),
  but ONLY toasts if `state.user` (avoid toasting on the login screen — the
  login form shows `.error` inline instead).
- Always clears `busy` + re-renders.

### Migration notes
Port as `useBusy()`/store action: `runBusy(fn)`. `busy` is global (one in-flight
op disables the whole UI's primary buttons) — keep it in the store. Reproduce the
"don't toast while logged out" rule. Buttons across the app read `state.busy` for
their `disabled` + spinner — expose `busy` from the store.

---

## 12. Session lifecycle (lines 3431-3464, 3520-3541)

### `handleSessionExpired()` (3431-3441) — called by `api()` on 401
- No-op if `!state.user` (already logged out).
- `stopPolling()` (kills poll + SSE + typing timers).
- `state.user = null`, `state.sidebarOpen = false`, `hideMentionMenu()`.
- Toast: "会话已过期，请重新登录" (type error, title "需要登录").
- `render()` → drops to login.

### `logout()` (3443-3464)
- `await api("/api/auth/logout", {method:"POST"}).catch(()=>{})` (best-effort).
- `stopPolling()`.
- **Revoke optimistic blob URLs**: `for (m of state.pendingMessages)
  revokeAttachmentUrls(m)` (frees `URL.createObjectURL` previews — memory leak
  guard; see `revokeAttachmentUrls` 2956).
- Reset: `user=null, sidebarOpen=false, pendingMessages=[], draftFiles={},
  mentionTargets=[], typingUsers=[]`, and reinitialize `messageAudit` to its
  full default object (same shape as initial).
- `hideMentionMenu()`, `render()`.

### `boot()` (3520-3533)
- `setupGlobalListeners()` (idempotent).
- `try { const r = await api("/api/auth/me"); state.user=r.user;
  state._focusComposer=true; await loadInitial(); startPolling(); }`
- `catch { state.user=null; stopPolling(); }`
- `render()`.

### `startEnterpriseApp()` (3537-3541) — the exported entrypoint
Guarded by `bootStarted` (one-shot); calls `boot()`. Imported by `main.tsx`.

### `loadInitial()` (3148-3151)
`await Promise.all([loadChannels(), loadMentionTargets()]); await
loadChannelMessages();` — the post-login data hydration.

### Migration notes
- `handleSessionExpired` + `logout` + `boot` become store actions / an
  `AuthProvider`. `boot()` → an app-init `useEffect` (the `bootStarted` guard
  maps to a `useRef`; also handles React 19 StrictMode double-mount).
- On logout, REPLICATE the blob-URL revocation (iterate pendingMessages → revoke
  `local_preview` attachment urls) to avoid leaks — easy to forget in React.
- `_focusComposer=true` after boot → trigger a one-shot composer focus.
- Keep all reset assignments; `messageAudit` reset must restore the full nested
  default (not just `{}`).

---

## 13. Global listeners (lines 3482-3518)

`setupGlobalListeners()` (idempotent via `globalListenersReady`):
1. `keydown` Escape → if `sidebarOpen`, `preventDefault()` + `closeSidebar()`.
2. `matchMedia("(max-width:800px)")` `change` → if `user`, `render()`
   (re-evaluate drawer inert/aria-hidden across the mobile breakpoint). Uses
   `addEventListener` with `addListener` fallback (old Safari).
3. `visibilitychange`:
   - if `!user` return.
   - hidden → clear poll interval (`pollTimer`) + `closeScopeStream()` (pause).
   - visible → `refreshActiveChat()` (catch up) + `startPolling()` +
     `syncScopeStream()` (resume).
4. `window` `pagehide` → `closeScopeStream()` (release SSE promptly).

Also relevant (sidebar focus mgmt, lines 419-437):
- `sidebarHiddenForA11y()`: `!sidebarOpen && <=800px`.
- `openSidebar()`: set open, `render()`, then on next frame focus
  `#app-sidebar .nav__item` (move focus into drawer).
- `closeSidebar()`: set closed, `render()`, then if it was open focus
  `.menu-btn` (return focus to opener).

### Migration notes
- Move each listener into a top-level `useEffect` (Escape→close drawer,
  breakpoint media-query, `visibilitychange` pause/resume, `pagehide` cleanup).
  These need access to current `user`/`sidebarOpen` — use refs or include in
  deps. The visibility pause/resume + pagehide are the same SSE/poll lifecycle as
  §10; consolidate.
- Drawer focus management (focus first nav item on open, return to menu button on
  close) → `useEffect` on `sidebarOpen` + refs. Reproduce
  `sidebarHiddenForA11y()` → set `inert`/`aria-hidden` on the sidebar when closed
  on mobile (currently the legacy app re-renders on breakpoint change to apply
  this — in React it's a derived prop).

---

## 14. Accessibility inventory (present + gaps)

Present:
- Icons `aria-hidden="true"`.
- Theme button `aria-label="切换主题"` + dynamic `title`.
- Toast container `aria-live="polite" aria-atomic="false"`; each toast
  `role="status"`; close button `aria-label="关闭附件"`/titles.
- Login error `[role="alert"]`; scrim `aria-label="关闭菜单"` with roving
  `tabindex` (`0` when open / `-1` when closed).
- Sidebar off-canvas a11y via `sidebarHiddenForA11y()` + focus management
  (open→first nav item, close→menu button).
- Composer mention menu uses `role="combobox"`, `aria-expanded`,
  `aria-activedescendant`, `aria-controls` (managed in `hideMentionMenu`).
- `field()` uses wrapping `<label>` for implicit control association.

Gaps to fix opportunistically (don't regress, but can improve):
- No skip-link / landmark roles beyond `<main>`/`<aside>`.
- Focus is managed imperatively via `requestAnimationFrame` after full teardown;
  in React use `useLayoutEffect` + refs for deterministic focus.
- The OS theme change isn't observed (only mobile breakpoint is). Optional fix.
- `_focusComposer`/`_scrollChatToBottom` focus/scroll are best-effort one-shots;
  ensure React equivalents fire after commit (`useLayoutEffect`).

---

## 15. Proposed React component / hook boundaries for this section

Store & primitives (no UI):
- `store/` — global state (Zustand or `useReducer`+Context). Mirror the `state`
  shape from §1 EXACTLY (field names are coupled to many call sites). Expose
  actions: `setUser`, `login`, `logout`, `handleSessionExpired`, `runBusy`,
  `toggleSidebar`, `setActiveView`, plus the data-loaders (`loadInitial`, etc.).
- `lib/api.ts` — `api()` (verbatim contract §2) + `safeUrl()`.
- `lib/icons.tsx` — `<Icon>` + `ICONS` record (§4).
- `lib/format.ts` — formatters (formatTime/Timestamp/Number/FileSize/initials…)
  referenced here but owned cross-section.
- `lib/constants.ts` — `ADMIN_PAGES`, `THINKING_DEPTH_OPTIONS`,
  `FALLBACK_PERMISSION_GROUPS`, limits (`MAX_ATTACHMENTS_PER_MESSAGE`,
  `MAX_ATTACHMENT_BYTES`), `SSE_RECONNECT_MS`.

Providers / hooks:
- `<ThemeProvider>` + `useTheme()` (§5).
- `<AuthProvider>` / `useAuth()` (boot, login, logout, session expiry, §12).
- `usePermissions()` → `{isAdmin, has}` (§6).
- `useToast()` + module-level `toast()` singleton + `<ToastStack>` portal (§7).
- `useRealtime()` — owns the SSE + 4s poll + visibility pause/resume + the
  `chatSnapshot` change-gate (§10, §13). Keyed on user/view/channel.
- `useAutoGrow(ref)` (§8).
- `useBusy()` exposing `busy` + `runBusy` (§11).

Components:
- `<App>` (root): runs boot effect; renders `<LoginView>` when `!user`, else
  `<Shell>`. Hosts the global-listener effects + `<ToastStack>` portal.
- `<LoginView>` (§9 `renderLogin`).
- Shared atoms: `<Brand>`, `<Field>`, `<CardHead>`, `<StatusBadge>`,
  `<EmptyState>`, `<ThemeToggle>`, `<Icon>`, `<Spinner>` (loader+spin).

### Tricky reconciliation/focus/scroll concerns (off full-teardown)
1. **Composer focus & IME**: keep the composer as an isolated component with
   local value state and `compositionstart/end` handlers; never let
   realtime/poll updates remount it. The legacy defer-render hack becomes
   unnecessary IF the composer subtree is stable across message updates —
   verify with an IME (Chinese input) that typing isn't interrupted by SSE
   `update` events.
2. **Message scroll restoration**: must be a `useLayoutEffect` in the messages
   list capturing pre-commit `{top,bottom}` and applying the exact 32px-near-
   bottom / chat-changed / `_scrollChatToBottom` heuristic. Key off
   `chatKey = ${scopeType}:${scopeId}`.
3. **One-shot intents** (`_focusComposer`, `_scrollChatToBottom`): model as a
   small consumable action/ref, not persistent state, so they fire exactly once
   after the relevant commit and then clear.
4. **Toasts must live outside the app subtree** (portal to `#toast-stack`) so
   view switches/teardown don't drop in-flight toasts; preserve the aria-live
   region identity (don't recreate the container on every render).
5. **SSE dedupe**: only re-open the EventSource when the scope URL actually
   changes; otherwise React effect deps churn could thrash connections — key the
   effect precisely and keep the readyState-aware reconnect.
6. **`busy` is global**: a single in-flight op disables primary buttons app-wide;
   keep it in the store, not per-component.
