# 00 — Authoritative Migration Plan: legacy-app.js → React 19 + TypeScript

Status: PLAN (implementation-ready). Owner: lead architect.
Targets `frontend/src/legacy-app.js` (3541 lines, custom `h()` hyperscript, full
`app.replaceChildren()` teardown on every state change) → a componentized React 19
+ TypeScript + Vite app.

Hard constraints (do not violate without sign-off):

- **Runtime deps stay `react` + `react-dom` only.** No router, no Zustand/Redux,
  no React Query, no CSS-in-JS runtime, no framer-motion. Use React built-ins
  (Context + `useReducer` + `useSyncExternalStore`) and tiny local utilities.
- **The `api()` network contract is preserved byte-for-byte** — every path,
  method, body shape, header rule, the text-then-`JSON.parse` tolerance, the 401
  hook, the error-message precedence (`error` → `detail` → `请求失败（${status}）`),
  and `skipAuthHandling`. The backend is unchanged.
- **The CSS class contract is preserved** (see `spec-css-design.md` §9). The visual
  refresh happens in the token layer, not by renaming component classes.
- `npm run check` (`tsc --noEmit`) and `npm run build` (`vite build`) must pass at
  the end of every phase.

Source specs (all read): `spec-foundation.md`, `spec-shell-nav.md`,
`spec-chat-view.md`, `spec-messages-composer.md`, `spec-knowledge.md`,
`spec-admin-core.md`, `spec-admin-config.md`, `spec-oauth-utils-data.md`,
`spec-css-design.md`.

---

## 1. Target architecture overview

### 1.1 Rendering model — what replaces the full teardown

The legacy model: one module-level mutable `state`, and every mutation calls
`render()` which does `app.replaceChildren(state.user ? renderShell() : renderLogin())`
then runs `afterRender()` in a `requestAnimationFrame` to re-apply scroll, focus,
the admin pager position, and the SSE stream. **This rebuilds the entire DOM on
every keystroke/poll/SSE tick**, which is the root cause of the scroll-jank,
focus-loss, IME-interruption, and typing-jank hacks (`_focusComposer`,
`_scrollChatToBottom`, `shouldDeferComposerRender`/`flushDeferredRender`,
`captureMessageScroll`/`restoreMessageScroll`, `chatSnapshot` no-op suppression).

In React we keep a single root and let reconciliation do targeted DOM updates.
The hacks map to deterministic, scoped mechanisms:

| Legacy hack | Why it existed | React replacement |
|---|---|---|
| `app.replaceChildren(...)` | no diffing engine | React reconciliation; stable component identity + `key` |
| `chatSnapshot`/`messageFingerprint` no-op gate | suppress needless full re-renders | (a) realtime fetch only `dispatch`es when a cheap fingerprint differs (so identical poll/SSE payloads cause **zero** state change); (b) `React.memo(MessageBubble)` keyed by `message.id` + content/streaming/agent_work fingerprint |
| `shouldDeferComposerRender` + `flushDeferredRender` + `composerState.renderDeferred` | a teardown mid-IME destroyed the textarea and lost composition | the composer textarea is a **stable, never-remounted, controlled** component; sibling message updates don't touch it. We still track `isComposing` via `onCompositionStart/End` + `event.isComposing` so we never submit or send typing pings mid-composition. The defer/flush plumbing is **deleted**. |
| `_scrollChatToBottom` + `captureMessageScroll`/`restoreMessageScroll` | scroll reset by teardown | `useStickyScroll(scrollRef, scopeKey, forceBottomToken)` in `<MessageList>`: a `useLayoutEffect` records "was within 32px of bottom" before commit and, after commit, snaps to bottom iff `forceBottom` (own send) OR `scopeKey` changed OR was-near-bottom; else leaves scroll alone. `scopeKey = \`${scopeType}:${scopeId}\`` (the old `data-chat-key`). |
| `_focusComposer` | focus lost by teardown | a `focusToken: number` owned by `<ChatView>`, bumped on send / nav-to-chat / attach-add / send-failure-restore; `<ComposerTextarea>` runs `useLayoutEffect(() => ref.focus(), [focusToken])`. |
| `afterRender` calling `autoGrow(ta)` every render | textarea height after teardown | `useAutoGrow(ref, value)` (`useLayoutEffect` on value), ports the 200px cap + `is-scrollable` toggle + reflow-for-animation trick verbatim. |
| `afterRender` calling `syncScopeStream()` every render | re-target SSE to active scope | `useRealtime()` effect keyed precisely on `[user?.id, activeView, activeChannelId]`; cleanup closes the stream. No per-render churn. |
| `syncActiveAdminPager()` in `afterRender` | mobile pager scroll-into-view | `useEffect([activeAdminPage, isMobile])` + a ref on the active pager item in `<AdminPager>`. |
| mention caret restore via `input.setSelectionRange` post-build | teardown reset caret | pending-caret ref + `useLayoutEffect` after the controlled value commits (see §1.4 / chat phase). |

Net effect: typing, polling, and SSE updates no longer rebuild the tree or move
the caret/scroll/focus, so the jank hacks become unnecessary; the few genuinely
needed post-commit behaviors (sticky-scroll, focus-after-send, autogrow, mention
caret) become small `useLayoutEffect`s scoped to the one component that owns them.

### 1.2 Component tree

```
<App>                                  # providers + boot gate (main.tsx mounts at #react-root)
  <ThemeProvider>                      # writes <html data-theme>, watches matchMedia
    <ToastProvider>                    # portal viewport into #toast-stack; registers module toast() singleton
      <StoreProvider>                  # creates the useSyncExternalStore store once; provides handle
        <AppGate>                      # boot() effect, global listeners, session lifecycle, <ToastViewport/>
          ├─ (!user) <LoginView/>
          └─ (user)  <AppShell>
                <Sidebar id="app-sidebar" inert?/aria-hidden? when off-canvas>
                  <Brand/>
                  <WorkspaceNav>  <NavItem/> × (channel, [private], knowledge, [admin])
                  <ChannelList>   <ChannelButton/> × n | <EmptyHint/>
                                  <ChannelCreateForm/>          # gated manage_channels
                  <SidebarFoot/>  # user chip + logout
                <Scrim/>                                        # focusable drawer-dismiss <button>
                <MainColumn>
                  <Topbar>
                    <MenuButton/>                               # mobile only
                    <TopbarTitle/>      # useTopbarInfo() selector
                    <TopbarActions>  [<PrivateTelegramTrigger/> if private] <ThemeToggle/>
                  <ContentRouter>       # view-enter animation only when activeView changes
                    ├─ channel  → <ChatView mode="channel"/>
                    ├─ private  → <ChatView mode="private"/>  + <TelegramLinkPopover/> (if expanded)
                    ├─ knowledge→ <KnowledgeView/>
                    └─ admin    → <AdminPanel/>
```

