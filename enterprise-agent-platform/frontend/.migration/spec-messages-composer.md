# Migration Spec — Messages, Agent Activity, Composer, @Mentions, Attachments

Source: `frontend/src/legacy-app.js` (lines 871–1225 primary; helpers across the
file). Stylesheet: `frontend/src/styles.css`. Target: React 19 + TypeScript,
moving OFF full-teardown (`app.replaceChildren`) rendering.

This section covers the most interaction-heavy surface of the app: the chat
message list (user + agent bubbles), attachment rendering, the agent "work card"
process-step streaming display, the typing indicators, and the entire composer
(textarea auto-grow, @mention popup, file chips, send pipeline). All endpoint
paths, HTTP methods, and payload field names below MUST be preserved verbatim.

---

## 0. Shared context (state, modules, helpers used by this section)

### Global `state` fields read/written by this section
(from `state` object, lines 8–59)
- `state.messages: Message[]` — channel messages for the active channel.
- `state.privateMessages: Message[]` — private-agent messages.
- `state.pendingMessages: Message[]` — optimistic (un-acked) sent messages, across all scopes.
- `state.drafts: Record<draftKey, string>` — per-scope composer text drafts.
- `state.draftFiles: Record<draftKey, File[]>` — per-scope pending attachments (raw `File` objects).
- `state.agentStatuses: { channels: Record<channelId, AgentStatus>, private: AgentStatus | null }`.
- `state.expandedAgentRuns: Record<runId, boolean>` — per-run open/closed state of the `<details>` work card.
- `state.mentionTargets: MentionTarget[]` — candidates for @mention.
- `state.typingUsers: TypingUser[]` — other users typing in the active channel.
- `state.user` — current user (`id`, `username`, `display_name`, `permissions`, `role`, `permission_group`).
- `state.activeChannelId`, `state.activeView` (`"channel" | "private" | "knowledge" | "admin"`).
- `state._focusComposer: boolean` — post-render flag; when true, `afterRender` focuses the composer textarea.
- `state._scrollChatToBottom: boolean` — post-render flag forcing scroll to bottom.
- `state.error: string`.

### Module-level singletons (NOT in `state`) — these are imperative UI machines
- `composerState = { composing: false, renderDeferred: false }` (line 69) — IME composition guard + deferred-render flag.
- `mentionState = { active, selected, options, range, menu, input }` (line 70) — live mention popup machine. Holds DOM refs (`menu`, `input`).
- `typingState = { key, active, lastSent, stopTimer }` (line 68) — typing-notify throttle/debounce machine.
- `localMessageSeq` (line 65) — monotonic counter for optimistic ids.
- Constants: `MAX_ATTACHMENTS_PER_MESSAGE = 10`, `MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024` (50 MB).

### Helper functions referenced (outside primary range but required)
- `h(tag, attrs, children)` (117) — hyperscript. Notable: `class`→className, `text`→textContent, `on*`→addEventListener (lowercased), `href` sanitized via `safeUrl()`, `src`/`xlink:href` sanitized with `allowData:true`, boolean `true`→empty-attr, `false`/`null` attr/child skipped.
- `icon(name, {size, cls, strokeWidth})` (196) — builds inline SVG (24×24, stroke=currentColor, `aria-hidden="true"`). Icons used here: `bot`, `doc`, `download`, `image`, `close`, `paperclip`, `send`, `checkCircle`, `alert`, `hash`, `message`.
- `initials(name)` (2807) — 2-char uppercase initials.
- `formatTime(value)` (2814) — Unix-seconds → `HH:MM` (today) or `M/D HH:MM`.
- `formatFileSize(value)` (2839) — bytes → `B/KB/MB/GB` (B rounded, others 1 decimal).
- `scopeTypeFor(mode)` (2851) — `"private"` or `"channel"`.
- `scopeIdFor(mode, channelId=state.activeChannelId)` (2852) — private → `String(state.user.id)`, channel → `String(channelId)`.
- `composerDraftKey(mode, scopeId)` (2855) — `` `${scopeType}:${scopeId}` `` (e.g. `channel:42`, `private:7`).
- `agentStatusFor(mode, channelId)` (2858), `setAgentStatus` (2862), `isAgentActive(status)` (2867) → `state==="queued"||"replying"`, `agentStatusText(status)` (2870).
- `hasPermission(perm)` (355) → `isAdmin() || permissions.has(perm)`. `isAdmin()` (352).
- `notifyTyping(mode, scopeId, isTyping)` (3037), `sendTypingState` (3054).
- `render()` (268), `afterRender()` (286), `autoGrow()` (1183), `flushDeferredRender()` (280).
- `toast(message, {type, title})` (247).

### Data shapes (inferred from usage)
```
Message {
  id: string|number,
  scope_type: "channel"|"private", scope_id: string,
  author_type: "user"|"agent",
  user_id: number|null, username: string,
  content: string,
  attachments?: Attachment[],
  metadata?: {
    knowledge_suggestions?: { id, title }[],
    agent_work?: AgentWork,
    streaming?: boolean,          // live streaming bubble
    stream_segment?: boolean,     // a finalized streamed segment
    local_pending?: boolean,      // optimistic, not yet acked
  },
  created_at: number,             // unix seconds
}
Attachment {
  id, filename, mime_type, size_bytes, is_image: boolean,
  url, download_url?,
  local_preview?: boolean,        // client-only blob preview
}
AgentStatus / AgentWork {
  run_id?, scope_type?, scope_id?, started_at?,
  state: "queued"|"replying"|"complete"|"error"|...,
  queued_count?: number,
  current_step?: string,
  replying_to?: { id, username, content, created_at },
  activity?: ActivityStep[],
  stream_message?: StreamMsg | null,     // currently-streaming reply
  stream_messages?: StreamMsg[],         // finalized streamed segments
}
ActivityStep { source?, stage, label?, detail?, line?, tool?, tool_status?, emoji?, at }
StreamMsg { id?, content, username?, active?: boolean, created_at?, updated_at? }
MentionTarget { kind: "agent"|"user"|..., handle, label, description? }
TypingUser { user_id, username }
```

