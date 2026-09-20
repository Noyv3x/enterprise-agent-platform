import {useCallback,useEffect,useRef,useState,type ReactNode} from "react";
import {Button} from "antd";
import {useStickyScroll} from "../../hooks/useStickyScroll";
import {loadOlderMessages} from "../../data/loaders";
import {withdrawChannelMessage,navigateToView,selectChannel} from "../../data/chatActions";
import {getApiSessionGeneration} from "../../lib/api";
import {useI18n,type Translator} from "../../i18n";
import {agentStatusFor,hasPermission,isAgentActive,scopeTypeFor} from "../../store/selectors";
import {useStore,useStoreHandle} from "../../store/useStore";
import type {AgentStatus,ChatMode,Message,ScopeType,StreamMsg,TypingUser} from "../../types";
import {ConversationLayout,ConversationEmpty,ConversationJump,Notice} from "../ui/fieldwork";
import {ResourceStatusView} from "../common/ResourceStatusView";
import {AgentActivity} from "./AgentActivity";
import {AgentApprovalPrompt} from "./AgentApprovalPrompt";
import {AgentTyping} from "./AgentTyping";
import {AgentWorkCard,hasAgentProcessSteps} from "./AgentWorkCard";
import {MessageBubble} from "./MessageBubble";
import {TypingUsers} from "./TypingUsers";
const EMPTY_TYPING:TypingUser[]=[];
function currentTurnStreams(status: AgentStatus): StreamMsg[] {
  const active = status.stream_message?.content ? status.stream_message : null;
  const commentary = new Set((status.activity || [])
    .filter(step => step.stage === "assistant.message")
    .map(step => (step.detail || step.line || "").trim()).filter(Boolean));
  const streams = [
    ...(status.stream_messages || []).filter(stream => !!stream?.content
      && !(active?.id && stream.id === active.id)
      && !commentary.has(stream.content.trim())),
    ...(active ? [active] : []),
  ];
  const hasTurnMetadata = streams.some(
    (stream) => Number.isFinite(stream.turn_index) || !!stream.turn_id,
  );
  // The active stream can arrive before its turn fields while buffered segments
  // are already tagged. Prefer the live buffer until the snapshot is complete.
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

/** Synthesize pseudo-messages from streaming buffers for <MessageBubble>. */
function agentStreamingMessages(
  status: AgentStatus,
  mode: ChatMode,
  scopeType: ScopeType,
  scopeId: string,
  translate: Translator,
  segments: StreamMsg[],
): Message[] {
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

export function MessageList({mode,scopeId,noChannel,forceBottomToken,header,composer,preview,resourceKey}: {
 mode:ChatMode;scopeId:string;noChannel:boolean;forceBottomToken:number;header?:ReactNode;composer?:ReactNode;preview?:ReactNode;resourceKey?:string;
}) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const ref = useRef<HTMLDivElement>(null);
  const [withdrawingMessageId, setWithdrawingMessageId] = useState<string | null>(null);
  const scopeType = scopeTypeFor(mode);
  const scopeKey = `${scopeType}:${scopeId}`;

  const messages = useStore((state) => (mode === "private" ? state.privateMessages : state.messages));
  const history = useStore((state) => state.messageHistory[scopeKey]);
  const status = useStore((state) => agentStatusFor(state, mode, scopeId));
  const typingUsers = useStore((state) => (mode === "channel" ? state.typingUsers : EMPTY_TYPING));
  const canApprove = useStore((state) =>
    mode === "private" ? hasPermission(state, "private_agent") : hasPermission(state, "chat"),
  );
  const canChat = useStore((state) => hasPermission(state, "chat"));
  const currentUserId = useStore((state) => state.user?.id);
  const resource = useStore(state => resourceKey ? state.resourceStates[resourceKey] : undefined);
  const resetRevision = useStore(state => state.messageSyncCursors[scopeKey]?.resetRevision);
  const announcementOwner = `${getApiSessionGeneration()}:${currentUserId ?? ""}:${scopeKey}`;
  const announcementWatermark = useRef<{owner:string;id:number;prepend:number;reset:typeof resetRevision}|null>(null);
  const [incomingAnnouncement,setIncomingAnnouncement] = useState<{owner:string;id:number;count:number}|null>(null);
  useEffect(() => {
    const previous = announcementWatermark.current;
    const prepend = history?.prependVersion || 0;
    const ready = !noChannel && (!resourceKey || resource?.status === "ready");
    if (!ready) {
      announcementWatermark.current = null;
      setIncomingAnnouncement(null);
      return;
    }
    const baseline = !previous || previous.owner !== announcementOwner || previous.reset !== resetRevision;
    let latest = baseline ? 0 : previous.id;
    let count = 0;
    for (const message of messages) {
      if (message.metadata?.local_pending || message.metadata?.streaming) continue;
      const id = Number(message.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      latest = Math.max(latest,id);
      if (!baseline && previous.prepend === prepend && id > previous.id
        && mode === "channel" && message.author_type === "user"
        && message.user_id != null && currentUserId != null
        && String(message.user_id) !== String(currentUserId)) count += 1;
    }
    announcementWatermark.current = {owner:announcementOwner,id:latest,prepend,reset:resetRevision};
    setIncomingAnnouncement(count ? {owner:announcementOwner,id:latest,count} : null);
  }, [announcementOwner,currentUserId,history?.prependVersion,messages,mode,noChannel,resetRevision,resource?.status,resourceKey]);
  const handleWithdraw = useCallback(
    async (messageId: Message["id"]) => {
      const key = String(messageId);
      setWithdrawingMessageId(key);
      try {
        await withdrawChannelMessage(store, scopeId, messageId);
      } finally {
        setWithdrawingMessageId((current) => (current === key ? null : current));
      }
    },
    [scopeId, store],
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
    history?.prependVersion || 0,
  );

  const active=isAgentActive(status);
  const empty=!messages.length&&!active&&status?.state!=="error";
  const streamMessages=status&&active?agentStreamingMessages(status,mode,scopeType,scopeId,t,currentStreams):[];
  const content=noChannel?<ConversationEmpty title={t("chat.empty.noChannelTitle")} description={t("chat.empty.noAccessibleChannelText")}/>:empty?<ConversationEmpty
    title={mode==="private"?t("chat.empty.privateTitle"):t("chat.empty.channelTitle")}
    description={mode==="private"?t("chat.empty.privateText"):canChat?t("chat.empty.channelText"):t("chat.empty.readOnlyChannelText")}/>:<>
    {history?.hasMore&&<div className="wf-history-action"><Button loading={history.loading} onClick={()=>void loadOlderMessages(store,mode,scopeId).catch(()=>undefined)}>{history.loading?t("chat.history.loading"):history.error?t("chat.history.retry"):t("chat.history.loadOlder")}</Button></div>}
    {messages.map(message=>{
      const canWithdraw=mode==="channel"&&canChat&&message.author_type==="user"&&message.user_id!=null&&currentUserId!=null&&String(message.user_id)===String(currentUserId)&&!message.metadata?.local_pending;
      return <MessageBubble key={String(message.id)} message={message} canWithdraw={canWithdraw} withdrawing={withdrawingMessageId===String(message.id)} hideAuthorName={mode==="private"} onWithdraw={canWithdraw?handleWithdraw:undefined}/>;
    })}
    {active&&status&&<>
      {hasAgentProcessSteps(status)?<AgentActivity status={status}/>:<AgentTyping status={status}/>}
      {status.approval&&canApprove&&<AgentApprovalPrompt approval={status.approval} mode={mode} scopeId={scopeId}/>}
      <div aria-live="polite" aria-relevant="additions text">{streamMessages.map(message=><MessageBubble key={String(message.id)} message={message} hideAuthorName={mode==="private"}/>)}</div>
    </>}
    {!active&&status?.state==="error"&&(hasAgentProcessSteps(status)?<AgentWorkCard work={status} active={false}/>:<Notice tone="danger" title={t("chat.agent.replyFailed")}>{status.last_error||[...(status.activity||[])].reverse().find(step=>step.stage==="error")?.detail}</Notice>)}
    {mode==="channel"&&typingUsers.length>0&&<TypingUsers users={typingUsers}/>}
  </>;
  const jumpLabel=unreadCount?t("chat.scroll.newMessages",{count:unreadCount}):t("chat.scroll.toBottom");
  return <ConversationLayout header={header} threadRef={ref} threadLabel={mode==="private"?t("chat.log.privateLabel"):t("chat.log.channelLabel")}
    floatingActions={!atBottom||preview?<>{!atBottom&&<ConversationJump label={jumpLabel} count={unreadCount} onClick={scrollToBottom}/>}{preview}</>:undefined}
    composer={composer}>
    <div className="wf-sr-only" aria-live="polite" aria-atomic="true" data-message-announcement>
      {incomingAnnouncement?.owner === announcementOwner && <span key={incomingAnnouncement.id}>{t("chat.scroll.newMessages",{count:incomingAnnouncement.count})}</span>}
    </div>
    {resourceKey&&!noChannel?<ResourceStatusView resourceKey={resourceKey} hasData={messages.length>0||!!history} onRetry={()=>void (mode==="private"?navigateToView(store,"private"):selectChannel(store,scopeId))}>{content}</ResourceStatusView>:content}
  </ConversationLayout>;
}