ChatView subtree:
```
<ChatView mode>                         # owns scopeId, draftKey, focusToken, forceBottomToken; mounts useRealtime
  <MessageList scopeKey>                # useStickyScroll; .messages[data-chat-key]
    <MessageBubble/> × n                # React.memo; user/agent/optimistic/streaming
       <MessageMeta/> <MessageBody/> <MessageAttachments/> <KnowledgeSuggestions/> <AgentWorkCard active=false/>
    <AgentActivity/> | <AgentTyping/>   # active run (work card vs dots)
    <MessageBubble/> × streaming        # agentStreamingMessages() synthetic, keyed by stream id
    <TypingUsers/>                       # channel only
  <Composer mode scopeId draftKey disabled>
    <ComposerField>                      # :focus-within ring
      <AttachButton/> + hidden <FileInput/>
      <ComposerTextarea/>                # controlled, IME-aware, useAutoGrow, mention wiring
      <MentionMenu/>                      # channel only; in-field absolute popover (role=listbox)
      <SendButton/>
    <ComposerFiles/>                      # pending attachment chips
    <ComposerHint/>
```

AdminPanel subtree:
```
<AdminPanel>                            # gate: isAdmin
  <AdminPager>  <AdminPagerItem/> + <AdminPageBadge/>   # sticky tabs; scroll-into-view on mobile
  <AdminPageHeader/>
  <AdminPageContent pageId>
     accounts → <AccountManagement> ( <CreateAccountForm/> + <AccountRow/>×n )
     tokens   → <TokenUsageMonitoring> ( <UsageMetricTile/>×8 + <TokenUsageCurve/> + <UsageTable/>×4 )
     messages → <MessageAuditManagement> ( <ChannelAuditCard/> + <PrivateAuditCard/> )
     model    → <OAuthSettings/> + <HermesConfig/>
     telegram → <TelegramAdminConfig/>
     updates  → <AutoUpdateConfig/>
     security → <SecuritySettings/>
     runtime  → <RuntimeSettings/>
     hermes   → <HermesInternalConfig/> ( <ConfigForm yaml/> + <RawYamlForm/> + <ConfigForm env/> )
     cognee   → <CogneeInternalConfig/> ( <ConfigForm env/> )
     secrets  → <SecretsSettings/> ( <SecretRow/>×n )
```

KnowledgeView subtree:
```
<KnowledgeView>
  <KnowledgeCreateCard/>                 # gated manage_knowledge
  <KnowledgeLibraryCard>
     <KnowledgeSearchForm/> <SearchResultNote/>
     <DocumentList>  <DocumentCard/>×n | <EmptyState/>
     <DocumentViewer/>                    # inline panel; focus handoff on open/close
```

Shared atoms (used across views): `<Icon>`, `<Spinner>`, `<Brand>`, `<Field>`,
`<CardHead>`, `<StatusBadge>`, `<EmptyState>`, `<ThemeToggle>`,
`<MessageAttachments>` (chat + audit), `<UsageMetricTile>` (tokens + auto-update),
`<ConfigForm>`/`<ConfigFieldControl>` (hermes + cognee), `<ConfirmDialog>` +
`useConfirm()` (admin deletes).

### 1.3 Mount model

Single React root. `main.tsx` renders `<App/>` into `#react-root`. The legacy
`#app` div and `legacy-app.js` are removed at cutover (Phase 5). The pre-paint
anti-FOUC theme `<script>` in `index.html` stays verbatim (React cannot run
before first paint). `#toast-stack` stays as the **portal target** so the
`aria-live` region identity survives view changes and toasts live outside the app
subtree. During migration a flag in `main.tsx` selects React (`<App/>`) vs the
legacy boot, so each phase is shippable without flipping production (§4).

### 1.4 The five reconciliation hazards (call-outs for implementers)

1. **Never remount the composer textarea.** Stable component identity + a fixed
   `key`; controlled value from store draft. This is the #1 IME/focus risk.
2. **Mention insert + send-clear caret**: after `setDraft(next)`, set the caret in
   a `useLayoutEffect` keyed on value via a pending-caret ref (else caret jumps to
   end). `onMouseDown` + `preventDefault` (NOT `onClick`) on mention options so the
   textarea keeps focus and the 120ms blur-hide never fires first.
3. **Blob URL lifecycle**: `URL.createObjectURL` for optimistic attachment
   previews must be revoked exactly once on replace/remove and on logout. Create
   them in the send action (not in render/`useMemo`); revoke in the same reducer
   transition that drops the temp message; sweep all `pendingMessages` on logout.
4. **`safeUrl` is not free in React**: JSX does not block `javascript:` hrefs.
   Run every backend-supplied `href`/`img src` through `safeUrl` (attachments,
   OAuth links). `href` allow-list `http,https,mailto,tel,blob`; `img src` adds
   `data`.
5. **SSE dedupe**: only re-open the `EventSource` when the scope URL actually
   changes (effect deps), and keep the `readyState===2` auth-probe + 3s reconnect.
   Don't thrash connections on unrelated re-renders.

---

## 2. State & data strategy

### 2.1 Store — typed, Context-provided, selector-subscribed (zero deps)

The legacy global `state` (legacy-app.js:8–59) is the canonical store. We mirror
its field names **exactly** (many call sites are coupled to them), drop the dead
field `sending`, and move the three render-side-effect flags
(`_lastView`, `_focusComposer`, `_scrollChatToBottom`) out of the store into
component-local refs/tokens (they are not render-visible data).