---

## 1. `renderMessage(message)` — message bubble (lines 871–899)

**Purpose:** Renders one chat message bubble (user or agent), with meta row,
body, attachments, knowledge-suggestion chips, and (agent only) a completed work
card.

### DOM structure
```
article.msg.msg--{author_type}[.msg--pending][.msg--streaming]
  ├─ div.msg__avatar           // user: text initials(username||"你"); agent: <bot> icon size18
  └─ div.msg__bubble
       ├─ div.msg__meta
       │    ├─ span.msg__name      text = username || (isUser?"你":"Agent")
       │    ├─ span.msg__pending   text="发送中"   (only if local_pending)
       │    ├─ span.msg__pending   text="生成中"   (only if streaming)
       │    └─ span.msg__time      text = formatTime(created_at)
       ├─ div.msg__body            text = content   (only if content truthy)
       ├─ renderMessageAttachments(attachments)   (only if attachments.length)
       ├─ div.msg__suggest         (only if knowledge_suggestions.length)
       │    └─ span.chip × N   [ span.chip__id "kb:{id}", span "{title}" ]
       └─ renderAgentWorkCard(agent_work,{active:false})  (only if agentWork && hasAgentProcessSteps)
```

### Computed/read fields
- `isUser = author_type === "user"`.
- `suggestions = metadata.knowledge_suggestions || []`.
- `agentWork = metadata.agent_work || null`.
- `streaming = !!metadata.streaming`.
- `pending = metadata.local_pending`.
- `attachments = message.attachments || []`.

### Class derivation (important for CSS)
`` `msg msg--${author_type} ${pending?"msg--pending":""} ${streaming?"msg--streaming":""}` ``
- `.msg--user`: right-aligned, reverse flex, accent-soft bubble.
- `.msg--agent .msg__bubble`: transparent, no border (agent text is "bare").
- `.msg--pending`: opacity 0.72.
- `.msg--streaming .msg__body::after`: a blinking caret pseudo-element (animated CSS block, lines 580–590). Migration: keep this purely in CSS; React just toggles the class.

### Notes
- No event handlers on the bubble itself.
- The completed work card only renders when `hasAgentProcessSteps` (i.e. there is ≥1 tool/hermes step). Plain agent text replies have no work card.
- Empty `content` produces no `.msg__body` node — preserve this (otherwise the streaming caret pseudo-element attaches to nothing).

---

## 2. `renderMessageAttachments(attachments)` — attachment chips/thumbnails (901–932)

**Purpose:** Renders each attachment as an image thumbnail link or a file chip
link.

### DOM — image branch (`attachment.is_image`)
```
a.msg-attachment.msg-attachment--image
   href = download_url || url   (sanitized via safeUrl, http/https/blob/...; data: NOT allowed for href)
   target="_blank" rel="noreferrer" title={name}
   ├─ img  src=attachment.url (safeUrl allowData:true → data:/blob: OK)  alt={name}  loading="lazy"
   └─ span.msg-attachment__caption  text = `{name} · {size}`
```

### DOM — file branch
```
a.msg-attachment.msg-attachment--file  href=download_url||url  target=_blank rel=noreferrer title={name}
   ├─ span.msg-attachment__fileicon   [ <doc> icon size18 ]
   ├─ span.msg-attachment__meta
   │    ├─ strong  text={name}
   │    └─ span    text = `{mime_type||"file"} · {size}`
   └─ <download> icon size16
```

- `name = filename || "attachment"`, `size = formatFileSize(size_bytes||0)`.
- Wrapper: `div.msg-attachments` (grid, gap 8px).

### Security/migration note
`safeUrl` is applied by `h()` automatically for `href`/`src`. In React you must
**replicate `safeUrl` manually** (it is NOT free): for `href` use allow-list
`http,https,mailto,tel,blob`; for `img src` additionally allow `data`. A
backend-supplied `javascript:` URL must yield no href/src attribute. Local
optimistic previews use `blob:` URLs (allowed). See `safeUrl` (line 100).

---

## 3. Agent activity / typing / streaming (934–966)

### 3a. `renderAgentActivity(status)` (934–939)
**Purpose:** The live agent bubble shown while the agent works AND has tool/process steps.
```
article.msg.msg--agent.msg--activity
  ├─ div.msg__avatar [ <bot> icon size18 ]
  └─ renderAgentWorkCard(status, { active:true })
```

### 3b. `renderAgentTyping(status)` (941–946)
**Purpose:** Lightweight "Agent 正在处理" line shown while active but no process steps yet.
```
div.typing-line.typing-line--agent
  ├─ span  text = agentStatusText(status) || "Agent 正在处理"
  └─ div.typing__dots [ <i> <i> <i> ]   // 3 blinking dots (CSS animation)
```

