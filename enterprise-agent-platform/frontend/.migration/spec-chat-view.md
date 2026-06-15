# Migration Spec — Chat View Shell + Chat Data/Real-time Layer

Source: `frontend/src/legacy-app.js`
Covered legacy line ranges: **573–870** (renderContent, renderChat, renderPrivateTelegramConfig, addDraftFiles, clipboardImageFiles, namedClipboardImage), **2850–3064** (scope/status helpers, fingerprint/snapshot/merge, optimistic message lifecycle, postChatMessage, typing), **3263–3365** (refreshActiveChat, polling, SSE stream).
Also documents tightly-coupled helpers outside the range that this section depends on: `render`/`afterRender`/`captureMessageScroll`/`restoreMessageScroll`/`flushDeferredRender` (268–322), `api` (73–94), `autoGrow` (1183–1199), `renderMessage`/agent activity/typing renderers (871–1029, 1175–1223), data loaders (3148–3185), nav/view switching (489–502, 453–459), `handleSessionExpired`/`withBusy`/global listeners/boot (3431–3541).

> This is the highest-risk section of the migration. The optimistic-message reconciliation, fingerprint dedupe, SSE reconnect, typing throttle, and scroll/focus preservation are all currently implemented through global mutable singletons + a full DOM teardown (`app.replaceChildren`). Moving to React requires replicating these semantics exactly while abandoning the teardown model.

---

## 0. Global state fields & module singletons this section touches

From the global `state` object (legacy-app.js:8–59). Fields **read or written** by this section:

| field | type | role |
|---|---|---|
| `state.user` | object/null | identity; gates polling/SSE; `user.id`, `user.display_name`, `user.username`, `user.permissions[]`, `user.role`, `user.permission_group` |
| `state.activeView` | `"channel" \| "private" \| "knowledge" \| "admin"` | which view renders; `renderContent` branches on it |
| `state.activeChannelId` | id/null | active channel scope for channel mode |
| `state.messages` | array | channel messages (incl. optimistic pending) |
| `state.privateMessages` | array | private-agent messages (incl. optimistic pending) |
| `state.pendingMessages` | array | **global** registry of optimistic messages across all scopes (used by `mergePendingMessages`) |
| `state.drafts` | `{ [draftKey]: string }` | per-scope composer text |
| `state.draftFiles` | `{ [draftKey]: File[] }` | per-scope pending attachments |
| `state.agentStatuses` | `{ channels: {[id]: status}, private: status\|null }` | agent run status per scope |
| `state.expandedAgentRuns` | `{ [runId]: bool }` | per-run expand/collapse memory (read by `renderAgentWorkCard`) |
| `state.mentionTargets` | array | @-mention autocomplete source (channel only) |
| `state.typingUsers` | array | other users typing in channel (`{user_id, username}`) |
| `state.privateTelegram` | object/null | `{ gateway:{enabled,bot_username}, link:{telegram_user_id,telegram_username} }` |
| `state.privateTelegramExpanded` | bool | controls the Telegram popover dialog |
| `state.busy` | bool | global busy flag (disables Telegram form buttons) |
| `state.error` | string | last error message |
| `state._lastView` | string | previous view, drives the `view-enter` CSS animation |
| `state._focusComposer` | bool | post-render side-effect flag: focus composer textarea |
| `state._scrollChatToBottom` | bool | post-render side-effect flag: jump messages to bottom |
| `state.sidebarOpen` | bool | (read indirectly via render) |

Module-level singletons (legacy-app.js:61–70, 3304–3307):

```js
let pollTimer = null;            // setInterval handle, 4000ms
let pollInFlight = false;        // mutex preventing overlapping refreshActiveChat
let localMessageSeq = 0;         // monotonic counter for tmp ids
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;   // 50 MB
const typingState = { key: null, active: false, lastSent: 0, stopTimer: null };
const composerState = { composing: false, renderDeferred: false };   // IME composition + deferred-render flag
// SSE singletons:
let scopeStream = null;          // EventSource instance
let scopeStreamKey = null;       // url string the stream is bound to
let scopeStreamReconnect = null; // setTimeout handle
const SSE_RECONNECT_MS = 3000;
```

`mentionState` (line 70) is owned by the mention-menu section but is read/written by composer handlers documented here.

---

## 1. `renderContent()` — view router + Telegram popover host

**Lines 573–585. Purpose:** top-level content-area router for the main pane; chooses chat/knowledge/admin and conditionally appends the private Telegram popover.

### Markup
```
<section class="content {view-enter?}">
  {view}                       // renderChat("private"|"channel") | renderKnowledge() | renderAdminPanel()
  {private && privateTelegramExpanded ? renderPrivateTelegramConfig() : null}
</section>
```

### State
- Reads `state.activeView`; reads & writes `state._lastView`.
- `animate = state._lastView !== state.activeView` → adds `view-enter` class (CSS keyframe `view-in` 0.24s, styles.css:504). After computing, sets `state._lastView = state.activeView` so the animation only plays once per view change.
- Reads `state.privateTelegramExpanded`.

### Migration notes
- React component `ContentArea`. The `view-enter` animation must replay only when `activeView` changes — replicate with a key change or a `usePrevious(activeView)` comparison applied as a CSS class on first render after change. Do NOT play on every re-render (the current teardown happens to give this for free; React reconciliation will not).
- The Telegram popover is rendered as a *sibling* of the chat view inside `.content`. It is positioned absolutely (styles.css `.telegram-link` is `position: fixed/absolute` style popover — see §3). Keep it a sibling of the chat, conditionally mounted on `activeView==="private" && privateTelegramExpanded`.

---

## 2. `renderChat(mode)` — the chat view (channel + private share this)

**Lines 588–743. Purpose:** renders the message list + composer for either `"channel"` or `"private"` mode. This is the central component of the section.