Implementation: a tiny hand-rolled store over `useSyncExternalStore` (≈40 lines,
no dependency), giving Zustand-like **selective subscription** so a keystroke in a
draft doesn't re-render the admin panel:

```ts
// lib/store.ts
export interface Store<S, A> {
  getState(): S;
  dispatch(action: A): void;            // sync reducer dispatch
  subscribe(fn: () => void): () => void;
}
export function createStore<S, A>(reducer:(s:S,a:A)=>S, initial:S): Store<S,A> { /* ref state + listener set */ }

// store/useStore.ts
function useStore<T>(selector:(s:AppState)=>T, isEqual=Object.is): T {
  // useSyncExternalStore(store.subscribe, snapshot); snapshot caches last selected
  // value in a ref and only returns a new reference when !isEqual — prevents tearing
  // and needless re-renders.
}
const useDispatch = () => store.dispatch;
```

`StoreProvider` creates the store once (`useRef`) and provides the handle through
context. The reducer is **composed of slice reducers** so parallel agents never
edit the same file:

```
store/reducer.ts        # combineReducers-style root over the slices below
store/slices/auth.ts    # user, busy, error  (+ derived permissions)
store/slices/chat.ts    # channels, activeView, activeChannelId, messages, privateMessages,
                        #   pendingMessages, agentStatuses, expandedAgentRuns, mentionTargets,
                        #   typingUsers, drafts, draftFiles, privateTelegram, privateTelegramExpanded
store/slices/knowledge.ts # documents, knowledgeSearch, selectedDocument
store/slices/admin.ts   # users, permissionGroups, activeAdminPage, messageAudit, tokenUsage,
                        #   tokenUsageDays, secrets, runtimes, *Config, oauthProviders, oauthFlows, oauthCallbackUrls
store/slices/ui.ts      # sidebarOpen   (busy/error live in auth slice; theme is its own context)
```

`AppState` and the full `Action` discriminated union are declared up front in
`types/state.ts` (Phase 2) with each slice's actions; slice reducers are stubbed
in Phase 2/3 and filled by the owning view phase, so the shared combine point is
stable. Selectors (`activeChannel`, `agentStatusFor`, `scopeIdFor`,
`composerDraftKey`, `isAdmin`, `hasPermission`, `messageAuditState`) live beside
their slice and keep the exact `String()` coercion the legacy uses for id keys.

Why not multiple independent `useReducer` contexts? Cross-slice actions (logout
resets chat + admin + ui; a channel-audit delete refreshes the live channel view)
are far cleaner over one reducer + selective subscription than coordinating N
contexts. Theme and Toast stay separate contexts because they're orthogonal and
imperative.

### 2.2 API client — exact mirror of `api()`

`lib/api.ts` ports the contract verbatim (spec-foundation §2):
`fetch(path, { credentials:"include", headers, ...options })`; `isForm =
body instanceof FormData` (no Content-Type for FormData, else JSON +
`...options.headers`); read `res.text()` then guarded `JSON.parse` → `{}` on
failure; `if (res.status===401 && !options.skipAuthHandling) onSessionExpired()`;
`if (!res.ok) throw new Error(data.error || data.detail || \`请求失败（${res.status}）\`)`;
return parsed `data`. Conventions preserved: GET default, POST empty body uses the
literal string `"{}"` (OAuth start, runtime restart/install, auto-update check),
DELETE always sends a body.

Decoupling for the 401 hook: `api.ts` exposes
`registerSessionExpiredHandler(fn)`; `AppGate` registers the store's
`handleSessionExpired` at boot. This avoids a circular import while keeping the
exact "only if currently logged in" guard. Also in `lib/api.ts`: `safeUrl(value,
{allowData})` (verbatim allow-list) and `downloadJson(payload, filename)` (the
blob-anchor-revoke pattern for OAuth credential export).

A single typed endpoint map (`lib/endpoints.ts`) records every path/method/body so
the data layer can't drift; all 60+ endpoints from the specs are enumerated there
(`/api/auth/*`, `/api/channels[/{id}/{messages,typing,events}]`,
`/api/private-agent/*`, `/api/mention-targets`, `/api/knowledge/*`, `/api/users`,
`/api/permission-groups`, `/api/admin/*`, `/api/system/*`, `/api/settings/*`).

### 2.3 Data layer — typed loader thunks (no React Query)

Every legacy `load*` becomes a typed async thunk in `data/` that calls `api()` and
`dispatch`es a `SET_*` action — it does NOT trigger a manual render (the store
notifies subscribers). One function per endpoint, mirroring the loader→state map
in `spec-oauth-utils-data.md` §5 exactly, including:

- `loadInitial`: `Promise.all([loadChannels, loadMentionTargets])` **then**
  `loadChannelMessages` (ordering matters — `loadChannelMessages` early-returns if
  `!activeChannelId`, which `loadChannels` sets).
- `loadChannelMessages`: keeps the **channel-switch race guard**
  (`if String(activeChannelId)!==channelId return`) and merges pending via
  `mergePendingMessages("channel", id, result.messages)`.
- `loadMentionTargets`: swallows errors → `[]`.
- `loadTokenUsage`: `?days=&limit=200`, re-syncs `tokenUsageDays` from
  `result.window.days`.
- `loadMessageAudit`: conversations before private messages (auto-select depends on
  it).
- Orchestrators `loadSettings`, `loadAdminPanel` as `Promise.all` batches.

