import {memo} from "react";
import { Progress } from "../ui/beautiful"
import {useI18n} from "../../i18n";
import type {Message} from "../../types";
import {messageFingerprintKey} from "../../utils/fingerprint";
import { MessageEntry } from "../ui/beautiful"
import {MessageAttachments} from "../common/MessageAttachments";
import {AgentWorkCard,hasAgentProcessSteps} from "./AgentWorkCard";
import {MessageBody} from "./MessageBody";
import {MessageMeta} from "./MessageMeta";
import {CopyButton} from "./CopyButton";
import {WithdrawMessageButton} from "./WithdrawMessageButton";
import {ScheduledTaskMarker} from "./ScheduledTaskMarker";
interface MessageBubbleProps {message:Message;canWithdraw?:boolean;withdrawing?:boolean;hideAuthorName?:boolean;onWithdraw?:(id:Message["id"])=>Promise<void>|void}
function MessageBubbleImpl({message,canWithdraw=false,withdrawing=false,hideAuthorName=false,onWithdraw}:MessageBubbleProps) {
 const {t}=useI18n();
 const work=message.metadata?.agent_work;
 const pending=!!message.metadata?.local_pending;
 const upload=message.metadata?.upload;
 if(message.author_type==="system"&&message.metadata?.scheduled_task)return <ScheduledTaskMarker message={message} marker={message.metadata.scheduled_task}/>;
 return <MessageEntry kind={message.author_type==="user"?"user":message.author_type==="agent"?"agent":"system"} status={<MessageMeta message={message} isUser={message.author_type==="user"} pending={pending} streaming={!!message.metadata?.streaming} hideAuthorName={hideAuthorName&&message.author_type==="agent"}/>}
 actions={<>{message.content&&<CopyButton value={message.content} kind="message"/>}{canWithdraw&&onWithdraw&&<WithdrawMessageButton loading={withdrawing} onConfirm={()=>onWithdraw(message.id)}/>}</>}
 work={work&&hasAgentProcessSteps(work)?<AgentWorkCard work={work} active={false}/>:undefined}
 attachments={message.attachments?.length?<MessageAttachments attachments={message.attachments}/>:undefined}>
 {message.content&&<MessageBody content={message.content}/>}
 {pending&&upload&&<div role="status"><span>{t(`chat.upload.${upload.state}`)}</span><Progress value={upload.percent} label={t("chat.upload.progress",{count:upload.percent})}/></div>}
 </MessageEntry>;
}
export const MessageBubble=memo(MessageBubbleImpl,(a,b)=>messageFingerprintKey(a.message)===messageFingerprintKey(b.message)&&a.canWithdraw===b.canWithdraw&&a.withdrawing===b.withdrawing&&a.hideAuthorName===b.hideAuthorName&&a.onWithdraw===b.onWithdraw);
