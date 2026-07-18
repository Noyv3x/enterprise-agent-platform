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
import { useI18n } from "../../i18n";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { activeChannel, hasPermission, scopeIdFor, scopeTypeFor } from "../../store/selectors";
import { useStore } from "../../store/useStore";
import type { ChatMode } from "../../types";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { ChatPreviewSidebar } from "../preview/ChatPreviewSidebar";

export function ChatView({ mode }: { mode: ChatMode }) {
  const { t } = useI18n();
  const scopeId = useStore((state) => scopeIdFor(state, mode));
  const canChat = useStore(
    (state) => hasPermission(state, "chat") && (mode !== "private" || hasPermission(state, "private_agent")),
  );
  const channelName = useStore((state) => activeChannel(state)?.name);
  const mobile = useMediaQuery("(max-width: 800px)");

  const noChannel = mode === "channel" && !scopeId;
  const disabled = noChannel || !canChat;
  const draftKey = `${scopeTypeFor(mode)}:${scopeId}`;
  const previewScope = scopeId
    ? { scope_type: scopeTypeFor(mode), scope_id: scopeId }
    : null;

  const [focusToken, setFocusToken] = useState(0);
  const [forceBottomToken, setForceBottomToken] = useState(0);
  const bumpFocus = useCallback(() => setFocusToken((token) => token + 1), []);
  const bumpForceBottom = useCallback(() => setForceBottomToken((token) => token + 1), []);

  // Keep the desktop shortcut, but never raise the software keyboard merely
  // because a mobile user switched channel or chat mode.
  useEffect(() => {
    if (!mobile) bumpFocus();
  }, [mode, scopeId, mobile, bumpFocus]);

  const placeholder = noChannel
    ? t("chat.composer.noChannel")
    : canChat
      ? mode === "private"
        ? t("chat.composer.privatePlaceholder")
        : t("chat.composer.channelPlaceholder", { channel: channelName || t("nav.channel") })
      : t("chat.composer.readOnly");

  return (
    <ChatPreviewSidebar scope={previewScope} canManageSkills={canChat}>
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
    </ChatPreviewSidebar>
  );
}
