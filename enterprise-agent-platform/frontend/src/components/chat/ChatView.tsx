/* <ChatView mode/> — the chat view shell shared by channel + private modes
   (legacy renderChat, legacy-app.js:588-743). Owns the per-scope derivations
   (scopeId, draftKey, gating, placeholder) and the two component-local render
   tokens that replace the legacy _focusComposer / _scrollChatToBottom flags:

   - focusToken: bumped on send, on scope/nav change, on attach-add, and on a
     send-failure restore; <ComposerTextarea> re-focuses on each bump.
   - forceBottomToken: bumped on the user's own send; <MessageList> snaps to bottom.

   It renders <MessageList> + <Composer>. It does NOT mount useRealtime/usePolling —
   those are shell-owned (AppShell) so the stream/poll are not duplicated. */

import { useCallback, useEffect, useState } from "react";
import { activeChannel, hasPermission, scopeIdFor, scopeTypeFor } from "../../store/selectors";
import { useStore } from "../../store/useStore";
import type { ChatMode } from "../../types";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

export function ChatView({ mode }: { mode: ChatMode }) {
  const scopeId = useStore((state) => scopeIdFor(state, mode));
  const canChat = useStore(
    (state) => hasPermission(state, "chat") && (mode !== "private" || hasPermission(state, "private_agent")),
  );
  const channelName = useStore((state) => activeChannel(state)?.name);

  const noChannel = mode === "channel" && !scopeId;
  const disabled = noChannel || !canChat;
  const draftKey = `${scopeTypeFor(mode)}:${scopeId}`;

  const [focusToken, setFocusToken] = useState(0);
  const [forceBottomToken, setForceBottomToken] = useState(0);
  const bumpFocus = useCallback(() => setFocusToken((token) => token + 1), []);
  const bumpForceBottom = useCallback(() => setForceBottomToken((token) => token + 1), []);

  // Re-focus the composer when the scope (channel id / mode) changes — legacy
  // selectChannel / nav set _focusComposer (:456, 495).
  useEffect(() => {
    bumpFocus();
  }, [mode, scopeId, bumpFocus]);

  const placeholder = noChannel
    ? "选择频道后发送消息"
    : canChat
      ? mode === "private"
        ? "给你的私人 Agent 发消息…"
        : `在 #${channelName || "频道"} 发消息，@agent 呼叫 Agent…`
      : "当前权限组只能查看内容";

  return (
    <div className="chat">
      <MessageList mode={mode} scopeId={scopeId} noChannel={noChannel} forceBottomToken={forceBottomToken} />
      <Composer
        mode={mode}
        scopeId={scopeId}
        draftKey={draftKey}
        disabled={disabled}
        placeholder={placeholder}
        focusToken={focusToken}
        onBumpFocus={bumpFocus}
        onBumpForceBottom={bumpForceBottom}
      />
    </div>
  );
}
