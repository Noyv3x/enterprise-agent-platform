import {useState} from "react";
import { Button } from "../ui/beautiful"
import {useI18n} from "../../i18n";
import type {ContextUsage as ContextUsageModel,Message} from "../../types";
import {formatNumber} from "../../utils/format";
import {Dialog} from "../common/Dialog";
import { ContextUsage,EmptyState } from "../ui/beautiful"
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

export function ContextDetailsDialog({messages}:{messages:readonly Message[]}) {
 const {t}=useI18n();
 const [open,setOpen]=useState(false);
 const usage=latestContextUsage(messages);
 return <><Button aria-haspopup="dialog" aria-expanded={open} aria-controls="context-details-dialog" aria-label={t("chat.context.button")} onClick={()=>setOpen(true)}>{usage?t("chat.context.percent",{percent:usage.percent}):t("chat.context.button")}</Button>
 <Dialog id="context-details-dialog" open={open} onClose={()=>setOpen(false)} title={t("chat.context.title")} description={t("chat.context.description")}>
 {usage?<ContextUsage label={t("chat.context.progressLabel")} usedLabel={t("chat.context.used")} limitLabel={t("chat.context.limit")} used={usage.used_tokens} max={usage.max_tokens} percent={usage.percent} details={<>{t("chat.context.tokens",{used:formatNumber(usage.used_tokens),total:formatNumber(usage.max_tokens)})}{usage.estimated&&<p>{t("chat.context.estimated")}</p>}</>}/>:<EmptyState title={t("chat.context.unavailable")} compact/>}
 </Dialog></>;
}