Nav switches just set `activeView` and fire the matching loader (legacy
view→loader map preserved). We deliberately do **not** add React Query — the
loaders + store + `useRealtime` invalidation reproduce the behavior with zero new
deps. (If caching/dedupe pain appears later, that's a separate proposal.)

### 2.4 Async lifecycle: `runBusy` (the `withBusy` port)

`runBusy(fn)` is a store action: set `busy=true`, `error=""`; `await fn()`; on
throw set `error` and toast **only if `user`** (no toast on the login screen);
finally `busy=false`. `busy` stays **global** (one in-flight op disables primary
buttons app-wide) — preserve the duality. Buttons read `busy` via a selector.

### 2.5 SSE streaming hook (`useRealtime`)

Owned by `<ChatView>` (or `<AppShell>` for the active scope). One `EventSource`
per active scope:

```ts
useRealtime() {
  const url = currentScopeStreamUrl(view, activeChannelId);  // channel → /api/channels/{id}/events
                                                             // private → /api/private-agent/events ; else null
  useEffect(() => {
    if (!user || !url || typeof EventSource==="undefined") return;
    const es = new EventSource(url, { withCredentials:true });
    es.addEventListener("update", () => refreshRef.current());          // stable ref
    es.addEventListener("error", () => {
      if (es.readyState === 2) {                                        // CLOSED, terminal
        es.close();
        api("/api/auth/me").then(() => {                               // auth probe (NOT skipAuthHandling)
          if (user && !document.hidden) reconnectRef.current =
            setTimeout(() => forceResync(), SSE_RECONNECT_MS);          // 3000ms, once
        }).catch(() => {/* api()'s 401 path already dropped to login */});
      } // readyState 0 → browser auto-reconnects; leave it
    });
    return () => { es.close(); clearTimeout(reconnectRef.current); };
  }, [user?.id, view, activeChannelId, url]);
}
```

`refreshActiveChat` (the `update`-handler + 4s poll target) re-fetches the active
scope's messages and **only dispatches when a cheap fingerprint differs**
(`utils/fingerprint.ts` ports `messageFingerprint`/`agentStatusFingerprint`/
`chatSnapshot`), preserving the no-op suppression that protects scroll/focus.

### 2.6 Polling + visibility

`usePolling`: a `setInterval(refreshActiveChat, 4000)` safety-net effect, gated on
`user` and `!document.hidden`, with a `pollInFlight` `useRef(false)` mutex.
Visibility/pagehide handling (a top-level effect in `AppGate`): hidden → clear
interval + close stream; visible → `refreshActiveChat()` + restart poll + resync
stream; `pagehide` → close stream. This consolidates the legacy
`setupGlobalListeners` visibility/pagehide branches.

### 2.7 Optimistic message reconciliation (`chatActions.sendMessage`)

Ports `postChatMessage` + the optimistic helpers exactly:

1. `appendOptimisticMessage` → temp `id:\`tmp-${seq}\``, `metadata.local_pending`,
   `optimisticAttachments(files)` with `URL.createObjectURL` previews
   (`local_preview:true`); push to `pendingMessages` and to the visible list **only
   if the scope is still active** (cross-scope leak guard). `localMessageSeq` is a
   module counter.
2. Build request: files → `FormData` (`content` + repeated `files` with filename,
   no Content-Type); else JSON `{content}`. POST to
   `/api/channels/{scopeId}/messages` or `/api/private-agent/messages`.
3. On success: `replaceOptimisticMessage(tempId, result.user_message)` —
   revoke temp blob urls, dedupe-guard (`!list.some(id===saved.id)`) because SSE
   may have already inserted it; `setAgentStatus(result.agent_status)`; then
   `refreshActiveChat({renderAfter:false})` (just fetch+merge).
4. On error: `removeOptimisticMessage(tempId)` (revoke urls), toast
   `{title:"发送失败"}`, return false → `<Composer>` restores draft + files and
   re-focuses.
5. Always: bump `focusToken`.

`mergePendingMessages` = server list + still-pending optimistic items for that
scope (a selector), so an optimistic bubble survives between send and the next
server fetch and across scope switches.

### 2.8 Typing indicator (`useTypingNotifier`)

`notifyTyping(isTyping)` — channel-only. `typingState` lives in a `useRef`
(`{key, active, lastSent, stopTimer}`). Keep the **1800ms** throttle and **3500ms**
auto-stop verbatim; `POST /api/channels/{id}/typing {typing}` errors swallowed.
Fire `notify(false)` on submit, on input emptying, and on `compositionend`.
Cleanup clears the timer + `active` flag (matching legacy `stopPolling`, which does
NOT send a final false).

---

## 3. Proposed `src/` file structure

```
src/
  main.tsx                         # mounts <App/> at #react-root (flagged during migration)
  App.tsx                          # provider stack + <AppGate/>
  vite-env.d.ts
  types/
    models.ts                      # User, Channel, Message, Attachment, AgentStatus/Work, ActivityStep,
                                   #   StreamMsg, MentionTarget, TypingUser, Document/FullDocument, KnowledgeHit,
                                   #   Secret, RuntimeRow, TokenUsageReport, OAuthProvider/Flow, PermissionGroup, ...
    api.ts                         # request/response payload types per endpoint
    state.ts                       # AppState, slice State types, Action discriminated union
    index.ts                       # barrel
  lib/
    api.ts                         # api(), safeUrl(), downloadJson(), registerSessionExpiredHandler()
    endpoints.ts                   # typed path/method/body map (the contract)
    store.ts                       # createStore() over useSyncExternalStore
    constants.ts                   # ADMIN_PAGES, THINKING_DEPTH_OPTIONS, FALLBACK_PERMISSION_GROUPS,
                                   #   MAX_ATTACHMENTS_PER_MESSAGE(10), MAX_ATTACHMENT_BYTES(50MB), SSE_RECONNECT_MS(3000)
    cx.ts                          # className join helper
  utils/
    format.ts                      # initials, formatTime, formatTimestamp, formatNumber, shortSha,
                                   #   formatCompactNumber, formatFileSize, unixFromDatetimeLocal
    oauth.ts                       # isOAuthSecret, oauthStatusLabel, oauthProviderErrorText
    composerFiles.ts               # clipboardImageFiles, namedClipboardImage, optimisticAttachments, revokeAttachmentUrls
    fingerprint.ts                 # messageFingerprint, agentStatusFingerprint, chatSnapshot (change-detect only)
    tokenCurve.ts                  # normalizeTokenDailyUsage, tokenUsageDateLabel, curve geometry (640×170, padX26, padY18)
  store/
    StoreProvider.tsx              # creates store once; context for handle
    useStore.ts                    # useStore(selector), useDispatch(), useActions()
    reducer.ts                     # root reducer over slices
    slices/{auth,chat,knowledge,admin,ui}.ts
    selectors.ts                   # activeChannel, agentStatusFor, scopeIdFor, composerDraftKey,
                                   #   permissions(isAdmin/has), topbarInfo, messageAuditState
  data/
    loaders.ts                     # all load* thunks (one per GET endpoint)
    sessionActions.ts              # boot, login, logout, handleSessionExpired, runBusy
    chatActions.ts                 # sendMessage + optimistic lifecycle, notifyTyping, refreshActiveChat
    knowledgeActions.ts            # createDocument, searchKnowledge, openDocument
    adminActions.ts                # account CRUD, token usage, audit delete-ops, config PUTs, oauth flow actions, secrets
  hooks/
    useTheme.ts useToast.ts usePermissions.ts useMediaQuery.ts
    useRealtime.ts usePolling.ts useTypingNotifier.ts
    useAutoGrow.ts useStickyScroll.ts useMention.ts useConfirm.ts
  context/
    ThemeContext.tsx               # data-theme attr + matchMedia + localStorage["eap-theme"]
    ToastContext.tsx               # provider + <ToastViewport/> portal + module toast() singleton
  components/
    common/  Icon.tsx icons.ts Spinner.tsx Brand.tsx Field.tsx CardHead.tsx StatusBadge.tsx
             EmptyState.tsx ThemeToggle.tsx ConfirmDialog.tsx MessageAttachments.tsx UsageMetricTile.tsx
             ConfigForm.tsx ConfigFieldControl.tsx
    auth/    LoginView.tsx
    shell/   AppGate.tsx AppShell.tsx Sidebar.tsx WorkspaceNav.tsx NavItem.tsx ChannelList.tsx
             ChannelCreateForm.tsx SidebarFoot.tsx Scrim.tsx Topbar.tsx TopbarTitle.tsx
             TopbarActions.tsx MenuButton.tsx PrivateTelegramTrigger.tsx ContentRouter.tsx
    chat/    ChatView.tsx MessageList.tsx MessageBubble.tsx MessageMeta.tsx MessageBody.tsx
             KnowledgeSuggestions.tsx AgentWorkCard.tsx AgentActivity.tsx AgentTyping.tsx TypingUsers.tsx
             Composer.tsx ComposerField.tsx ComposerTextarea.tsx MentionMenu.tsx ComposerFiles.tsx
             ComposerHint.tsx AttachButton.tsx SendButton.tsx TelegramLinkPopover.tsx
    knowledge/ KnowledgeView.tsx KnowledgeCreateCard.tsx KnowledgeLibraryCard.tsx KnowledgeSearchForm.tsx
             DocumentList.tsx DocumentCard.tsx DocumentViewer.tsx
    admin/   AdminPanel.tsx AdminPager.tsx AdminPagerItem.tsx AdminPageBadge.tsx AdminPageHeader.tsx AdminPageContent.tsx
             accounts/ AccountManagement.tsx CreateAccountForm.tsx AccountRow.tsx
                       PermissionGroupSelect.tsx ThinkingDepthSelect.tsx AccountModelSelect.tsx
             tokens/   TokenUsageMonitoring.tsx TokenUsageCurve.tsx UsageTable.tsx
             audit/    MessageAuditManagement.tsx ChannelAuditCard.tsx PrivateAuditCard.tsx
                       PrivateConversationItem.tsx AuditMessageRow.tsx
             config/   SecuritySettings.tsx RuntimeSettings.tsx HermesConfig.tsx TelegramAdminConfig.tsx
                       AutoUpdateConfig.tsx HermesInternalConfig.tsx CogneeInternalConfig.tsx RawYamlForm.tsx
             oauth/    OAuthSettings.tsx OAuthProviderCard.tsx CodexOAuthFlow.tsx GrokOAuthFlow.tsx
             secrets/  SecretsSettings.tsx SecretRow.tsx
  styles/
    tokens.css                     # @layer tokens — :root design tokens + light-dark() + new scale tokens (§5)
    base.css                       # @layer base — reset, scrollbars, focus-ring, typography utils
    components.css                 # @layer components — the existing component styles, split by section, class contract preserved
    index.css                      # @layer tokens, base, components, utilities; @import the above (single compiled styles.css)
```

CSS authoring decision: **keep one global stylesheet** (the existing `styles.css`,
refactored into `@layer`-ordered `tokens/base/components` partials imported once),
with React components emitting the **same global class names** via `cx()`. This is
the lowest-risk path that (a) preserves the §9 class contract, (b) lets the visual
refresh be a token-layer edit (§5), and (c) lets parallel agents build views
against a known class vocabulary with no per-component CSS-module coordination.
Genuinely new UI (e.g. `ConfirmDialog`) may use a co-located `*.module.css`. The
Vite build already coalesces all CSS into a single `styles.css` (see
`vite.config.ts` `assetFileNames`), so this satisfies the single-stylesheet build
goal. CSS Modules / vanilla-extract remain a viable later refinement but are NOT
required for the migration.

---

## 4. Ordered, incremental phase plan

Build approach (the migration seam): the legacy app is monolithic (it renders the
whole shell into `#app`), so a strangler split is impractical. Instead, `main.tsx`
gets a **switch**: render `<App/>` at `#react-root` when a flag is set, otherwise
start the legacy app. The flag (`import.meta.env.VITE_REACT_APP === "1"` or
`localStorage["eap-react"]`) defaults **off**, so production keeps running legacy
while every phase ships behind the flag. From Phase 2 on, the React app is
**live-verifiable** in dev via the flag. Phase 5 flips the default and deletes the
legacy file + `#app`.

Every phase ends green on `npm run check` + `npm run build`. Slice action types
and `AppState` are declared once (Phase 2) and slice reducers are stubbed, so the
view phases (4a–4d) only fill their own slice + their own component folder + their
own actions file — **no file conflicts**, enabling parallel agents.

### Phase 0 — Mount seam + CSS layering (foundation prep)
- Deliverables: `main.tsx` flag switch (legacy default); `App.tsx` stub;
  `styles/` split into `@layer`-ordered `tokens.css` + `base.css` +
  `components.css` + `index.css` (no visual change yet — just reorganization);
  `vite-env.d.ts`. Verify legacy is byte-for-byte unchanged with flag off.
- Files: `src/main.tsx`(edit), `src/App.tsx`, `src/vite-env.d.ts`,
  `src/styles/{tokens,base,components,index}.css`.
- Depends on: nothing.

### Phase 1 — Types, constants, utils, API client (no UI, no store)
- Deliverables: all `types/*`; `lib/api.ts` (api + safeUrl + downloadJson +
  session hook), `lib/endpoints.ts`, `lib/constants.ts`, `lib/cx.ts`;
  `utils/{format,oauth,composerFiles,fingerprint,tokenCurve}.ts`. Pure, unit-
  testable. Verify outputs match legacy helpers (esp. `formatFileSize`,
  `initials`, curve geometry, `safeUrl` allow-lists).
- Files: `src/types/*`, `src/lib/{api,endpoints,constants,cx}.ts`,
  `src/utils/{format,oauth,composerFiles,fingerprint,tokenCurve}.ts`.
- Depends on: Phase 0.

### Phase 2 — Store, providers, theme, toast, icons, shared atoms, session lifecycle
- Deliverables: `lib/store.ts`; `store/*` (StoreProvider, useStore, root reducer +
  **stubbed slices** with full `AppState` + Action union typed);
  `store/selectors.ts` (permissions, scope/draft/agent selectors);
  `context/ThemeContext` + `useTheme`; `context/ToastContext` + `<ToastViewport>`
  portal + module `toast()` singleton + `useToast`; `components/common/{Icon,
  icons,Spinner,Brand,Field,CardHead,StatusBadge,EmptyState,ThemeToggle}`;
  `hooks/{usePermissions,useMediaQuery}`; `data/{loaders,sessionActions}.ts`
  (boot/login/logout/handleSessionExpired/runBusy, all `load*` thunks);
  `App.tsx` provider stack + `<AppGate>` (boot effect with StrictMode-safe ref
  guard, global listeners, registers 401 handler). With flag on: app boots, calls
  `/api/auth/me`, toasts work, theme toggles.
- Files: `src/lib/store.ts`, `src/store/**`, `src/context/{ThemeContext,
  ToastContext}.tsx`, `src/components/common/{Icon,Spinner,Brand,Field,CardHead,
  StatusBadge,EmptyState,ThemeToggle}.tsx` + `icons.ts`,
  `src/hooks/{useTheme,useToast,usePermissions,useMediaQuery}.ts`,
  `src/data/{loaders,sessionActions}.ts`, `src/App.tsx`(edit),
  `src/components/shell/AppGate.tsx`.
- Depends on: Phase 1.

### Phase 3 — App shell: Login, Sidebar, Topbar, ContentRouter, realtime/scroll/focus hooks + cross-view shared atoms
- Deliverables: `auth/LoginView`; `shell/{AppShell,Sidebar,WorkspaceNav,NavItem,
  ChannelList,ChannelCreateForm,SidebarFoot,Scrim,Topbar,TopbarTitle,
  TopbarActions,MenuButton,PrivateTelegramTrigger,ContentRouter}`;
  `hooks/{useRealtime,usePolling,useAutoGrow,useStickyScroll,useTypingNotifier,
  useConfirm}`; `data/chatActions.ts` (refreshActiveChat + nav loaders wiring);
  the **shared cross-view atoms** `common/{MessageAttachments,UsageMetricTile,
  ConfigForm,ConfigFieldControl,ConfirmDialog}` (built here so 4a–4d don't
  collide). `ContentRouter` renders placeholders for the four views. Verify:
  login/logout, 401 expiry, nav switching, mobile drawer + focus management +
  inert/aria across the 800px breakpoint, theme toggle, permission view-fallback
  guard, channel create.
- Files: `src/components/auth/LoginView.tsx`,
  `src/components/shell/*.tsx`, `src/hooks/{useRealtime,usePolling,useAutoGrow,
  useStickyScroll,useTypingNotifier,useConfirm}.ts`, `src/data/chatActions.ts`,
  `src/components/common/{MessageAttachments,UsageMetricTile,ConfigForm,
  ConfigFieldControl,ConfirmDialog}.tsx`, `src/store/slices/{auth,chat,ui}.ts`
  (fill nav/sidebar/auth parts).
- Depends on: Phase 2.

> After Phase 3, ContentRouter, the store slices, and shared atoms are stable
> seams. Phases 4a–4d are independent and can be built **in parallel by separate
> agents** — each touches only its own component folder, its own slice file, and
> its own actions file.

### Phase 4a — Chat view (channel + private) [PARALLEL]
- Deliverables: `chat/*` (MessageList + sticky-scroll, MessageBubble memoized,
  MessageMeta/Body, KnowledgeSuggestions, AgentWorkCard/Activity/Typing,
  TypingUsers, Composer + ComposerField/Textarea/Files/Hint, AttachButton,
  SendButton, MentionMenu, TelegramLinkPopover); `hooks/useMention`;
  `data/chatActions.ts` (sendMessage + optimistic lifecycle + notifyTyping — fill
  in); `store/slices/chat.ts` (messages/agent/draft/typing reducers — fill in).
  Verify with **Chinese IME**: typing not interrupted by SSE; caret stable after
  mention insert + send-clear; sticky-bottom; optimistic send/replace/fail-restore;
  attachment caps (10 / 50MB) + paste; blob URL revocation; Telegram link popover.
- Files: `src/components/chat/*.tsx`, `src/hooks/useMention.ts`,
  `src/data/chatActions.ts`(fill), `src/store/slices/chat.ts`(fill).
- Depends on: Phase 3.

### Phase 4b — Knowledge view [PARALLEL]
- Deliverables: `knowledge/*`; `data/knowledgeActions.ts`
  (loadDocuments/create/search/openDocument); `store/slices/knowledge.ts`. Verify:
  list/search/clear, create (manage_knowledge gate, raw payload), inline viewer
  focus handoff, numeric-id guard for "查看正文", text-only `<pre>`.
- Files: `src/components/knowledge/*.tsx`, `src/data/knowledgeActions.ts`,
  `src/store/slices/knowledge.ts`.
- Depends on: Phase 3.

### Phase 4c — Admin core: shell, accounts, token usage, message audit [PARALLEL]
- Deliverables: `admin/{AdminPanel,AdminPager,AdminPagerItem,AdminPageBadge,
  AdminPageHeader,AdminPageContent}`; `admin/accounts/*`; `admin/tokens/*`
  (TokenUsageCurve uses `utils/tokenCurve` geometry); `admin/audit/*`;
  `data/adminActions.ts` (account CRUD: POST `/api/users`, **PUT** `/api/users/{id}`;
  token usage; audit delete-ops via `useConfirm`); `store/slices/admin.ts`
  (accounts/tokens/audit parts). Verify: pager + badges + mobile scroll-into-view,
  account create/edit (self-disable guard, PUT not PATCH), token curve + 4 tables,
  audit delete flows + cascade reloads + confirm dialog parity.
- Files: `src/components/admin/{AdminPanel,AdminPager,AdminPagerItem,
  AdminPageBadge,AdminPageHeader,AdminPageContent}.tsx`,
  `src/components/admin/{accounts,tokens,audit}/*.tsx`,
  `src/data/adminActions.ts`(accounts/tokens/audit parts), `src/store/slices/admin.ts`(those parts).
- Depends on: Phase 3. (Owns the AdminPanel shell; 4d plugs config pages into
  `AdminPageContent` via the page-id switch — coordinate that single switch
  statement, or 4c declares all page slots and 4d fills the config components.)

### Phase 4d — Admin config + OAuth + secrets [PARALLEL]
- Deliverables: `admin/config/*` (Security, Runtime, HermesConfig,
  TelegramAdminConfig, AutoUpdateConfig, HermesInternalConfig, CogneeInternalConfig,
  RawYamlForm — all using shared `<ConfigForm>`); `admin/oauth/*`;
  `admin/secrets/*`; `data/adminActions.ts` (config PUTs, oauth flow actions
  preserving `updateOAuthState` semantics + the literal `"{}"` bodies + per-page
  refetch scopes, secrets PUT); `store/slices/admin.ts` (config/oauth/secrets
  parts). Verify: each config form's exact body (strings for numbers; empty
  secret = keep), `<ConfigForm>` diff/skip rules (changed-only, drop empty
  passwords, env drops empty), OAuth device-code + manual-callback flows + import/
  export, secrets.
