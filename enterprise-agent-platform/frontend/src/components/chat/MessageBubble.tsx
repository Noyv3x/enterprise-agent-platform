/* <MessageBubble/> — one user or Agent chat message. React.memo'd and keyed by
   message.id at the list level;
   it re-renders only when a cheap fingerprint (content / streaming / attachments /
   suggestions / agent_work) changes. Optimistic and synthetic streaming messages flow through
   here too (msg--pending / msg--streaming toggle the CSS badges + caret). */

import { Progress } from "antd";
import { memo } from "react";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import { initials } from "../../utils/format";
import { messageFingerprintKey } from "../../utils/fingerprint";
import type { Message } from "../../types";
import { Icon } from "../common/Icon";
import { MessageAttachments } from "../common/MessageAttachments";
import { BrowserWorkPreview } from "../preview/BrowserWorkPreview";
import { useChatPreviewContext } from "../preview/ChatPreviewContext";
import { AgentWorkCard, hasAgentProcessSteps } from "./AgentWorkCard";
import { KnowledgeSuggestions } from "./KnowledgeSuggestions";
import { MessageBody } from "./MessageBody";
import { MessageMeta } from "./MessageMeta";
import { CopyButton } from "./CopyButton";
import { ScheduledTaskMarker } from "./ScheduledTaskMarker";
import { WithdrawMessageButton } from "./WithdrawMessageButton";

interface MessageBubbleProps {
  message: Message;
  browserPreviewAttached?: boolean;
  canWithdraw?: boolean;
  withdrawing?: boolean;
  onWithdraw?: (messageId: Message["id"]) => Promise<void> | void;
}

function MessageBubbleImpl({
  message,
  browserPreviewAttached = false,
  canWithdraw = false,
  withdrawing = false,
  onWithdraw,
}: MessageBubbleProps) {
  const { t } = useI18n();
  const preview = useChatPreviewContext();
  const isUser = message.author_type === "user";
  const suggestions = message.metadata?.knowledge_suggestions || [];
  const agentWork = message.metadata?.agent_work || null;
  const streaming = !!message.metadata?.streaming;
  const pending = !!message.metadata?.local_pending;
  const attachments = message.attachments || [];
  const showWorkCard = !!agentWork && hasAgentProcessSteps(agentWork);
  const previewScopeMatches = Boolean(
    preview?.scope
    && (!message.scope_type || message.scope_type === preview.scope.scope_type)
    && (message.scope_id == null || String(message.scope_id) === String(preview.scope.scope_id)),
  );
  const showBrowserPreview = Boolean(
    browserPreviewAttached
    && showWorkCard
    && previewScopeMatches
    && preview?.browserDrawerOpen === false,
  );
  const scheduledTask = message.metadata?.scheduled_task;
  const upload = message.metadata?.upload;
  const messageActions = message.content || (canWithdraw && onWithdraw) ? (
    <span className="msg__actions">
      {canWithdraw && onWithdraw ? (
        <WithdrawMessageButton
          loading={withdrawing}
          onConfirm={() => onWithdraw(message.id)}
        />
      ) : null}
      {message.content ? <CopyButton value={message.content} kind="message" /> : null}
    </span>
  ) : null;

  if (scheduledTask && message.author_type === "system") {
    return <ScheduledTaskMarker marker={scheduledTask} message={message} />;
  }

  return (
    <article
      className={cx(
        "msg",
        `msg--${message.author_type}`,
        pending && "msg--pending",
        streaming && "msg--streaming",
        showBrowserPreview && "msg--browser-preview",
      )}
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
          action={messageActions}
        />
        {showWorkCard && agentWork ? (
          showBrowserPreview && preview?.scope ? (
            <div className="agent-work-preview-row">
              <AgentWorkCard work={agentWork} active={false} />
              <BrowserWorkPreview
                scope={preview.scope}
                onTakeControl={preview.openBrowserAssist}
              />
            </div>
          ) : <AgentWorkCard work={agentWork} active={false} />
        ) : null}
        {message.content ? <MessageBody content={message.content} /> : null}
        {attachments.length ? <MessageAttachments attachments={attachments} /> : null}
        {pending && upload ? (
          <div className="msg-upload" aria-live="polite">
            <span className="msg-upload__label">
              {t(`chat.upload.${upload.state}`)}
            </span>
            <Progress
              percent={upload.percent}
              size="small"
              status="active"
              aria-label={t("chat.upload.progress", { count: upload.percent })}
            />
          </div>
        ) : null}
        {suggestions.length ? <KnowledgeSuggestions suggestions={suggestions} /> : null}
      </div>
    </article>
  );
}

export const MessageBubble = memo(
  MessageBubbleImpl,
  (prev, next) =>
    messageFingerprintKey(prev.message) === messageFingerprintKey(next.message) &&
    prev.browserPreviewAttached === next.browserPreviewAttached &&
    prev.canWithdraw === next.canWithdraw &&
    prev.withdrawing === next.withdrawing &&
    prev.onWithdraw === next.onWithdraw,
);