### 2.1 Derived values (top of function)
```js
messages       = mode==="private" ? state.privateMessages : state.messages
noChannel      = mode==="channel" && !state.activeChannelId
canChat        = hasPermission("chat") && (mode!=="private" || hasPermission("private_agent"))
scopeId        = scopeIdFor(mode)               // see §5
draftKey       = composerDraftKey(mode, scopeId) // `${scopeType}:${scopeId}`
selectedFiles  = state.draftFiles[draftKey] || []
mentionMenuId  = `mention-menu-${scopeTypeFor(mode)}-${scopeId}`
```

### 2.2 Markup structure
```
<div class="chat">                               // CSS grid 1fr/auto, full height
  <div class="messages" data-chat-key="{scopeType}:{scopeId}">   // scrollable
    {body}
  </div>
  <form class="composer" onsubmit=preventDefault+submit>
    <div class="composer__wrap">
      <div class="composer__field">
        <input class="composer__file-input" type="file" multiple tabindex="-1" hidden(css)>
        <button class="icon-btn composer__attach" type="button" disabled={noChannel||!canChat}>📎</button>
        <textarea ...composer textarea... />          // see §2.4
        <div class="mention-menu" role="listbox" id={mentionMenuId} hidden></div>
        <button class="btn btn--primary composer__send" type="submit" disabled={noChannel||!canChat}>send</button>
      </div>
      {selectedFiles.length ? renderComposerFiles(draftKey, selectedFiles) : null}
      <div class="composer__hint">
        <span class="kbd">Enter</span><span>发送</span>
        <span class="kbd">Shift+Enter</span><span>换行</span>
      </div>
    </div>
  </form>
</div>
```
Relevant CSS: `.chat` grid-template-rows: 1fr auto (styles.css:509); `.messages` overflow-y:auto (537); `.messages__inner` width min(860px,100%) centered (544); `.composer` border-top + padding incl. safe-area (753); `.composer__field` focus-within ring (766); `.composer__file-input{display:none}` (781); `.mention-menu` absolute, bottom: calc(100%+8px) above field (819).

### 2.3 Message-body branch logic (lines 688–713)
1. **`noChannel`** → `emptyState("hash", "还没有频道", "在左侧创建一个频道，开始与团队和 Agent 协作。")`
2. **Empty + no active agent + not error** (`!messages.length && !isAgentActive(agentStatusFor(mode)) && agentStatusFor(mode)?.state !== "error"`):
   - private → `emptyState("bot", "开启你的私人 Agent", "这是仅你可见的助手。发送第一条消息试试看。")`
   - channel → `emptyState("message", "暂无消息", "成为第一个在该频道发言的人。需要时 @agent。")`
3. **Otherwise** build `items = messages.map(renderMessage)`, then append agent activity:
   - `status = agentStatusFor(mode)`
   - if `isAgentActive(status)` (state queued|replying): push `hasAgentProcessSteps(status) ? renderAgentActivity(status) : renderAgentTyping(status)`; then push one `renderMessage(streamingMessage)` for each `agentStreamingMessages(status, mode)` (synthetic streaming agent messages, §6).
   - else if `status && status.state === "error"`: push a terminal-error article `<article class="msg msg--agent msg--activity">` containing bot avatar + `renderAgentWorkCard(status,{active:false})`.
   - if `mode==="channel" && state.typingUsers.length`: push `renderTypingUsers(state.typingUsers)`.
   - wrap all in `<div class="messages__inner">items</div>`.

### 2.4 Composer textarea (lines 610–662) — event handlers
Attributes: `rows=1`, `disabled = noChannel || !canChat`, dynamic `placeholder` (4 cases below), `aria-label="消息输入框"`. Channel-only ARIA combobox wiring: `role="combobox"`, `aria-haspopup="listbox"`, `aria-autocomplete="list"`, `aria-controls=mentionMenuId`, `aria-expanded="false"` (these are `null` in private mode).

Placeholder logic:
- noChannel → `"选择频道后发送消息"`
- canChat & private → `"给你的私人 Agent 发消息…"`
- canChat & channel → `` `在 #${activeChannel()?.name || "频道"} 发消息，@agent 呼叫 Agent…` ``
- !canChat → `"当前权限组只能查看内容"`

After build: `input.value = state.drafts[draftKey] || ""` (line 662) — the textarea value is set imperatively AFTER element creation, not via attribute. This matters: in vanilla it preserves an uncontrolled value across the teardown.

Handlers:
- **oninput** (624): `state.drafts[draftKey] = e.target.value`; `autoGrow(e.target)`; `updateMentionMenu(input, mentionMenu, mode)`; if `!e.isComposing && !composerState.composing` → `notifyTyping(mode, scopeId, value.trim().length>0)`.
- **onfocus** (630): `updateMentionMenu(...)`.
- **onclick** (631): `updateMentionMenu(...)`.
- **onpaste** (632): `images = clipboardImageFiles(e.clipboardData)`; if any → `e.preventDefault()` + `addDraftFiles(draftKey, images)`. (Non-image paste falls through to default text paste.)
- **onkeyup** (638): if key NOT in `[ArrowDown,ArrowUp,Enter,Tab,Escape]` → `updateMentionMenu(...)`.
- **onblur** (641): `setTimeout(() => hideMentionMenu(mentionMenu), 120)` — delay lets a mention-option mousedown fire first.
- **oncompositionstart** (642): `composerState.composing = true`; `hideMentionMenu(mentionMenu)`.
- **oncompositionend** (646): `composerState.composing = false`; `state.drafts[draftKey] = e.target.value`; `autoGrow`; `notifyTyping(mode, scopeId, value.trim().length>0)`; `updateMentionMenu`; `flushDeferredRender()` (replays any render that was deferred during IME composition).
- **onkeydown** (654): if `!e.isComposing && handleMentionKey(e, input, mentionMenu, mode, scopeId, draftKey)` returns true → return (mention nav consumed the key). Else if `Enter && !shiftKey && !isComposing` → `e.preventDefault(); submit()`.

