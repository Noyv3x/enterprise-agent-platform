/* <MessageList/> — the scrollable message column (legacy renderChat body, the
   `.messages[data-chat-key]` container + message-body branch, :688-716).

   Sticky-scroll is delegated to useStickyScroll(ref, scopeKey, forceBottomToken):
   it snaps to the bottom on the user's own send (forceBottomToken bump), on a
   scope switch (scopeKey change = the old data-chat-key behavior), or when the
   user was already near the bottom — otherwise it leaves scroll alone. The list
   subscribes to the messages / agent-status / typing slices only, so a composer
   keystroke never re-renders it. */

import { useRef, type ReactNode } from "react";
import { Button } from "antd";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { useI18n, type Translator } from "../../i18n";
import { agentStatusFor, hasPermission, isAgentActive, scopeTypeFor } from "../../store/selectors";
import { useStore } from "../../store/useStore";
import type { AgentStatus, ChatMode, Message, ScopeType, StreamMsg, TypingUser } from "../../types";
import { EmptyState } from "../common/EmptyState";
import { Icon } from "../common/Icon";
import { AgentActivity } from "./AgentActivity";
import { AgentApprovalPrompt } from "./AgentApprovalPrompt";
import { AgentTyping } from "./AgentTyping";
import { AgentWorkCard, hasAgentProcessSteps } from "./AgentWorkCard";
import { MessageBubble } from "./MessageBubble";
import { TypingUsers } from "./TypingUsers";

const EMPTY_TYPING: TypingUser[] = [];

/** Steering starts a new model turn. If a status briefly contains buffers from
 * both turns, render only the newest turn so an obsolete draft never appears
 * beside the consolidated answer. Older servers omit turn fields, in which case
 * the existing segment behavior is preserved. */
function currentTurnStreams(status: AgentStatus): StreamMsg[] {
  const active = status.stream_message?.content ? status.stream_message : null;
  const streams = [
    ...(status.stream_messages || []).filter((stream) => !!stream?.content),
    ...(active ? [active] : []),
  ];
  const hasTurnMetadata = streams.some(
    (stream) => Number.isFinite(stream.turn_index) || !!stream.turn_id,
  );
  // During a rolling transition an active stream can be the first item produced
  // without the fields carried by older buffered segments (or vice versa).
  // Prefer the live buffer instead of hiding it behind partially tagged history.
  if (
    active &&
    hasTurnMetadata &&
    !Number.isFinite(active.turn_index) &&
    !active.turn_id
  ) {
    return [active];
  }
  if (active?.turn_id && !Number.isFinite(active.turn_index)) {
    return streams.filter((stream) => stream.turn_id === active.turn_id);
  }
  const indexed = streams.filter((stream) => Number.isFinite(stream.turn_index));
  if (indexed.length) {
    const newestTurn = Math.max(...indexed.map((stream) => Number(stream.turn_index)));
    return streams.filter((stream) => Number(stream.turn_index) === newestTurn);
  }
  const newestTurnId =
    status.stream_message?.turn_id ||
    [...streams].reverse().find((stream) => !!stream.turn_id)?.turn_id;
  return newestTurnId ? streams.filter((stream) => stream.turn_id === newestTurnId) : streams;
}

/** A finalized stream segment can be narration emitted before a later tool call.
 * Only the current visible live buffer means the Agent has started presenting
 * its answer; tool-start finalization clears this buffer and reopens the card. */
function hasLiveFinalOutput(status: AgentStatus): boolean {
  const stream = status.stream_message;
  return stream?.active !== false && !!stream?.content?.trim();
}

/** Synthesize pseudo-messages from a status's streaming buffers so they render
 *  through <MessageBubble> (legacy agentStreamingMessages, :948-966). */
function agentStreamingMessages(
  status: AgentStatus,
  mode: ChatMode,
  scopeType: ScopeType,
  scopeId: string,
  translate: Translator,
): Message[] {
  const segments = currentTurnStreams(status);
  return segments.map((stream, index) => ({
    id: stream.id || `stream-${status.run_id || status.started_at || "agent"}-${index}`,
    scope_type: scopeType,
    scope_id: scopeId,
    author_type: "agent",
    user_id: null,
    username:
      !stream.username || stream.username === "Private Agent" || stream.username === "Main Agent"
        ? mode === "private"
          ? translate("chat.privateAgent")
          : translate("chat.mainAgent")
        : stream.username,
    content: stream.content || "",
    metadata: { streaming: stream.active !== false, stream_segment: stream.active === false },
    created_at: stream.created_at || status.started_at || Math.floor(Date.now() / 1000),
  }));
}