- Files: `src/components/admin/{config,oauth,secrets}/*.tsx`,
  `src/data/adminActions.ts`(config/oauth/secrets parts), `src/store/slices/admin.ts`(those parts).
- Depends on: Phase 3 (and the AdminPanel shell from 4c for the page slots).

### Phase 5 — Cutover, design refresh, cleanup
- Deliverables: flip `main.tsx` default to `<App/>`; **remove** `legacy-app.js` and
  the `#app` div from `index.html`; remove the flag; apply the §5 token refresh in
  `styles/tokens.css` (type/space/radius/elevation/motion/z-index tokens, faint-tier
  fix, paper grain, dead-token cleanup); apply opportunistic a11y improvements
  (aria-live on agent status, focus traps for dialogs, labels for inputs);
  full regression pass; `npm run check` + `npm run build` + manual verify of every
  view in light/dark + mobile.
- Files: `src/main.tsx`(edit), `index.html`(edit), delete `src/legacy-app.js`,
  `src/styles/tokens.css`(refresh), targeted component a11y edits.
- Depends on: Phases 4a, 4b, 4c, 4d all complete.

---

## 5. Design direction (refreshed, production-grade — token-driven)

Keep the north star (`spec-css-design.md` §0): warm, editorial, calm; warm paper
surfaces (`#f3efe6` light / `#1c1a17` dark), hazy slate-blue brand `#7080A0` with
light-blue (`--sky`) support, serif display for Latin, sans for CJK, mono for
machine data, dual theme via native `light-dark()`. The palette and theming
mechanism are good — **the refresh sharpens systemic consistency (type, space,
elevation, motion, z-index) via new tokens, so it is a token-layer edit, not a
component rewrite.** Anchors, `light-dark()`, the serif/sans/mono role split, and
the box-shadow-only focus ring (`--ring`, never an outline) are preserved.