### 2.5 `submit()` closure (lines 664–686)
```
if (composerState.composing) return;             // never submit mid-IME
content = (state.drafts[draftKey] || input.value).trim()
files   = state.draftFiles[draftKey] || []
if ((!content && !files.length) || noChannel || !canChat) return;
input.value = ""; state.drafts[draftKey] = ""; delete state.draftFiles[draftKey];
autoGrow(input);
state._focusComposer = true;                     // refocus after re-render
state._scrollChatToBottom = true;                // jump to bottom after re-render
notifyTyping(mode, scopeId, false);              // tell server we stopped typing
sent = await postChatMessage(mode, scopeId, content, files);   // §8
if (!sent) {                                      // restore on failure
  state.drafts[draftKey] = content;
  if (files.length) state.draftFiles[draftKey] = files;
  state._focusComposer = true;
  render();
}
```
**Edge case:** on failure, draft text AND files are restored so nothing is lost; an extra `render()` is required because `postChatMessage`'s `finally` already re-rendered with the cleared draft.

### 2.6 File input onchange (602–607)
`incoming = Array.from(event.target.files || [])`; `event.target.value = ""` (reset so the same file can be re-picked); if empty return; else `addDraftFiles(draftKey, incoming)`.

### 2.7 Attach button (721–728)
`type="button"`, disabled when `noChannel||!canChat`, `onclick: () => fileInput.click()`. Title/aria-label `"添加文件"`.

### State read/written by renderChat
- Reads: `state.privateMessages|messages`, `state.activeChannelId`, `state.draftFiles[draftKey]`, `state.drafts[draftKey]`, `state.typingUsers`, agent statuses, `state.user` (via permission & activeChannel).
- Writes: `state.drafts[draftKey]`, `state.draftFiles[draftKey]` (delete), `state._focusComposer`, `state._scrollChatToBottom`, plus side effects through `notifyTyping`/`postChatMessage`.

### Permission gating
- `canChat` gates textarea/attach/send disabled state and `submit()` early-return.
- private mode additionally requires `hasPermission("private_agent")` (also enforced in `renderShell` line 409: redirect away from private if not permitted; and sidebar nav only shows private if `hasPermission("private_agent")`).

---

## 3. `renderPrivateTelegramConfig()` — Telegram link popover dialog

**Lines 745–816. Purpose:** modal-ish popover (role="dialog") to bind/unbind the user's Telegram account to their private agent.

### Markup
```
<section class="telegram-link" id="private-telegram-popover" role="dialog" aria-label="Telegram 私聊设置">
  <div class="telegram-link__header">
    <div class="telegram-link__meta">
      <div class="telegram-link__title">[message icon] <span>Telegram 私聊</span></div>
      <div class="telegram-link__sub">{status}</div>
    </div>
    <button class="icon-btn telegram-link__close" type="button" aria-label="收起 Telegram 私聊设置">[close]</button>
  </div>
  <form class="telegram-link__form">
    {field("Telegram ID", <input inputmode=numeric placeholder="例如 123456789">)}
    {field("Telegram 用户名", <input placeholder="可选，不带 @">)}
    <div class="telegram-link__actions">
      <button class="btn btn--primary btn--sm" type="submit" disabled={state.busy}>{linked?"更新绑定":"保存绑定"}</button>
      {linked ? <button class="btn btn--danger btn--sm" type="button" disabled={state.busy}>解除</button> : null}
    </div>
  </form>
</section>
```
`field(label, control)` = `<label class="field"><span>{label}</span>{control}</label>` (legacy-app.js:331).

### Derived
```
payload = state.privateTelegram || {}
gateway = payload.gateway || {}; link = payload.link || {}
linked  = !!link.telegram_user_id
botName = gateway.bot_username ? `@${bot_username}` : "Telegram bot"
status  = gateway.enabled ? `${botName} ${linked?"已绑定":"可绑定"}` : "管理员尚未启用"
```
Input default values are read from `link.telegram_user_id` / `link.telegram_username` (uncontrolled, set at build time).

### API calls
1. **Save/update** (submit, lines 758–770): wrapped in `withBusy`:
   - `PUT /api/private-agent/telegram`
   - body JSON: `{ telegram_user_id: <input.value>, telegram_username: <input.value> }`
   - then `await loadPrivateTelegram()` → `GET /api/private-agent/telegram` → sets `state.privateTelegram`.
   - toast: `"Telegram 绑定已保存"` `{type:"ok", title:"完成"}`.
2. **Unbind** (only when `linked`, lines 781–787): `withBusy`:
   - `DELETE /api/private-agent/telegram` with body literal string `"{}"`.
   - then `loadPrivateTelegram()`; toast `"Telegram 绑定已解除"` `{type:"ok", title:"完成"}`.

### Events / state
- Close button (803–812): `state.privateTelegramExpanded = false; render()`.
- `withBusy` toggles `state.busy` and surfaces errors as toasts (legacy-app.js:3466).
- The trigger button lives in the topbar (`renderPrivateTelegramAction`, lines 538–559) and toggles `state.privateTelegramExpanded`; it carries `aria-expanded`, `aria-controls="private-telegram-popover"`. Keep the id linkage for a11y.

