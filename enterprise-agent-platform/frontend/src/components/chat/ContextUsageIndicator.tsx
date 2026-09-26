import {useId,useRef,useState} from "react";
import {Button,Popover} from "antd";
import {useI18n} from "../../i18n";
import {useStore} from "../../store/useStore";
import type {ChatMode,ContextUsage as ContextUsageModel,Message} from "../../types";
import {formatNumber} from "../../utils/format";
import {ContextUsage,useFieldworkContainer} from "../ui/fieldwork";

export function latestContextUsage(messages: readonly Message[]): ContextUsageModel | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.author_type !== "agent") continue;
    if (message.metadata?.streaming || message.metadata?.local_pending) continue;
    const candidate = message.metadata?.context_usage;
    const used = Number(candidate?.used_tokens);
    const maximum = Number(candidate?.max_tokens);
    if (!Number.isFinite(used) || used < 0 || !Number.isFinite(maximum) || maximum <= 0) {
      return null;
    }
    return {
      used_tokens: Math.round(used),
      max_tokens: Math.round(maximum),
      percent: Math.max(0, Math.min(100, Math.round((used / maximum) * 100))),
      estimated: !!candidate?.estimated,
    };
  }
  return null;
}

/** Compact ring + percent beside the send button; details open in a non-modal popover. Hidden until a completed reply reports usage. */
export function ContextUsageIndicator({mode}:{mode:ChatMode}) {
  const {t}=useI18n();
  const messages=useStore(state=>mode==="private"?state.privateMessages:state.messages);
  const getContainer=useFieldworkContainer();
  const [open,setOpen]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null);
  const contentId=useId();
  const usage=latestContextUsage(messages);
  if(!usage)return null;
  const close=()=>{setOpen(false);trigger.current?.focus({preventScroll:true});};
  const content=<div id={contentId} className="wf-context-popover" role="group" aria-label={t("chat.context.title")} onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();close();}}}>
    <p className="wf-muted">{t("chat.context.description")}</p>
    <ContextUsage label={t("chat.context.progressLabel")} usedLabel={t("chat.context.used")} limitLabel={t("chat.context.limit")}
      used={formatNumber(usage.used_tokens)} max={formatNumber(usage.max_tokens)} percent={usage.percent}
      details={usage.estimated?<p>{t("chat.context.estimated")}</p>:undefined}/>
  </div>;
  return <Popover open={open} onOpenChange={setOpen} trigger="click" placement="topRight" title={t("chat.context.title")} content={content} getPopupContainer={getContainer}>
    <Button ref={trigger} type="text" size="small" className="wf-context-trigger"
      aria-label={t("chat.context.button",{percent:usage.percent})} aria-expanded={open} aria-controls={open?contentId:undefined}
      onKeyDown={event=>{if(event.key==="Escape"&&open){event.preventDefault();event.stopPropagation();close();}}}>
      {t("chat.context.percent",{percent:usage.percent})}
    </Button>
  </Popover>;
}
