/* <MessageBubble/> — one chat message bubble, user or agent (legacy renderMessage,
   legacy-app.js:871-899). React.memo'd and keyed by message.id at the list level;
   it re-renders only when a cheap fingerprint (content / streaming / attachments /
   suggestions / agent_work) changes — the React replacement for the legacy
   chatSnapshot no-op gate. Optimistic and synthetic streaming messages flow through
   here too (msg--pending / msg--streaming toggle the CSS badges + caret). */

import { memo } from "react";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import { initials } from "../../utils/format";
import { messageFingerprintKey } from "../../utils/fingerprint";
import type { Message } from "../../types";
import { Icon } from "../common/Icon";
import { MessageAttachments } from "../common/MessageAttachments";
import { AgentWorkCard, hasAgentProcessSteps } from "./AgentWorkCard";
import { KnowledgeSuggestions } from "./KnowledgeSuggestions";
import { MessageBody } from "./MessageBody";
import { MessageMeta } from "./MessageMeta";
import { CopyButton } from "./CopyButton";
import { ScheduledTaskMarker } from "./ScheduledTaskMarker";

function MessageBubbleImpl({ message }: { message: Message }) {
  const { t } = useI18n();
  const isUser = message.author_type === "user";
  const suggestions = message.metadata?.knowledge_suggestions || [];
  const agentWork = message.metadata?.agent_work || null;
  const streaming = !!message.metadata?.streaming;
  const pending = !!message.metadata?.local_pending;
  const attachments = message.attachments || [];
  const showWorkCard = !!agentWork && hasAgentProcessSteps(agentWork);
  const scheduledTask = message.metadata?.scheduled_task;

  if (scheduledTask && message.author_type === "system") {
    return <ScheduledTaskMarker marker={scheduledTask} message={message} />;
  }

  return (
    <article
      className={cx("msg", `msg--${message.author_type}`, pending && "msg--pending", streaming && "msg--streaming")}
    >
      {isUser ? (
        <div className="msg__avatar">{initials(message.username || t("chat.you"))}</div>
      ) : (
        <div className="msg__avatar">
          <Icon name="bot" size={18} />
        </div>
      )}
      <div className="msg__bubble">
        <MessageMeta
          message={message}
          isUser={isUser}
          pending={pending}
          streaming={streaming}
          action={message.content ? <CopyButton value={message.content} kind="message" /> : null}
        />
        {message.content ? <MessageBody content={message.content} /> : null}
        {attachments.length ? <MessageAttachments attachments={attachments} /> : null}
        {suggestions.length ? <KnowledgeSuggestions suggestions={suggestions} /> : null}
        {showWorkCard && agentWork ? <AgentWorkCard work={agentWork} active={false} /> : null}
      </div>
    </article>
  );
}

export const MessageBubble = memo(
  MessageBubbleImpl,
  (prev, next) => messageFingerprintKey(prev.message) === messageFingerprintKey(next.message),
);