### Migration notes
- `TelegramLinkPopover` component. Inputs become `useState` (controlled) seeded from `link.*`. Submit/delete call a shared mutation. Use `aria-controls`/`id` matching the trigger. The whole popover already has `role="dialog"` but **no focus trap and no Escape-to-close** — flag as an a11y gap to optionally improve (don't change behavior unless requested). `disabled={state.busy}` → disable while a global mutation is in flight.

---

## 4. Draft-file / clipboard helpers

### `addDraftFiles(draftKey, incoming)` — lines 818–837
- Iterate `incoming`; reject any `file.size > MAX_ATTACHMENT_BYTES` (50MB) with toast `` `${file.name||"附件"} 超过 50 MB` `` `{title:"文件过大"}`.
- `next = [...current, ...accepted].slice(0, MAX_ATTACHMENTS_PER_MESSAGE)` (cap 10).
- If `current.length + accepted.length > 10` → toast `` `每条消息最多 ${10} 个附件` `` `{title:"附件过多"}`.
- If no accepted files → return false (no render).
- Sets `state.draftFiles[draftKey] = next`, `state._focusComposer = true`, calls `render()`, returns true.

### `clipboardImageFiles(clipboardData)` — lines 839–853
- Returns `[]` if no clipboardData.
- First pass: iterate `clipboardData.items`, keep `item.kind==="file" && item.type startsWith "image/"`, call `item.getAsFile()`, wrap with `namedClipboardImage(file, idx)`.
- Fallback: if none found, iterate `clipboardData.files` for image types, same wrapping.

### `namedClipboardImage(file, index)` — lines 855–869
- If `file.name` exists, return as-is.
- Else map mime → ext (`png/jpeg→jpg/gif/webp/bmp`, default `png`) and construct `new File([file], `pasted-image-${index+1}.${ext}`, {type, lastModified})`. On exception, return original file.

### Migration notes
- Pure functions; move to a `composerFiles.ts` util. `addDraftFiles` should become a reducer action / setState updater on draftFiles, with toasts via a toast context. The toast strings + thresholds MUST stay verbatim.

---

## 5. Scope / draft-key / status helpers — lines 2850–2874

```js
activeChannel()            // state.channels.find(c => c.id === state.activeChannelId)
scopeTypeFor(mode)         // "private" | "channel"
scopeIdFor(mode, channelId=state.activeChannelId)
                           // private → String(state.user?.id || "")  ; channel → String(channelId||"")
composerDraftKey(mode, scopeId=scopeIdFor(mode))   // `${scopeType}:${scopeId}`
agentStatusFor(mode, channelId=state.activeChannelId)
                           // private → state.agentStatuses.private
                           // channel → state.agentStatuses.channels[String(channelId||"")] || null
setAgentStatus(mode, scopeId, status)  // no-op if !status; writes private or channels[scopeId]
isAgentActive(status)      // status && (state==="queued" || state==="replying")
agentStatusText(status)    // "" if not active; target = replying_to?.username||"用户";
                           //   queued → `Agent 准备回复 ${target}` ; replying → `Agent 正在回复 ${target}`
```
**Note:** `scopeIdFor` for private mode keys off the *current user id*, so the private draft key is `private:<userId>`. Channel key is `channel:<channelId>`.

### Migration notes
- These are pure derivations from `state`. In React they become selectors/`useMemo` from a ChatContext. `agentStatuses` is a nested map — keep the `{channels:{}, private:null}` shape or model as `Map`. Keying by string id is important (`String(...)` coercion everywhere — preserve it to avoid number/string key mismatches).

---

## 6. Fingerprint / snapshot / merge — lines 2875–2940

### `messageFingerprint(message)` — 2875–2901
Returns a plain object capturing the *render-affecting* fields of a message: `id, author_type, user_id, username, content, attachments[{id,filename,mime_type,size_bytes,url}], created_at, pending (= !!metadata.local_pending), agent_work` (if `metadata.agent_work` present: `{run_id, state, current_step, activity[]}` where each activity is flattened to a string `"${source}:${stage}:${label}:${detail}:${line}:${tool_status}:${at}"`).

### `agentStatusFingerprint(status)` — 2902–2927
`null` if no status. Else `{run_id, state, queued_count, current_step, activity[<flattened strings>], stream_message:{id,content,updated_at}|null, stream_messages[<"id:content:updated_at">], replying_to:{id,username,content,created_at}|null}`.

### `chatSnapshot(mode, scopeId)` — 2928–2936
`JSON.stringify({ scope:`${scopeType}:${scopeId||""}`, messages: messages.map(messageFingerprint), agent: agentStatusFingerprint(agentStatusFor(mode,scopeId)), typing: channel? state.typingUsers.map({user_id,username}) : [] })`.
**Used by `refreshActiveChat` to decide whether anything visually changed** — if `before === after`, skip the re-render (avoids scroll/focus churn from no-op polls).

### `mergePendingMessages(mode, scopeId, messages)` — 2937–2940
`pending = state.pendingMessages.filter(scope_type===scopeType && scope_id===String(scopeId))`; returns `[...messages, ...pending]`. This re-appends still-in-flight optimistic messages after a server fetch so they don't disappear between send and confirmation.

### Migration notes
- The fingerprint/snapshot mechanism exists purely to suppress no-op full re-renders. **In React this concern largely disappears**: React already diffs. You generally do NOT need `chatSnapshot` for render-skipping. BUT you DO still need the *change-detection* for the scroll-to-bottom decision (see §11) and to avoid resetting scroll on identical poll payloads. Recommended: keep a lightweight equality check (or compare message ids + agent activity ids/updated_at) inside the data hook before calling `setState`, so identical server payloads don't trigger a state update (React would re-render and could disturb scroll). Reuse the exact flatten format if you keep snapshots.
- `mergePendingMessages` semantics must survive: the canonical message list = server messages + still-pending optimistic ones for that scope. Model `pendingMessages` as scope-keyed state and merge in a selector.

---

## 7. Optimistic message lifecycle — lines 2941–3005

This is the trickiest reconciliation logic. Sequence:

### `optimisticAttachments(files)` — 2941–2955
Maps each File → `{ id:`tmp-att-${localMessageSeq}-${index}`, filename, mime_type, size_bytes, is_image (type startsWith image/), url:URL.createObjectURL(file), download_url:url, local_preview:true }`. **Creates blob object URLs** that MUST be revoked later.

### `revokeAttachmentUrls(message)` — 2956–2962
For each attachment with `local_preview && url` → `URL.revokeObjectURL(url)` (guarded try/catch).

### `appendOptimisticMessage(mode, scopeId, content, files)` — 2963–2981
- `localMessageSeq += 1`; build message `{ id:`tmp-${localMessageSeq}`, scope_type, scope_id:String(scopeId), author_type:"user", user_id:state.user?.id||null, username: state.user?.display_name||username||"你", content, attachments:optimisticAttachments(files), metadata:{local_pending:true}, created_at: floor(Date.now()/1000) }`.
- Push to `state.pendingMessages`.
- If private → `state.privateMessages = [...state.privateMessages, message]`.
- Else if `String(state.activeChannelId)===String(scopeId)` → `state.messages = [...state.messages, message]` (only appends to the visible list if that scope is still active).
- Returns the message.

### `removeLocalMessage(list, id)` — 2982–2984
`list.filter(m => m.id !== id)` (pure).

### `replaceOptimisticMessage(mode, scopeId, tempId, savedMessage)` — 2985–2998
- Find pending by `tempId`, `revokeAttachmentUrls(pending)`, remove from `state.pendingMessages`.
- `apply(messages)`: find old by tempId, `revokeAttachmentUrls(old)`, `next = removeLocalMessage(messages, tempId)`; if `savedMessage && !next.some(id===savedMessage.id)` → append `savedMessage` (dedupe — if a poll/SSE already inserted the saved message, don't double-add).
- Apply to `privateMessages` (private) or `messages` (channel, only if scope still active).

### `removeOptimisticMessage(mode, scopeId, tempId)` — 2999–3005
On send failure: find pending, revoke its blob urls, remove from `pendingMessages`, and remove from the visible list (private or active-channel).

### Migration notes (critical)
- **Blob URL lifecycle is a real memory-leak risk.** Every `URL.createObjectURL` must be matched by exactly one `revokeObjectURL` on replace/remove/logout (`logout()` line 3446 revokes all pending). In React, attach revocation to the optimistic message's removal — but beware React StrictMode double-invocation and stale closures. Prefer doing createObjectURL inside the send mutation (not render) and storing the url on the message object; revoke in the same reducer transition that drops the temp message. Do NOT create object URLs in `useMemo`/render bodies.
- The `tmp-${seq}` ids and `tmp-att-${seq}-${i}` ids must remain stable React keys for the optimistic item until replaced by the server id. Reconciliation = replace key `tmp-N` with server `savedMessage.id`. The dedupe guard (`!next.some(id===savedMessage.id)`) is essential because the SSE `update` event may have already pulled the persisted message in before the POST resolves.
- `appendOptimisticMessage`'s "only append if scope still active" guard prevents cross-scope leakage when the user switches channels mid-send. Preserve: the optimistic message always lives in `pendingMessages` (global) and is merged back in via `mergePendingMessages` when the user returns to that scope.

---

## 8. `postChatMessage(mode, scopeId, content, files)` — lines 3006–3036

The core send mutation. **Payloads must be byte-for-byte preserved.**

```
pending = appendOptimisticMessage(mode, scopeId, content, files); render();   // optimistic insert
try:
  if files.length:
     form = new FormData();
     form.append("content", content);
     for file of files: form.append("files", file, file.name);   // field name "files", repeated
     request = { method:"POST", body: form }                     // NO Content-Type header (browser sets multipart boundary)
  else:
     request = { method:"POST", body: JSON.stringify({ content }) }   // application/json (api() adds header)
  result = mode==="private"
     ? await api("/api/private-agent/messages", request)
     : await api(`/api/channels/${scopeId}/messages`, request)
  replaceOptimisticMessage(mode, scopeId, pending.id, result.user_message)
  setAgentStatus(mode, scopeId, result.agent_status)
  await refreshActiveChat({ renderAfter:false })                 // pull latest, but don't double-render
  return true
catch error:
  removeOptimisticMessage(mode, scopeId, pending.id)
  state.error = error.message; toast(error.message, {type:"error", title:"发送失败"})
  return false
finally:
  state._focusComposer = true; render()
```

### API contract
| mode | METHOD | path | body | response fields used |
|---|---|---|---|---|
| channel | POST | `/api/channels/{scopeId}/messages` | JSON `{content}` **or** multipart `content` + repeated `files` | `result.user_message`, `result.agent_status` |
| private | POST | `/api/private-agent/messages` | same | same |

`api()` (legacy-app.js:73): `credentials:"include"`; for FormData it does NOT set Content-Type (lets browser add boundary); for JSON it sets `Content-Type: application/json`. On HTTP 401 (and not `skipAuthHandling`) calls `handleSessionExpired()`. On non-ok throws `Error(data.error || data.detail || `请求失败（${status}）`)`. Returns parsed JSON (`{}` on empty/non-JSON body).

### Migration notes
- `postChatMessage` → an async mutation in a `useChat`/reducer. The three `render()` calls collapse into normal state updates. Keep the ordering: optimistic insert → await POST → replace temp with `user_message` + set `agent_status` → `refreshActiveChat({renderAfter:false})` (in React this is just "fetch latest and merge"; no render flag needed) → on error remove temp + toast → always set focus-composer.
- Multipart field name is exactly `files` (repeated) and `content`. JSON body is exactly `{content}`. Do not add fields.
- `_focusComposer` always true in finally → after send the composer keeps focus. Replicate via a ref + effect (see §11).

---

## 9. Typing indicator — lines 3037–3063

### `notifyTyping(mode, scopeId, isTyping)` — 3037–3053
- **No-op unless `mode==="channel" && scopeId`** (private agent has no typing broadcast).
- `key = `channel:${scopeId}``.
- Clear any existing `typingState.stopTimer`.
- If `!isTyping` → `sendTypingState(key, false)` and return.
- Throttle: if `typingState.key !== key || !typingState.active || now - typingState.lastSent > 1800` → `sendTypingState(key, true)` (i.e. send a fresh "typing:true" at most ~every 1.8s, or whenever scope/active changes).
- Always (when typing) set `typingState.stopTimer = setTimeout(() => sendTypingState(key, false), 3500)` — auto-clears typing 3.5s after last keystroke.

### `sendTypingState(key, isTyping)` — 3054–3063
- `channelId = key.replace(/^channel:/, "")`.
- Update `typingState.{key,active,lastSent=Date.now()}`.
- `POST /api/channels/{channelId}/typing` body JSON `{ typing: isTyping }`. Errors swallowed (`.catch(()=>{})`).

### Constants: throttle window **1800ms**, auto-stop **3500ms**.

### Migration notes
- Move `typingState` into a `useRef` (mutable, not render state) owned by the chat hook. The throttle/debounce is hand-rolled — keep exact 1800/3500 numbers. `notifyTyping(false)` is fired from `submit()` (before send), `oninput` when text empties, and `compositionend`. The component must call notifyTyping on input changes (channel only). On unmount/scope-change, ensure a final `typing:false` is sent and the stopTimer cleared (current `stopPolling` clears the timer and sets `typingState.active=false` but does NOT send a final false — match that: cleanup clears timer + active flag only).

---

## 10. Refresh / polling / SSE stream — lines 3263–3363

### `refreshActiveChat({ renderAfter=true })` — 3263–3284
```
if (!state.user || pollInFlight) return;                 // mutex
keepFocus = !!app.querySelector(".composer textarea:focus")
mode      = activeView==="private"?"private": activeView==="channel"?"channel":""
scopeId   = mode ? scopeIdFor(mode) : ""
before    = mode ? chatSnapshot(mode, scopeId) : ""
pollInFlight = true
try:
  if channel && activeChannelId → await loadChannelMessages()
  else if private → await loadPrivateMessages()
  else return
  changed = mode ? (before !== chatSnapshot(mode, scopeId)) : true
  if (renderAfter && changed):
     if (keepFocus) state._focusComposer = true     // preserve focus across re-render
     render()
catch: // best-effort, swallow
finally: pollInFlight = false
```
- `loadChannelMessages` (3165): `GET /api/channels/{id}/messages` → `state.messages = mergePendingMessages("channel", id, result.messages||[])`, `setAgentStatus("channel", id, result.agent_status)`, `state.typingUsers = result.typing || []`. Guards against channel switching mid-fetch (`if String(activeChannelId)!==channelId return`).
- `loadPrivateMessages` (3174): `Promise.all([GET /api/private-agent/messages, loadPrivateTelegram()])` → `state.privateMessages = mergePendingMessages("private", scopeId, result.messages||[])`, `setAgentStatus("private", scopeId, result.agent_status)`.
- `loadPrivateTelegram` (3183): `GET /api/private-agent/telegram` → `state.privateTelegram`.

### `startPolling()` / `stopPolling()` — 3285–3302
- `startPolling`: if `pollTimer` exists, no-op; else `pollTimer = setInterval(() => refreshActiveChat(), 4000)`. Comment: SSE is primary; poll is a **4s safety net**.
- `stopPolling`: clear interval; `closeScopeStream()`; clear `typingState.stopTimer`; `typingState.active=false`.

### SSE — `currentScopeStreamUrl` / `closeScopeStream` / `syncScopeStream` — 3309–3363
- **URL by view:** channel+activeChannelId → `/api/channels/{activeChannelId}/events`; private → `/api/private-agent/events`; else `null`.
- `closeScopeStream`: clear reconnect timer, `scopeStream.close()`, reset `scopeStream`/`scopeStreamKey` to null.
- `syncScopeStream` (called at the end of every `afterRender`, line 297):
  - Bail if `!state.user` or `EventSource` undefined.
  - `url = currentScopeStreamUrl()`; if null → closeScopeStream + return.
  - **Idempotency:** if `scopeStreamKey===url && scopeStream && readyState !== 2` → return (already connected to this scope).
  - Else closeScopeStream, set `scopeStreamKey=url`, `es = new EventSource(url, {withCredentials:true})`.
  - **`update` event listener:** `if (scopeStream===es) refreshActiveChat()` (guards against a stale stream instance).
  - **`error` listener:** if `scopeStream!==es` ignore. If `es.readyState===2` (CLOSED, terminal): `closeScopeStream()`, then `api("/api/auth/me")` to probe auth:
    - on success: if no reconnect already scheduled, `scopeStreamReconnect = setTimeout(() => { scopeStreamReconnect=null; if (state.user && !document.hidden) syncScopeStream(); }, 3000)`.
    - on failure: do nothing (the `me` call's own 401 handling drops to login via `api()`).
  - `readyState 0` (browser auto-reconnecting) is left alone.

### Event type: only **`"update"`** (a content-free ping that triggers a refresh) plus the standard `"error"`. There is no per-message SSE payload — the stream is a "something changed, re-fetch" signal.

### Wiring (boot + global listeners, 3482–3533)
- `boot()`: `GET /api/auth/me` → `state.user`; `state._focusComposer=true`; `loadInitial()` (`loadChannels`+`loadMentionTargets`, then `loadChannelMessages`); `startPolling()`; `render()`. On failure `state.user=null; stopPolling()`.
- `afterRender` calls `syncScopeStream()` every render (line 297) — this is how the stream re-targets when the user switches channel/view (the URL changes → old stream closed, new opened).
- `visibilitychange` (3504): when hidden → clear pollTimer + closeScopeStream; when visible → `refreshActiveChat(); startPolling(); syncScopeStream()`.
- `pagehide` (3517): `closeScopeStream()`.
- `handleSessionExpired` (3431) / `logout` (3443): `stopPolling()` (which closes the stream).

### Migration notes (critical)
- **EventSource ownership:** put it in a single hook, e.g. `useScopeStream(view, activeChannelId, user)` that returns nothing but manages the connection in a `useEffect` keyed on the computed URL. The effect's cleanup closes the stream — this replaces the imperative `scopeStreamKey===url` idempotency check (the effect only re-runs when the URL dep changes). The `update` handler calls a stable `refreshActiveChat` callback (via ref to avoid stale closure).
- **Self-managed reconnect on `readyState===2`:** EventSource auto-reconnects on transient drops but stops at CLOSED. Keep the auth-probe (`GET /api/auth/me`) + 3000ms delayed reconnect. In React, schedule via a ref'd timeout; clear it in the effect cleanup. Guard reconnect with `state.user && !document.hidden`.
- **Polling safety net:** a `setInterval(4000)` calling `refreshActiveChat`. Implement in a `usePolling` effect; pause on `document.hidden` (visibility listener). Keep the `pollInFlight` mutex (a ref boolean) to prevent overlapping fetches.
- **`renderAfter:false` path** from `postChatMessage` → in React this is just "fetch and merge without an extra forced render"; the snapshot `changed` check becomes "only setState if the merged result differs" to avoid scroll disruption.
- Keep `withCredentials:true` and the exact event name `"update"`.

---

## 11. Render plumbing this section depends on — focus/scroll/IME (lines 268–322)

The legacy code does **full DOM teardown** every `render()` (`app.replaceChildren(...)`) and then restores transient UI state via flags. The React rewrite must reproduce these effects without teardown:

- **`render()`** (268): if `shouldDeferComposerRender()` (composing IME + composer textarea focused) → set `composerState.renderDeferred=true` and skip (prevents teardown mid-IME, which would lose composition). Otherwise capture scroll, replaceChildren, `requestAnimationFrame(afterRender)`.
- **`flushDeferredRender()`** (280): on `compositionend`, if a render was deferred, replay it with `_focusComposer=true`.
- **`captureMessageScroll()`** (305): read `.messages` `{ key:dataset.chatKey, top:scrollTop, bottom: scrollHeight-scrollTop-clientHeight }`.
- **`restoreMessageScroll(msgs, prev)`** (314): if `state._scrollChatToBottom || differentChat || prev.bottom < 32` → jump to bottom (`scrollTop = scrollHeight`); else restore `min(prev.top, maxTop)`. The `bottom < 32` rule = "stay pinned to bottom if the user was already near the bottom" (sticky-scroll). `data-chat-key` distinguishes scopes so switching channels always jumps to bottom.
- **`afterRender(messageScroll)`** (286): restore scroll; reset `_scrollChatToBottom=false`; `autoGrow(textarea,{animate:false})`; if `_focusComposer` → focus textarea + autoGrow + clear flag; `syncActiveAdminPager()`; `syncScopeStream()`.
- **`autoGrow(el)`** (1183): textarea auto-resize, capped at 200px, toggles `is-scrollable` class, with a height-transition animation unless `animate:false`.

### Migration notes (the scroll-jank concern — the whole point of this migration)
- Because React reconciles instead of tearing down, the gross scroll loss should mostly disappear. But you must still implement **sticky-bottom**: keep a `messagesRef`; before the message list updates, record whether the user was within 32px of the bottom (`useLayoutEffect` reading scroll before paint, or a ref updated on scroll); after the list updates (`useLayoutEffect`), if `_scrollChatToBottom` was requested (own send) OR scope changed (compare a `chatKey`) OR user was near bottom → `scrollTop = scrollHeight`; else leave scroll untouched (React preserves it naturally for prepend-free appends, but DOM height changes can still shift it).
- **`data-chat-key`/scope change → always jump to bottom.** Use the `${scopeType}:${scopeId}` key; on key change, force bottom.
- **Composer focus:** replace `_focusComposer` flag with imperative `inputRef.current?.focus()` in effects after send / after channel switch / after attach add / after send-failure restore. Specifically focus on: channel select (line 456), nav to channel/private (495), addDraftFiles (834), composer-file remove (1217), postChatMessage finally (3033), refreshActiveChat when textarea had focus (3276), boot (3525).
- **IME deferral:** with controlled React inputs you generally don't lose IME state on re-render, but the `composing` guard in `submit()`/`oninput`/`notifyTyping` MUST be preserved (track `isComposing` via `onCompositionStart/End` + the native `event.isComposing`). Do not submit or send typing pings mid-composition. The `flushDeferredRender` hack becomes unnecessary if inputs are controlled and uncontrolled-value imperative-set logic is removed — but verify IME on Chinese input since that is the primary UX here.
- **`autoGrow`** → a `useAutoGrow(ref, value)` hook (set height auto→scrollHeight capped 200, toggle `is-scrollable`). Keep the 200px cap and animation-skip-on-mount.

---

## 12. Message / agent renderers consumed by the body (reference)

These belong to a sibling section but are invoked directly by `renderChat`; the chat-shell component will compose them:
- `renderMessage(message)` (871): `<article class="msg msg--{author_type} msg--pending? msg--streaming?">` with avatar (initials or bot icon), `.msg__bubble` → `.msg__meta`(name, pending/streaming badge, time via `formatTime`), `.msg__body`(content, `white-space:pre-wrap`), attachments (`renderMessageAttachments`), kb suggestions chips, and `renderAgentWorkCard` if `metadata.agent_work` has process steps. Reads `message.metadata.local_pending|streaming|knowledge_suggestions|agent_work`.
- `renderAgentActivity(status)` (934) / `renderAgentTyping(status)` (941): active-run UI (work card vs. typing dots line).
- `agentStreamingMessages(status, mode)` (948): synthesizes pseudo-messages from `status.stream_messages[]` + `status.stream_message` so streaming agent text renders as messages (ids `stream-...` or `stream.id`, `author_type:"agent"`, `metadata.streaming`).
- `renderAgentWorkCard(work,{active})` (968): `<details class="agent-work">` with summary + log lines; **reads/writes `state.expandedAgentRuns[runId]`** on summary click (toggle + render). Default open = `active` unless a stored preference exists.
- `renderTypingUsers(users)` (1175): `.typing-line` "…正在输入" + dots (max 3 names joined by `、`).
- `renderComposerFiles(draftKey, files)` (1201): attachment chips with remove buttons (mutates `state.draftFiles[draftKey]`, `_focusComposer=true`, render).

### Migration notes
- `expandedAgentRuns` is per-run UI memory keyed by `runId` — lift to a context/state map so it survives re-render and view switches. Default-open active runs, remember user toggles.
- `agentStreamingMessages` produces ephemeral items whose ids can collide/shift between polls; key them by `stream.id` when present (fallback to the synthesized id) and accept that content updates in place (the streaming `::after` cursor is CSS `.msg--streaming`).

---

## 13. Proposed React component & hook boundaries

```
<ChatView mode>                       // = renderChat; owns composer + message list for a scope
 ├─ <MessageList scopeKey messages agentStatus typingUsers />   // sticky-scroll container (useLayoutEffect)
 │    ├─ <Message />  (×n, incl. optimistic + streaming)
 │    ├─ <AgentActivity /> | <AgentTyping />
 │    └─ <TypingUsers />   (channel)
 └─ <Composer mode scopeId draftKey disabled>
      ├─ <MentionMenu />   (channel only; separate section, controlled via combobox aria)
      ├─ <ComposerFiles />
      └─ textarea (auto-grow, IME-aware)
<TelegramLinkPopover />                // sibling of ChatView in ContentArea (private + expanded)
```

### Hooks / state ownership
- **`ChatContext` / `useChatStore` (reducer or zustand):** owns `messages`, `privateMessages`, `pendingMessages`, `agentStatuses`, `drafts`, `draftFiles`, `typingUsers`, `expandedAgentRuns`. Provides actions: `sendMessage`, `replaceOptimistic`, `removeOptimistic`, `setAgentStatus`, `mergeServerMessages`, `setDraft`, `addDraftFiles`, `removeDraftFile`.
- **`useScopeStream(url, onUpdate)`** — EventSource lifecycle + reconnect (§10). `url` derived from view/channel.
- **`usePolling(enabled, fn, 4000)`** — interval safety net with `pollInFlight` ref + visibility pause.
- **`useTyping(channelId)`** — exposes `notify(isTyping)`; owns `typingState` ref + 1800/3500 timers; sends `POST /typing`.
- **`useStickyScroll(messagesRef, scopeKey, forceBottom)`** — replicates capture/restore (§11) with `useLayoutEffect`.
- **`useAutoGrow(textareaRef, value)`** — replicates `autoGrow`.
- **`useObjectUrls()`** — manage blob url create/revoke tied to optimistic attachment lifecycle (§7).
- Composer drafts/files: keep in store keyed by `draftKey` so they survive scope switches and mount/unmount (legacy keeps them in global `state.drafts`/`draftFiles`).

### Props sketch
- `ChatView`: `{ mode: "channel"|"private" }` (reads scope from context/route).
- `MessageList`: `{ scopeKey, messages, agentStatus, typingUsers }`.
- `Composer`: `{ mode, scopeId, draftKey, disabled, placeholder, onSubmit }`.
- `Message`: `{ message, onToggleAgentRun }`.

---

## 14. Edge cases / empty / loading / error states checklist

- **No channel** (channel mode, no `activeChannelId`): composer disabled, placeholder "选择频道后发送消息", body = empty-state "还没有频道".
- **No chat permission** (`!canChat`): composer disabled, placeholder "当前权限组只能查看内容".
- **Empty conversation** (no messages, no active agent, no error): bot/message empty-states.
- **Agent active**: typing line or work card + streaming messages appended below real messages.
- **Agent terminal error** (`status.state==="error"` with un-persisted reply): inline error activity article.
- **Send failure**: optimistic message removed, draft + files restored, error toast "发送失败", composer refocused.
- **Attachment too large** (>50MB): rejected with toast, others still added.
- **Too many attachments** (>10): truncated to 10 with toast.
- **Scope switch mid-send**: optimistic message stays in `pendingMessages`, re-merged on return; not shown in the now-active scope.
- **Session expiry (401)**: any `api()` 401 → `handleSessionExpired` → stop polling/stream, drop to login, toast "会话已过期，请重新登录".
- **SSE terminal close**: auth-probe then delayed reconnect (or login on 401).
- **Tab hidden**: poll + stream paused; resumed + refreshed on visible.
- **IME composition**: no submit, no typing ping, render deferred until `compositionend`.
- **Telegram gateway disabled**: status "管理员尚未启用"; form still rendered (binding may still be attempted — preserve).

---

## 15. A11y inventory (present) & gaps

Present:
- Composer textarea: `aria-label="消息输入框"`; channel mode adds full combobox pattern (`role=combobox`, `aria-haspopup=listbox`, `aria-autocomplete=list`, `aria-controls`, `aria-expanded`, `aria-activedescendant` via mention menu). Mention menu `role=listbox`, options `role=option` + `aria-selected`.
- Buttons have `title` + `aria-label` (attach, send, telegram close/trigger).
- Telegram popover: `role=dialog`, `aria-label`, trigger has `aria-expanded`/`aria-controls` linkage.
- Icons: `aria-hidden="true"`.
- Toasts: `role="status"`.
- Sidebar drawer: `inert` + `aria-hidden` when off-canvas; Escape closes; focus moved into drawer on open.

Gaps to flag (don't silently change behavior):
- Telegram dialog has **no focus trap and no Escape-to-close**.
- Message list / streaming updates are not announced (no `aria-live` region for new messages or agent status).
- `aria-expanded` on the composer is set to the literal string `"false"` at build then toggled imperatively by mention code — ensure React keeps it boolean-synced to mention-menu open state.
- Agent work `<details>`/`<summary>` toggling is hijacked (`preventDefault` + state) — keep keyboard operability (Enter/Space) when reimplementing as controlled disclosure.

---

## 16. Verbatim API surface for this section (do not change)

| METHOD | path | body | response (fields used) |
|---|---|---|---|
| GET | `/api/channels/{channelId}/messages` | — | `{messages[], agent_status, typing[]}` |
| POST | `/api/channels/{channelId}/messages` | JSON `{content}` or multipart (`content`, repeated `files`) | `{user_message, agent_status}` |
| POST | `/api/channels/{channelId}/typing` | JSON `{typing: bool}` | (ignored) |
| GET | `/api/channels/{channelId}/events` (SSE) | — | events: `update` (ping), `error` |
| GET | `/api/private-agent/messages` | — | `{messages[], agent_status}` |
| POST | `/api/private-agent/messages` | JSON `{content}` or multipart (`content`, repeated `files`) | `{user_message, agent_status}` |
| GET | `/api/private-agent/events` (SSE) | — | events: `update`, `error` |
| GET | `/api/private-agent/telegram` | — | `{gateway:{enabled,bot_username}, link:{telegram_user_id,telegram_username}}` |
| PUT | `/api/private-agent/telegram` | JSON `{telegram_user_id, telegram_username}` | (reloaded via GET) |
| DELETE | `/api/private-agent/telegram` | string `"{}"` | (reloaded via GET) |
| GET | `/api/auth/me` | — | `{user}` (used as SSE auth probe + boot) |

All requests via `api()`: `credentials:"include"`; JSON requests get `Content-Type: application/json`; FormData requests send no explicit Content-Type (browser sets multipart boundary). 401 → `handleSessionExpired()`.