Concrete new/changed tokens (add to `styles/tokens.css`):

- **Type scale** (collapse the ~19 ad-hoc sizes incl. all 0.5px steps onto a real
  modular scale): `--text-2xs:11px; --text-xs:12px; --text-sm:13px;
  --text-base:14px; --text-md:15px; --text-lg:17px; --text-xl:19px;
  --text-2xl:22px; --text-3xl:29px`. Weights: `--fw-normal:450; --fw-medium:550;
  --fw-semibold:650; --fw-bold:700` (keep, but verify against `font-synthesis:none`
  variable-font availability). Editorial tracking on display sizes ≥22px:
  `--tracking-display:-0.011em` (slight negative tracking reads more editorial).
- **Spacing** (4px base, replaces the 1–22px grab-bag): `--space-1:4 …
  --space-12:64` (4/8/12/16/20/24/28/32/40/48/56/64) plus dense half-steps
  `--space-0_5:2; --space-1_5:6; --space-2_5:10`. Map existing paddings/gaps to the
  nearest step (no visible redesign, removes the off-rhythm).
- **Radius** (cleaner intentional ladder 8/12/16/20): `--r-xs:8; --r-sm:10;
  --r-md:14; --r-lg:18; --r-pill:999`; add `--r-avatar:10` to route the hardcoded
  8/9px avatar/tile radii through a token.