export function MessageList({
  mode,
  scopeId,
  noChannel,
  forceBottomToken,
}: {
  mode: ChatMode;
  scopeId: string;
  noChannel: boolean;
  forceBottomToken: number;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const scopeType = scopeTypeFor(mode);
  const scopeKey = `${scopeType}:${scopeId}`;

  const messages = useStore((state) => (mode === "private" ? state.privateMessages : state.messages));
  const status = useStore((state) => agentStatusFor(state, mode));
  const typingUsers = useStore((state) => (mode === "channel" ? state.typingUsers : EMPTY_TYPING));
  const canApprove = useStore((state) =>
    mode === "private" ? hasPermission(state, "private_agent") : hasPermission(state, "chat"),
  );
  const currentStreams = status ? currentTurnStreams(status) : [];
  const streamCount = currentStreams.length;
  const contentRevision =
    messages.reduce((total, message) => total + (message.content?.length || 0), 0) +
    currentStreams.reduce((total, stream) => total + (stream.content?.length || 0), 0) +
    (status?.activity || []).reduce(
      (total, step) => total + (step.label?.length || 0) + (step.detail?.length || 0) + (step.line?.length || 0),
      0,
    );
  const { atBottom, unreadCount, scrollToBottom } = useStickyScroll(
    ref,
    scopeKey,
    forceBottomToken,
    messages.length + streamCount,
    contentRevision,
  );

  let body: ReactNode;
  if (noChannel) {
    body = (
      <EmptyState
        icon="hash"
        title={t("chat.empty.noChannelTitle")}
        text={t("chat.empty.noChannelText")}
      />
    );
  } else if (!messages.length && !isAgentActive(status) && status?.state !== "error") {
    body =
      mode === "private" ? (
        <EmptyState icon="bot" title={t("chat.empty.privateTitle")} text={t("chat.empty.privateText")} />
      ) : (
        <EmptyState
          icon="message"
          title={t("chat.empty.channelTitle")}
          text={t("chat.empty.channelText")}
        />
      );
  } else {
    const items: ReactNode[] = messages.map((message) => (
      <MessageBubble key={String(message.id)} message={message} />
    ));
    if (isAgentActive(status) && status) {
      items.push(
        hasAgentProcessSteps(status) ? (
          <AgentActivity
            key="agent-activity"
            status={status}
            finalOutputStarted={hasLiveFinalOutput(status)}
          />
        ) : (
          <AgentTyping key="agent-typing" status={status} />
        ),
      );
      if (status.approval && canApprove) {
        items.push(
          <AgentApprovalPrompt
            approval={status.approval}
            key="agent-approval"
            mode={mode}
            scopeId={scopeId}
          />,
        );
      }
      for (const streamingMessage of agentStreamingMessages(status, mode, scopeType, scopeId, t)) {
        items.push(<MessageBubble key={String(streamingMessage.id)} message={streamingMessage} />);
      }
    } else if (status && status.state === "error") {
      // Terminal failure that could not be persisted as a chat message: surface it
      // inline rather than rendering nothing (legacy :703-709).
      if (hasAgentProcessSteps(status)) {
        items.push(
          <article key="agent-error" className="msg msg--agent msg--activity">
            <div className="msg__avatar">
              <Icon name="bot" size={18} />
            </div>
            <AgentWorkCard work={status} active={false} />
          </article>,
        );
      } else {
        const detail =
          status.last_error ||
          [...(status.activity || [])].reverse().find((step) => step.stage === "error")?.detail ||
          "";
        items.push(
          <article key="agent-error" className="msg msg--agent">
            <div className="msg__avatar">
              <Icon name="bot" size={18} />
            </div>
            <div className="msg__bubble" role="alert">
              <div className="msg__body">
                <strong>{t("chat.agent.replyFailed")}</strong>
                {detail ? <p>{detail}</p> : null}
              </div>
            </div>
          </article>,
        );
      }
    }
    if (mode === "channel" && typingUsers.length) {
      items.push(<TypingUsers key="typing-users" users={typingUsers} />);
    }
    body = <div className="messages__inner">{items}</div>;
  }

  return (
    <div className="message-pane">
      <div
        className="messages"
        data-chat-key={scopeKey}
        ref={ref}
        role="log"
        aria-label={mode === "private" ? t("chat.log.privateLabel") : t("chat.log.channelLabel")}
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={isAgentActive(status)}
        tabIndex={0}
      >
        {body}
      </div>
      {!atBottom ? (
        <Button className="scroll-latest" onClick={scrollToBottom}>
          <span className="scroll-latest__icon" aria-hidden="true">↓</span>
          <span className="scroll-latest__label">
            {unreadCount
              ? t("chat.scroll.newMessages", { count: unreadCount })
              : t("chat.scroll.toBottom")}
          </span>
        </Button>
      ) : null}
    </div>
  );
}
