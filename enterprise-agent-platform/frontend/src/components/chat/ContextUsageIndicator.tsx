import {useId,useRef,useState} from "react";
import {Popover} from "antd";
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

/** Compact meter + percent beside the send button; details open in a non-modal popover. Hidden until a completed reply reports usage. */
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
  const content=<div id={contentId} className="w-[min(320px,80vw)]" role="group" aria-label={t("chat.context.title")} onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();close();}}}>
    <p className="m-0 text-[12.5px] leading-[1.55] text-ink-2">{t("chat.context.description")}</p>
    <ContextUsage label={t("chat.context.progressLabel")} usedLabel={t("chat.context.used")} limitLabel={t("chat.context.limit")}
      used={formatNumber(usage.used_tokens)} max={formatNumber(usage.max_tokens)} percent={usage.percent}
      details={usage.estimated?<p>{t("chat.context.estimated")}</p>:undefined}/>
  </div>;
  // Beautiful UI Prompt Bar picker styling: a quiet 28px control with a mini meter and tabular percent.
  return <Popover open={open} onOpenChange={setOpen} trigger="click" placement="topRight" title={t("chat.context.title")} content={content} getPopupContainer={getContainer}>
    <button ref={trigger} type="button"
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 tabular-nums transition-colors duration-150 hover:bg-hover hover:text-ink${open?" bg-hover text-ink":""}`}
      aria-label={t("chat.context.button",{percent:usage.percent})} aria-expanded={open} aria-controls={open?contentId:undefined}
      onKeyDown={event=>{if(event.key==="Escape"&&open){event.preventDefault();event.stopPropagation();close();}}}>
      <span aria-hidden="true" className="relative h-1.5 w-5 overflow-hidden rounded-full bg-line-strong">
        <span className={`absolute inset-y-0 left-0 rounded-full ${usage.percent>=90?"bg-red":usage.percent>=75?"bg-orange":"bg-ink-2"}`} style={{width:`${Math.max(8,usage.percent)}%`}}/>
      </span>
      {t("chat.context.percent",{percent:usage.percent})}
    </button>
  </Popover>;
}