- **Elevation** (currently shallow/flat): refine the three shadows and add a
  generalized top inset highlight `--elevate-highlight: inset 0 1px 0 hsl(0 0% 100%
  / .14)` applied to cards in light mode (already on `.btn--primary`); add a
  resting `--shadow-card` (≈ current `--shadow-2`) for key panels (knowledge/admin)
  so they sit above nested `--surface-2` boxes — real hierarchy. Push the warm
  ambient tint slightly; keep dark-mode shadows restrained.
- **Motion**: tokenize the expressive curve that's currently copy-pasted —
  `--ease-emphasized: cubic-bezier(.22,1,.36,1)` (entrances/overlays: view-in,
  toast-in, drawer); keep `--t-fast:110ms`/`--t:170ms` (Material curve) for
  micro-hovers; add `--t-slow:240ms` for overlays. Preserve
  `@media (prefers-reduced-motion: reduce)`.
- **Z-index ladder** (promote literals to tokens): `--z-sticky:5;
  --z-overlay-panel:8; --z-popover:10; --z-scrim:20; --z-drawer:30; --z-toast:100`.
- **Text tiers**: fix the `--muted`/`--faint` collapse in light mode (both ~39%
  lightness today). Re-introduce a perceptible `--faint` by shifting hue/chroma
  (slightly warmer, lower-chroma) rather than lightness, keeping AA against
  `--surface`/`--bg`; reserve `--faint` for genuinely small/decorative text and
  guarantee AA on body-secondary `--muted`.
