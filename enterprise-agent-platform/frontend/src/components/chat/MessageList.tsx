/* <MessageList/> — the scrollable message column (legacy renderChat body, the
   `.messages[data-chat-key]` container + message-body branch, :688-716).

   Sticky-scroll is delegated to useStickyScroll(ref, scopeKey, forceBottomToken):
   it snaps to the bottom on the user's own send (forceBottomToken bump), on a
   scope switch (scopeKey change = the old data-chat-key behavior), or when the
   user was already near the bottom — otherwise it leaves scroll alone. The list
   subscribes to the messages / agent-status / typing slices only, so a composer
   keystroke never re-renders it. */

import { useRef, type ReactNode } from "react";
import { useStickyScroll } from "../../hooks/useStickyScroll";
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

/** Synthesize pseudo-messages from a status's streaming buffers so they render
 *  through <MessageBubble> (legacy agentStreamingMessages, :948-966). */
function agentStreamingMessages(
  status: AgentStatus,
  mode: ChatMode,
  scopeType: ScopeType,
  scopeId: string,
): Message[] {
  const segments: StreamMsg[] = [];
  for (const stream of status.stream_messages || []) {
    if (stream?.content) segments.push(stream);
  }
  const active = status.stream_message || null;
  if (active?.content) segments.push(active);
  return segments.map((stream, index) => ({
    id: stream.id || `stream-${status.run_id || status.started_at || "agent"}-${index}`,
    scope_type: scopeType,
    scope_id: scopeId,
    author_type: "agent",
    user_id: null,
    username: stream.username || (mode === "private" ? "Private Agent" : "Main Agent"),
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
  const ref = useRef<HTMLDivElement>(null);
  const scopeType = scopeTypeFor(mode);
  const scopeKey = `${scopeType}:${scopeId}`;
  useStickyScroll(ref, scopeKey, forceBottomToken);

  const messages = useStore((state) => (mode === "private" ? state.privateMessages : state.messages));
  const status = useStore((state) => agentStatusFor(state, mode));
  const typingUsers = useStore((state) => (mode === "channel" ? state.typingUsers : EMPTY_TYPING));
  const canApprove = useStore((state) =>
    mode === "private" ? hasPermission(state, "private_agent") : hasPermission(state, "chat"),
  );

  let body: ReactNode;
  if (noChannel) {
    body = (
      <EmptyState icon="hash" title="还没有频道" text="在左侧创建一个频道，开始与团队和 Agent 协作。" />
    );
  } else if (!messages.length && !isAgentActive(status) && status?.state !== "error") {
    body =
      mode === "private" ? (
        <EmptyState icon="bot" title="开启你的私人 Agent" text="这是仅你可见的助手。发送第一条消息试试看。" />
      ) : (
        <EmptyState icon="message" title="暂无消息" text="成为第一个在该频道发言的人。需要时 @agent。" />
      );
  } else {
    const items: ReactNode[] = messages.map((message) => (
      <MessageBubble key={String(message.id)} message={message} />
    ));
    if (isAgentActive(status) && status) {
      items.push(
        hasAgentProcessSteps(status) ? (
          <AgentActivity key="agent-activity" status={status} />
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
      for (const streamingMessage of agentStreamingMessages(status, mode, scopeType, scopeId)) {
        items.push(<MessageBubble key={String(streamingMessage.id)} message={streamingMessage} />);
      }
    } else if (status && status.state === "error") {
      // Terminal failure that could not be persisted as a chat message: surface it
      // inline rather than rendering nothing (legacy :703-709).
      items.push(
        <article key="agent-error" className="msg msg--agent msg--activity">
          <div className="msg__avatar">
            <Icon name="bot" size={18} />
          </div>
          <AgentWorkCard work={status} active={false} />
        </article>,
      );
    }
    if (mode === "channel" && typingUsers.length) {
      items.push(<TypingUsers key="typing-users" users={typingUsers} />);
    }
    body = <div className="messages__inner">{items}</div>;
  }

  return (
    <div className="messages" data-chat-key={scopeKey} ref={ref}>
      {body}
    </div>
  );
}
