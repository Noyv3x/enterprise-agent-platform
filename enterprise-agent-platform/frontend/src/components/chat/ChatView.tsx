/* <ChatView mode/> — the chat view shell shared by channel and private modes.
   Owns the per-scope derivations
   (scopeId, draftKey, gating, placeholder) and the two component-local render
   tokens used for focus and scroll requests:

   - focusToken: bumped on send, on scope/nav change, on attach-add, and on a
     send-failure restore; <ComposerTextarea> re-focuses on each bump.
   - forceBottomToken: bumped on the user's own send; <MessageList> snaps to bottom.

   It renders <MessageList> + <Composer>. It does NOT mount useRealtime/usePolling —
   those are shell-owned (AppShell) so the stream/poll are not duplicated. */

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { activeChannel, hasPermission, scopeIdFor, scopeTypeFor } from "../../store/selectors";
import { useStore } from "../../store/useStore";
import type { ChatMode } from "../../types";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { ChatPreviewSidebar } from "../preview/ChatPreviewSidebar";
import { ComputerPip } from "../preview/ComputerPip";
import { PersonalAiComposerFocusContext } from "../shell/PersonalAiGuideContext";
import "./chat.css";

export function ChatView({ mode }: { mode: ChatMode }) {
  const { t } = useI18n();
  const scopeId = useStore((state) => scopeIdFor(state, mode));
  const canChat = useStore(
    (state) => hasPermission(state, "chat") && (mode !== "private" || hasPermission(state, "private_agent")),
  );
  const channelName = useStore((state) => activeChannel(state)?.name);
  const mobile = useMediaQuery("(max-width: 800px)");
  const personalAiGuideFocusToken = useContext(PersonalAiComposerFocusContext);
  const lastPersonalAiGuideFocusToken = useRef(personalAiGuideFocusToken);

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

  // The shell token is a one-shot request. Remember the value present at mount
  // so returning to Personal AI later never replays an old request and raises a
  // mobile software keyboard unexpectedly.
  useEffect(() => {
    const changed = personalAiGuideFocusToken !== lastPersonalAiGuideFocusToken.current;
    lastPersonalAiGuideFocusToken.current = personalAiGuideFocusToken;
    if (mode === "private" && changed) bumpFocus();
  }, [bumpFocus, mode, personalAiGuideFocusToken]);

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
      <ComputerPip />
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