- **Distinctiveness (keep paper/espresso anchors)**: a very subtle paper grain on
  `--bg` (1–2% opacity noise data-URI, gated by `prefers-reduced-data`) to make
  "warm paper" literal; editorial serif section headers with a hairline rule; a
  single confident accent moment (primary + send buttons) — resist spreading accent
  everywhere; bring the under-used `--sky` into link-hover and subtle data-viz for a
  second-color rhythm.
- **Cleanup**: rename the `.btn` scoped `--bg` override to `--btn-bg` (it shadows
  the global surface token — a footgun); remove the dead `--hairline`/`--accent-hover`
  or actually use `--hairline` for translucent dividers. Add an optional
  `@media (prefers-contrast: more)` swapping `--line`→`--line-strong` and bumping
  muted/faint toward ink.

Keep emitting the §9 class contract (`.is-active`, `.is-open`, `.is-linked`,
`.is-leaving`, `.view-enter`, `.usage-table__row` + inline `--usage-cols`, status/
dot/toast variants, etc.) so behavior + stylesheet keep matching.

---

## 6. Risks + open questions (need a human decision)

### Risks
- **IME / composer focus is the #1 risk.** If the textarea is ever remounted by a
  store update, the Chinese-input bug and caret/focus loss return. Enforce stable
  identity + controlled value; verify with a real IME before sign-off.
- **Blob URL leaks.** Optimistic attachment previews must be revoked exactly once
  (replace/remove/logout). StrictMode double-invocation + stale closures make this
  easy to get wrong; create in the action, revoke in the reducer transition.
- **SSE connection thrash / leaks.** Wrong effect deps or missing cleanup →
  duplicate `EventSource` or unclosed streams. Key the effect on the computed URL;
  preserve the `readyState===2` auth-probe + single 3s reconnect; pause on hidden.
- **Selective re-render correctness.** The hand-rolled `useStore` selector must
  cache by reference/equality or it tears or over-renders. Get this right early
  (Phase 2) — everything depends on it.
- **`withBusy` global busy + toast-vs-inline duality.** Easy to regress (no toast
  pre-login; toast post-login; one in-flight op disables app-wide buttons).
- **Payload drift.** Numbers sent as raw strings (security/hermes/auto-update
  ports), the literal `"{}"` POST bodies, channel-create sends the **untrimmed**
  name, DELETEs always send a body, `complete` includes `callback_url`. Any
  "tidying" here breaks the backend contract.
- **Parallel-phase merge points.** `store/reducer.ts`, `types/state.ts`,
  `AdminPageContent` page switch, and shared `common/` atoms are touched by
  multiple phases. Declaring `AppState`/Action union + stubbed slices + all page
  slots up front (Phases 2–3) is the mitigation; agents must not edit each other's
  slice/folder.
- **Single-bundle build assumption.** `vite.config.ts` emits one `app.js` entry +
  `styles.css`. Route-level `React.lazy` would emit `chunk-*.js` referenced from
  the generated `index.html`; if the platform's static serving doesn't serve
  arbitrary chunks, lazy routes break. Plan keeps a **single bundle (no route code
  splitting)** unless verified otherwise.
- **CSS refresh regressions.** Token changes are global; the faint-tier and
  spacing remaps can shift many screens at once. Do the refresh last (Phase 5) and
  diff light/dark + mobile.

### Open questions (decide before/while implementing)
1. **CSS strategy**: confirm "single global stylesheet against the existing class
   contract" (recommended, lowest-risk) vs full CSS-Modules/vanilla-extract
   migration now. The plan assumes the former.
2. **Routing/deep-linking**: legacy has none (`activeView`/`activeAdminPage` are
   state). Keep it that way (no `react-router`, preserves the dep constraint) or is
   URL deep-linking to admin sub-pages now a requirement?
3. **Migration cutover style**: confirm the flag-gated coexistence + final flip
   (recommended) vs a single big-bang PR. Confirm the flag mechanism
   (`VITE_REACT_APP` env vs `localStorage`).
4. **Code splitting**: confirm single-bundle (no `React.lazy`) given the
   `app.js`/`styles.css` static-serving contract — or verify the platform serves
   hashed chunks so admin/knowledge can lazy-load.
5. **A11y improvements vs strict parity**: the specs flag gaps (no focus trap on
   Telegram/doc-viewer/confirm dialogs, no `aria-live` on agent status/new
   messages, native `window.confirm` → custom dialog, unlabeled inputs, no `<main>`
   inert under mobile drawer). Which are in-scope for the migration vs deferred?
   The plan treats them as opportunistic (Phase 5) — confirm.
6. **Confirm dialogs**: replace blocking `window.confirm` (admin deletes) with a
   promise-based `<ConfirmDialog>` keeping exact prompt strings + cancel-is-noop?
   (Recommended; changes focus/UX slightly.)
7. **Per-form vs global `busy`**: legacy `busy` is global (disables all admin
   actions at once). Keep global parity, or move to per-form pending state (nicer
   UX, behavior change)?
8. **`<details>` open-state persistence** (config groups, agent work card):
   legacy resets `<details open>` on every teardown; React can persist per-group/
   per-run open state (an improvement). Confirm we adopt the improvement.
9. **OS theme change**: legacy only re-renders on the mobile breakpoint, not on OS
   `prefers-color-scheme` change when no explicit `data-theme`. React can observe
   it (improvement). Confirm.
10. **Variable-font weights**: `550`/`650` with `font-synthesis:none` may snap to
    500/600 on systems lacking those weights. Accept, or pin to standard weights?