### 3c. `agentStreamingMessages(status, mode)` (948–966)
**Purpose:** Converts the agent status's streaming buffers into synthetic
`Message` objects so they can be rendered with `renderMessage`.
- Collects `status.stream_messages[]` where `content` truthy, then appends
  `status.stream_message` (the active one) if it has content.
- Each becomes a Message:
  - `id = stream.id || `stream-${run_id||started_at||"agent"}-${index}``
  - `scope_type/scope_id` via `scopeTypeFor/scopeIdFor(mode)`
  - `author_type="agent"`, `user_id=null`
  - `username = stream.username || (mode==="private"?"Private Agent":"Main Agent")`
  - `content = stream.content || ""`
  - `metadata = { streaming: stream.active !== false, stream_segment: stream.active === false }`
  - `created_at = stream.created_at || status.started_at || now(sec)`
- Note `streaming:true` keeps the blinking caret on the currently-active segment; finalized segments (`active===false`) lose it.

### How the chat list assembles these (from `renderChat`, 695–712)
After mapping `messages.map(renderMessage)`:
1. `status = agentStatusFor(mode)`.
2. If `isAgentActive(status)`: push `hasAgentProcessSteps(status) ? renderAgentActivity(status) : renderAgentTyping(status)`, then push `renderMessage(streamMsg)` for each `agentStreamingMessages(status, mode)`.
3. Else if `status?.state === "error"`: push an inline `article.msg.msg--agent.msg--activity` with `renderAgentWorkCard(status,{active:false})` (terminal failure that couldn't persist as a message).
4. If `mode==="channel" && state.typingUsers.length`: push `renderTypingUsers(state.typingUsers)`.

---

## 4. Agent work card + step formatting (968–1029)

### 4a. `renderAgentWorkCard(work, { active=false })` (968–998)
**Purpose:** Collapsible `<details>` card showing agent progress (active spinner +
current step) or a completed summary, with a per-line tool log.

```
details.agent-work.{agent-work--active|agent-work--complete}  open={expanded}
  ├─ summary.agent-work__summary  onclick=(toggle)
  │    ├─ active: div.typing__dots [<i><i><i>]
  │    │  complete: div.agent-work__done [ icon( state==="error"?"alert":"checkCircle", 15 ) ]
  │    ├─ div.agent-work__main
  │    │    ├─ span.agent-work__title  text={text}
  │    │    └─ span.agent-work__step   text = active ? current : `${processLines.length} 条工作记录`
  │    └─ span.agent-status__queue  text=`另有 ${waiting} 条等待`   (only if waiting>0)
  └─ div.agent-work__log
       └─ div.agent-work__line × N   text={line}
```

**Computed values:**
- `text = active ? (agentStatusText(work) || "Agent 正在处理") : agentWorkTitle(work)`.
- `queuedCount = Number(work.queued_count||0)`.
- `waiting = active ? (work.state==="replying" ? queuedCount : max(0, queuedCount-1)) : 0`.
- `current = work.current_step || (active ? text : "已完成")`.
- `runId = work.run_id || `${scope_type||"agent"}:${scope_id||""}:${started_at||""}``.
- **Expansion logic (KEY):** `hasStored = state.expandedAgentRuns` has own-prop `runId`. `expanded = hasStored ? !!state.expandedAgentRuns[runId] : active`. So active runs default open; completed runs default closed; once the user toggles, the choice persists per-run.
- `processLines = agentProcessLines(work)`; `lines = processLines.length ? processLines : [active ? "等待 Hermes Agent 运行过程" : "本次没有工具调用记录"]`.

**summary onclick handler (981–985):**
```
event.preventDefault();                       // stop native <details> toggle
state.expandedAgentRuns[runId] = !expanded;   // persist the inverse
render();                                      // full re-render
```

### 4b. `agentWorkTitle(work)` (1000–1003)
- `state==="error"` → `"Agent 工作过程失败"`; else `"查看 Agent 工作过程"`.

### 4c. `agentProcessLines(work)` (1005–1008)
- `(work.activity||[]).filter(isAgentProcessStep).map(step => step.line || agentStepLine(step)).filter(Boolean)`.

### 4d. `hasAgentProcessSteps(work)` (1010–1012) — `agentProcessLines(work).length > 0`.

### 4e. `isAgentProcessStep(step)` (1014–1017)
- true if `step.source==="hermes"` OR `stage==="tool"` OR `stage.startsWith("tool.")` OR `!!step.tool`.

### 4f. `agentStepLine(step)` (1019–1029) — emoji-prefixed formatting:
- `tool` → `${emoji||"⚙️"} ${tool||label}${detail?`: "${detail}"`:"..."}`
- `complete` → `✅ ${label}`
- `error` → `⚠️ ${label}${detail?`: ${detail}`:""}`
- `queued` → `⏳ ${label}`
- `replying` → `💬 ${label}`
- default → `• ${label}${detail?`: ${detail}`:""}`
- `label = step.label || step.stage || "处理中"`.

---

## 5. @Mention system (contenteditable-style autocomplete over a `<textarea>`) (1031–1173)

This is the most caret-sensitive subsystem. The textarea is a **plain controlled
`<textarea>`** (not contenteditable); the mention popup is an absolutely
positioned `div.mention-menu[role=listbox]` and is driven imperatively via
`mentionState`. Only active when `mode === "channel"`.

### 5a. `currentMentionRange(input)` (1031–1038)
- `cursor = input.selectionStart ?? input.value.length`.
- `before = value.slice(0, cursor)`.
- Match regex on `before`: `/(^|[\s([{])@([A-Za-z0-9_.-]*)$/`. The `@` must be at start-of-text or preceded by whitespace/`(`/`[`/`{`.
- Returns `null` if no match, else `{ start: before.length - query.length - 1, end: cursor, query: query.toLowerCase() }` where `start` points at the `@`.

### 5b. `mentionOptions(query)` (1040–1048)
- `targets = state.mentionTargets.length ? state.mentionTargets : [{kind:"agent",handle:"agent",label:"Agent",description:"呼叫频道 Agent"}]` (fallback single agent option).
- Filter: haystack = lowercased `${handle} ${label} ${description}`; keep if `!query || haystack.includes(query)`.
- `.slice(0, 8)` — max 8 options.

### 5c. `updateMentionMenu(input, menu, mode)` (1050–1073)
Recomputes & shows/hides the popup. Hide (call `hideMentionMenu(menu)`) when:
- `mode !== "channel"`, OR `input.disabled`, OR `composerState.composing` (IME active), OR no range, OR no options.
Otherwise:
- `previousQuery = mentionState.range?.query`.
- `mentionState.active = true`.
- `mentionState.selected = previousQuery === range.query ? min(selected, options.length-1) : 0` (keep highlight if query unchanged, else reset to 0).
- store `options`, `range`, `menu`, `input` on `mentionState`; call `renderMentionMenu`.

### 5d. `renderMentionMenu(input, menu)` (1075–1109)
- `optionId(i) = `${menu.id||"mention-menu"}-opt-${i}``.
- `menu.replaceChildren(...options.map(...))` — rebuilds option buttons:
```
button.mention-option[.is-active]  type=button role=option id=optionId(i) aria-selected={i===selected}
   onmousedown=(e)=>{ e.preventDefault(); mentionState.selected=i; applyMention(input,menu); }
   onmouseenter=()=>{ mentionState.selected=i; renderMentionMenu(input,menu); }
   ├─ span.mention-option__avatar.mention-option__avatar--{kind||"user"}
   │     text = kind==="agent" ? "A" : initials(label||handle)
   ├─ span.mention-option__main
   │     ├─ span.mention-option__label  text=label||handle
   │     └─ span.mention-option__meta   text=`@${handle}`
   └─ span.mention-option__desc  text=description   (only if description)
```
- `menu.hidden = false`.
- On input: `aria-expanded="true"`; if options: `aria-activedescendant = optionId(selected)`, else remove it.
- **`onmousedown` (not click) + `preventDefault`** is deliberate: it fires before the textarea `blur`, so selecting an option does not first blur/hide the menu. CRITICAL to preserve.

### 5e. `handleMentionKey(event, input, menu, mode, scopeId, draftKey)` (1111–1140)
Called from textarea `onkeydown` BEFORE the Enter-to-send check. Returns `true`
if it consumed the key.
- If `mode!=="channel"` → false.
- If menu not active/owned, call `updateMentionMenu`; if still not active → false.
- If no options → false.
- `ArrowDown` → `selected=(selected+1)%len`, re-render, preventDefault, return true.
- `ArrowUp` → `selected=(selected-1+len)%len`, re-render, true.
- `Enter`/`Tab` → `applyMention(input,menu,scopeId,draftKey)`, preventDefault, true.
- `Escape` → `hideMentionMenu(menu)`, preventDefault, true.
- else false.

### 5f. `applyMention(input, menu, scopeId, draftKey)` (1142–1156)
- `option = mentionState.options[selected]`; `range = mentionState.range || currentMentionRange(input)`. Bail if either missing.
- `insert = `@${option.handle} `` (note trailing space).
- `next = value.slice(0,range.start) + insert + value.slice(range.end)`.
- `cursor = range.start + insert.length`.
- Sets `input.value = next`, `state.drafts[draftKey] = next`.
- `autoGrow(input)`, `notifyTyping("channel", scopeId, next.trim().length>0)`, `hideMentionMenu(menu)`, `input.focus()`, `input.setSelectionRange(cursor, cursor)`.
- Defaults: `scopeId = scopeIdFor("channel")`, `draftKey = composerDraftKey("channel", scopeId)`.

### 5g. `hideMentionMenu(menu)` (1158–1173)
- If `menu`: `menu.hidden=true`, `menu.replaceChildren()`.
- If `mentionState.input` and (no menu OR input's `aria-controls===menu.id`): if input role is combobox set `aria-expanded="false"`; remove `aria-activedescendant`.
- Reset `mentionState`: `active=false, selected=0, options=[], range=null`; clear `menu`/`input` only if `!menu || mentionState.menu===menu`.
- Also called with no args by `handleSessionExpired` (3438).

### Textarea wiring for mentions (from `renderChat`, 610–661)
- `role="combobox"`, `aria-haspopup="listbox"`, `aria-autocomplete="list"`, `aria-controls={mentionMenuId}`, `aria-expanded="false"` — **only for channel mode** (all `null` in private).
- `mentionMenuId = `mention-menu-${scopeType}-${scopeId}``.
- `oninput`: set draft, `autoGrow`, `updateMentionMenu`, typing-notify (unless composing).
- `onfocus`, `onclick`: `updateMentionMenu`.
- `onkeyup`: `updateMentionMenu` unless key ∈ {ArrowDown,ArrowUp,Enter,Tab,Escape}.
- `onblur`: `setTimeout(()=>hideMentionMenu(menu), 120)` — 120ms delay so a mousedown on an option still wins.
- `oncompositionstart`: `composerState.composing=true`, `hideMentionMenu`.
- `oncompositionend`: `composing=false`, sync draft, `autoGrow`, typing-notify, `updateMentionMenu`, `flushDeferredRender`.
- `onkeydown`: `if (!e.isComposing && handleMentionKey(...)) return;` then Enter (no shift, not composing) → preventDefault + submit.

---

## 6. `renderTypingUsers(users)` (1175–1181)
**Purpose:** Channel-only "X 正在输入" indicator from `state.typingUsers`.
```
div.typing-line
  ├─ span  text = `${names || "有人"} 正在输入`   // names = first 3 usernames joined by "、"
  └─ div.typing__dots [ <i> <i> <i> ]
```
- `names = users.map(u=>u.username).filter(Boolean).slice(0,3).join("、")`.

---

## 7. `autoGrow(el, { animate=true })` (1183–1199) — textarea auto-resize
**Purpose:** Resize textarea to fit content up to 200px, with a height
transition animation.
- `previousHeight = el.getBoundingClientRect().height`.
- `el.style.height = "auto"`; `fullHeight = el.scrollHeight`; `nextHeight = min(fullHeight, 200)`.
- Toggle class `is-scrollable` when `fullHeight > nextHeight + 1` (enables `overflow-y:auto`).
- If `!animate` or no previous height or `|prev-next| < 1`: set `height = nextHeight+"px"`, return.
- Else: set `height = previousHeight+"px"`, force reflow via `void el.offsetHeight`, then set `height = nextHeight+"px"` → CSS `transition: height` animates (styles.css line 777).
- Called from: `oninput`, `oncompositionend`, `applyMention`, `submit` (after clear), `afterRender` (`{animate:false}` first, then animated when focusing).

---

## 8. `renderComposerFiles(draftKey, files)` (1201–1223) — pending attachment chips
**Purpose:** Renders the row of selected-but-unsent files with a remove button.
```
div.composer-files
  └─ div.composer-file × N
       ├─ span.composer-file__icon [ icon(file.type?.startsWith("image/")?"image":"doc", 15) ]
       ├─ span.composer-file__name  text = file.name || "attachment"
       ├─ span.composer-file__size  text = formatFileSize(file.size||0)
       └─ button.icon-btn.composer-file__remove  type=button title="移除" aria-label="移除附件"
             onclick=()=>{
               next=[...(state.draftFiles[draftKey]||[])]; next.splice(index,1);
               if (next.length) state.draftFiles[draftKey]=next; else delete state.draftFiles[draftKey];
               state._focusComposer=true; render();
             }
            [ icon("close", 14) ]
```
- `files` here are raw `File` objects (from `state.draftFiles[draftKey]`).

---

## 9. The Composer host (`renderChat` composer portion, 588–743) — required context

Although `renderChat` spans channel/private, the composer is this section's
concern. Structure:
```
div.chat
  ├─ div.messages  data-chat-key=`${scopeType}:${scopeId}`   // scroll container
  │     └─ [body]   // messages__inner OR emptyState
  └─ form.composer  onsubmit=(e)=>{ e.preventDefault(); submit(); }
       └─ div.composer__wrap
            ├─ div.composer__field
            │     ├─ input.composer__file-input (hidden, type=file, multiple, tabindex=-1) onchange→addDraftFiles
            │     ├─ button.icon-btn.composer__attach (type=button, disabled when noChannel||!canChat) onclick→fileInput.click() [paperclip 18]
            │     ├─ <textarea> (the controlled input; see §5 wiring)
            │     ├─ div.mention-menu (role=listbox, id=mentionMenuId, hidden)
            │     └─ button.btn.btn--primary.composer__send (type=submit, disabled when noChannel||!canChat) [send 18]
            ├─ renderComposerFiles(draftKey, selectedFiles)   // only if selectedFiles.length
            └─ div.composer__hint
                  ├─ span.kbd "Enter" + span "发送"
                  └─ span.kbd "Shift+Enter" + span "换行"
```

### Gating (588–594, 610–617, 726, 731)
- `noChannel = mode==="channel" && !state.activeChannelId`.
- `canChat = hasPermission("chat") && (mode!=="private" || hasPermission("private_agent"))`.
- textarea/attach/send `disabled` when `noChannel || !canChat`.
- Placeholder text: noChannel → "选择频道后发送消息"; canChat → private:"给你的私人 Agent 发消息…" / channel:`在 #${channelName} 发消息，@agent 呼叫 Agent…`; else "当前权限组只能查看内容".

### `submit()` (664–686)
1. If `composerState.composing` → return (don't send mid-IME).
2. `content = (state.drafts[draftKey] || input.value).trim()`, `files = state.draftFiles[draftKey] || []`.
3. If `(!content && !files.length) || noChannel || !canChat` → return.
4. Clear: `input.value=""`, `state.drafts[draftKey]=""`, `delete state.draftFiles[draftKey]`, `autoGrow(input)`.
5. `state._focusComposer=true`, `state._scrollChatToBottom=true`, `notifyTyping(mode,scopeId,false)`.
6. `sent = await postChatMessage(mode, scopeId, content, files)`.
7. If `!sent`: **restore** `state.drafts[draftKey]=content`, (if files) `state.draftFiles[draftKey]=files`, `_focusComposer=true`, `render()`.

### File intake helpers
- `addDraftFiles(draftKey, incoming)` (818–837): reject files `> 50MB` (toast "超过 50 MB"); append accepted, slice to 10; if total would exceed 10 → toast "每条消息最多 10 个附件"; set `state.draftFiles[draftKey]`, `_focusComposer=true`, `render()`.
- `clipboardImageFiles(clipboardData)` (839–853): collects image files from paste (`items` then `files`), naming pasted blobs via `namedClipboardImage`.
- `namedClipboardImage(file, index)` (855–869): if no `file.name`, wraps in `new File([...], `pasted-image-${i+1}.${ext}`)` using mime→ext map (png/jpg/gif/webp/bmp; default png).
- textarea `onpaste` (632–637): if clipboard has images, `preventDefault` + `addDraftFiles`.
- fileInput `onchange` (602–607): `Array.from(files)`, reset `event.target.value=""`, `addDraftFiles`.

---

## 10. Send pipeline + optimistic updates (2941–3036) — API contract (PRESERVE EXACTLY)

### `postChatMessage(mode, scopeId, content, files=[])` (3006–3036)
1. `pending = appendOptimisticMessage(...)` then `render()` (immediate optimistic bubble).
2. Build request:
   - With files: `FormData` — `form.append("content", content)`; for each file `form.append("files", file, file.name)`. Request `{ method:"POST", body: form }` (no Content-Type header — browser sets multipart boundary; `api()` detects `FormData` and omits JSON header, line 74–77).
   - Without files: `{ method:"POST", body: JSON.stringify({ content }) }`.
3. **Endpoint:**
   - private → **`POST /api/private-agent/messages`**
   - channel → **`POST /api/channels/${scopeId}/messages`** (`scopeId` = channel id)
4. On success: `result.user_message` and `result.agent_status`:
   - `replaceOptimisticMessage(mode, scopeId, pending.id, result.user_message)`.
   - `setAgentStatus(mode, scopeId, result.agent_status)`.
   - `await refreshActiveChat({ renderAfter:false })`.
   - return `true`.
5. On error: `removeOptimisticMessage(...)`, `state.error=msg`, `toast(msg,{type:"error",title:"发送失败"})`, return `false`.
6. `finally`: `state._focusComposer=true`, `render()`.

**Response shape:** `{ user_message: Message, agent_status: AgentStatus }`.

### Optimistic helpers
- `appendOptimisticMessage` (2963–2981): `localMessageSeq+=1`; message `{ id:`tmp-${seq}`, scope_type, scope_id:String(scopeId), author_type:"user", user_id:state.user.id, username:state.user.display_name||username||"你", content, attachments:optimisticAttachments(files), metadata:{local_pending:true}, created_at:now }`. Pushed to `state.pendingMessages` and to `privateMessages` (private) or `messages` (channel, if `activeChannelId===scopeId`).
- `optimisticAttachments(files)` (2941–2955): each → `{ id:`tmp-att-${seq}-${i}`, filename:name, mime_type:type||"application/octet-stream", size_bytes:size, is_image:type.startsWith("image/"), url:URL.createObjectURL(file), download_url:url, local_preview:true }`.
- `replaceOptimisticMessage` (2985–2998): revoke blob URLs of the pending msg, remove temp from `pendingMessages` and the list, append `savedMessage` if not already present.
- `removeOptimisticMessage` (2999–3005) + `revokeAttachmentUrls` (2956–2962): revoke object URLs to avoid leaks.

### `notifyTyping(mode, scopeId, isTyping)` (3037–3063) — channel only
- No-op if `mode!=="channel"` or no `scopeId`.
- key = `channel:${scopeId}`; clears any `stopTimer`.
- If `!isTyping` → `sendTypingState(key,false)`.
- If typing: send `true` only when key changed OR not active OR `now-lastSent > 1800` (throttle ~1.8s); schedule `stopTimer = setTimeout(()=>sendTypingState(key,false), 3500)` (auto-stop after 3.5s).
- `sendTypingState` (3054–3062): **`POST /api/channels/${channelId}/typing`** body `{ typing: isTyping }`, errors swallowed.

### `loadMentionTargets()` (3157–3164)
- **`GET /api/mention-targets`** → `state.mentionTargets = result.targets || []` (on error → `[]`).

---

## 11. Real-time / async behaviors (must be reproduced)

### Deferred render during IME / typing (268–298)
- `render()` checks `shouldDeferComposerRender()` = `composerState.composing && document.activeElement.matches(".composer textarea")`. If true, sets `composerState.renderDeferred=true` and **returns without rendering** (prevents nuking the textarea mid-composition).
- `flushDeferredRender()` (called on `compositionend`) replays the skipped render with `_focusComposer=true`.
- After every real render, `afterRender()`: restores message scroll, `autoGrow(ta,{animate:false})`, focuses composer if `_focusComposer`, then `syncScopeStream()`.

### Scroll preservation (305–322)
- `captureMessageScroll()` reads `.messages` `dataset.chatKey` + scrollTop + distance-from-bottom.
- `restoreMessageScroll()`: jumps to bottom if `_scrollChatToBottom` OR chat changed OR was within 32px of bottom; else restores prior `scrollTop` (clamped). The `data-chat-key` attr (`${scopeType}:${scopeId}`) identifies same-vs-different conversation.

### SSE live stream (3304–3363)
- One `EventSource` per active scope. URL: channel → `/api/channels/${activeChannelId}/events`; private → `/api/private-agent/events`.
- `syncScopeStream()` (called in `afterRender`) opens/keeps the stream; `withCredentials:true`.
- `"update"` event → `refreshActiveChat()` (re-fetch + diff).
- `"error"` with `readyState===2` (CLOSED): close, probe `GET /api/auth/me`; if OK schedule reconnect after `SSE_RECONNECT_MS=3000` (only if `state.user && !document.hidden`); 401 drops to login via `api()`.

### Polling safety net (3285–3302)
- `setInterval(refreshActiveChat, 4000)` low-frequency backstop when SSE unavailable.

### `refreshActiveChat({renderAfter})` (3263–3284)
- Guarded by `pollInFlight`. Captures `keepFocus = !!.composer textarea:focus`. Loads channel/private messages, diffs via `chatSnapshot` (fingerprint of messages + agent status + typing). Only re-renders if changed; if `keepFocus`, sets `_focusComposer`.
- `chatSnapshot`/`messageFingerprint`/`agentStatusFingerprint` (2875–2936): stable JSON used to suppress no-op re-renders. **In React this maps naturally to keyed reconciliation + memoization; the manual diff exists only because of full-teardown rendering.**

### `loadChannelMessages` (3165–3173) / `loadPrivateMessages` (3174–3182)
- channel: **`GET /api/channels/${channelId}/messages`** → `{ messages, agent_status, typing }`. Sets `state.messages = mergePendingMessages("channel",id,result.messages||[])`, `setAgentStatus`, `state.typingUsers = result.typing||[]`.
- private: **`GET /api/private-agent/messages`** (parallel with `loadPrivateTelegram`) → `{ messages, agent_status }`. `state.privateMessages = mergePendingMessages(...)`, `setAgentStatus`.
- `mergePendingMessages` (2937–2940): appends still-pending optimistic messages for this scope after the server list.

---

## 12. Permissions, empty/loading/error states

- **Empty states** (689–694): noChannel → `emptyState("hash","还没有频道",...)`; no messages & no active agent & not error → private:`emptyState("bot","开启你的私人 Agent",...)` / channel:`emptyState("message","暂无消息",...)`.
- **Permission gating:** `canChat` disables the whole composer (textarea + attach + send). Placeholder communicates the reason.
- **Error state:** terminal agent failure renders an inline `msg--activity` work card (state 3 in §3). Send failure → toast + restored draft.
- **No explicit loading spinner** for the message list (optimistic bubble covers send latency).

---

## 13. Accessibility inventory (present + gaps)

Present:
- textarea: `aria-label="消息输入框"`; channel adds `role=combobox`, `aria-haspopup=listbox`, `aria-autocomplete=list`, `aria-controls`, `aria-expanded`, `aria-activedescendant` (live).
- mention menu: `div role=listbox`, options `role=option` + `aria-selected`, stable `id`s for activedescendant.
- buttons: `aria-label` on attach ("添加文件"), send ("发送"), file remove ("移除附件"). `title` tooltips throughout.
- icons: `aria-hidden="true"`.
- toasts: `role="status"`.
- composer hint uses `.kbd` spans (decorative).

Gaps to fix in React:
- No `aria-live` region announcing new messages / agent activity / streaming text. Consider a polite live region for agent status + incoming messages.
- The `<details>`/`<summary>` work card hijacks native toggle via `preventDefault` + manual state; native keyboard expand still works but `aria-expanded` is implicit on summary only. Consider explicit `aria-expanded`.
- Streaming caret is purely visual (no SR announcement).
- Mention options are buttons inside a listbox (acceptable) but `aria-selected` is set as a boolean string by `h()`; ensure React renders `aria-selected={i===selected}`.
- Message bubbles are `<article>` without `aria-label`/headings; author name is a plain span.

---

## 14. React migration plan

### Proposed component tree
```
<ChatView mode>                         // owns scope, drafts, agent status subscription
  <MessageList>                         // scroll container, data-chat-key, scroll mgmt
    <MessageBubble message />           // §1
      <MessageMeta/>
      <MessageBody/>                    // streaming caret via class
      <MessageAttachments attachments/> // §2  -> <ImageAttachment/> | <FileAttachment/>
      <KnowledgeSuggestions/>
      <AgentWorkCard work active=false/>// §4
    <AgentActivity status/>            // §3a (active work card) OR
    <AgentTyping status/>              // §3b
    <StreamingMessage/> (reuse MessageBubble for agentStreamingMessages output)
    <TypingUsers users/>              // §6
  <Composer mode scopeId>             // §9
    <ComposerField>
      <AttachButton/> + hidden <FileInput/>
      <ComposerTextarea/>             // controlled, auto-grow, mention wiring
      <MentionMenu/> (Portal)         // §5
      <SendButton/>
    <ComposerFiles/>                  // §8
    <ComposerHint/>
```

### State placement
- **Context / store** (Zustand/Redux/`useReducer`+context): `messages`, `privateMessages`, `pendingMessages`, `agentStatuses`, `typingUsers`, `mentionTargets`, `expandedAgentRuns`, `user`, `activeView`, `activeChannelId`. These cross components and drive list rendering.
- **Per-`ChatView` local state:** draft text (`drafts[draftKey]`) and draft files (`draftFiles[draftKey]`) can stay in the store keyed by `draftKey` (so a draft survives view switches, as today) but be **read/written through a controlled `value`** rather than imperative `input.value`. Recommend keep `draftFiles` in store (survives navigation today).
- **Refs (not state):** the textarea element ref; the mention menu element ref (for portal positioning + focus management).
- **`composerState`/`typingState`/`mentionState` → hooks:**
  - IME composition → `useRef`/local state in `<ComposerTextarea>` (`onCompositionStart/End`). The deferred-render hack disappears because React won't unmount the textarea on store updates — but you MUST keep the textarea mounted across re-renders (stable key) and use a controlled value, so IME composition is no longer interrupted.
  - typing throttle/debounce → a `useTypingNotifier(channelId)` hook wrapping the 1800ms throttle + 3500ms auto-stop timers (`useRef` for timers).
  - mention machine → `useMention()` hook returning `{ active, options, selected, range, open, move, choose, close }`.

### Hooks usage
- `useAutoGrow(ref, value)` — runs `autoGrow` logic in `useLayoutEffect` on value change (port lines 1183–1199 verbatim, including the reflow-for-animation trick and `is-scrollable` toggle, max 200px). Use `useLayoutEffect` to avoid flicker.
- `useEffect` for SSE: open `EventSource` keyed on `currentScopeStreamUrl()`; cleanup closes it. Reconnect logic preserved. (Replaces `syncScopeStream`/`afterRender` coupling.)
- `useEffect` for polling backstop (4s interval) — or drop if SSE deemed reliable; keep for parity.
- `useMemo` for `agentStreamingMessages`, `agentProcessLines`, derived classNames.
- `useRef` + `useLayoutEffect` for scroll restoration (replace `captureMessageScroll`/`restoreMessageScroll`); keep distance-from-bottom heuristic and `data-chat-key` reset detection.

### Mention menu = Portal
- Render `<MentionMenu>` via `createPortal` OR keep it inside `.composer__field` (CSS positions it `absolute; bottom: calc(100%+8px)` relative to the field — see styles.css 819–832). Simplest faithful port: keep it as a child of the field (relative parent) rather than a body portal, preserving the existing absolute positioning. If using a portal to `document.body`, you must compute `getBoundingClientRect()` of the field to position it — extra work; prefer in-field.
- **Selection must use `onMouseDown` + `e.preventDefault()`** (not onClick) so the textarea keeps focus and the 120ms blur-hide timer never fires before insertion. Preserve this exactly.
- Keyboard nav (ArrowUp/Down wraparound, Enter/Tab insert, Escape close) handled in textarea `onKeyDown` BEFORE the Enter-to-send branch, returning early when consumed.

### Caret / insertion (the trickiest part)
- `applyMention` mutates value and then `setSelectionRange(cursor, cursor)`. In React, after `setDraft(next)`, the DOM value updates on re-render; you must set the caret in a `useLayoutEffect` (or `flushSync` then set selection) AFTER the controlled value is committed, otherwise the caret jumps to the end. Pattern: store a pending caret position in a ref; in `useLayoutEffect` keyed on value, if pending caret set, apply `textarea.setSelectionRange(pos,pos)` and clear it.
- `currentMentionRange` uses `selectionStart`; read it from the ref's DOM node on each keystroke (controlled textarea still exposes live `selectionStart`).

### Send pipeline
- Port `postChatMessage` verbatim into an async action. KEEP: optimistic message (with `blob:` previews via `URL.createObjectURL`), FormData multipart for files (`content` field + repeated `files` field with filename), JSON `{content}` otherwise, exact endpoints, `{user_message, agent_status}` response handling, blob URL revocation in cleanup (use `useEffect` cleanup or revoke on replace). Restore-on-failure behavior (re-populate draft + files) must be preserved.
- `Enter` sends (no shift, not composing, no mention consuming it); `Shift+Enter` newline; form `onSubmit` also calls submit.

### Behaviors that get SIMPLER off full-teardown
- `shouldDeferComposerRender` / `flushDeferredRender` / `renderDeferred` → **delete**; controlled textarea stays mounted, IME unaffected.
- `chatSnapshot`/fingerprint diffing → **delete**; rely on React reconciliation + `React.memo` on `MessageBubble` keyed by `message.id` and a cheap fingerprint (content/streaming/agent_work) for memo equality.
- `_focusComposer` flag → replace with explicit `textareaRef.current?.focus()` calls after send/file-change (or `autoFocus` patterns).
- `expandedAgentRuns[runId]` map stays (controlled `<details>`); use `open` + `onToggle`/onClick with `preventDefault`. Keep per-run persistence and the `active`-default-open / completed-default-closed rule.

### Reconciliation / focus / scroll concerns (call-outs)
1. **Do not remount the textarea** on store updates (stable component identity + key) or you reintroduce the IME bug and lose caret/focus. This is the #1 risk.
2. **Caret after mention insert & after send-clear** — must be programmatically restored post-commit (see above).
3. **Scroll position** — replicate the distance-from-bottom (32px) stick-to-bottom heuristic and same-chat detection via `data-chat-key`; use `useLayoutEffect` so scroll is set before paint.
4. **blob: URL lifecycle** — revoke optimistic-preview object URLs on replace/remove/unmount to avoid leaks (currently `revokeAttachmentUrls`).
5. **`safeUrl` must be reimplemented** for all `href`/`img src` (attachments) — React does not sanitize URLs; a `javascript:`/`data:text/html` href must be dropped.
6. **Mention menu z-index / overflow** — the menu sits above the field; if you portal it, restore positioning; if in-field, ensure `.messages` overflow doesn't clip it (it's in `.composer`, separate from scroll area — fine).
7. **Agent streaming bubbles** are synthetic messages with ids like `stream-...`; give them stable keys so the streaming caret bubble isn't recreated each SSE tick (avoids fl/scroll jank).
