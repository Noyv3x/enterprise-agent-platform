import {useEffect,useRef,useState} from "react";
import {Tooltip} from "antd";
import {useI18n} from "../../i18n";
import {copyText} from "../../utils/clipboard";
import {BUI_PATHS,BuiIcon} from "../ui/beautiful";
import {Glyph} from "../ui/fieldwork";
import {MESSAGE_ACTION} from "./messageAction";
/**
 * Copy action. The accessible name follows the outcome ("Copied"/"Copy failed") and is announced politely.
 * Icon-only by default (message actions); `labelled` is Beautiful UI Code Block's header control with a short visible word.
 */
export function CopyButton({value,kind,labelled=false}:{value:string;kind:"message"|"code";labelled?:boolean}) {
 const {t}=useI18n();
 const [state,setState]=useState<"idle"|"copied"|"failed">("idle");
 const timer=useRef<number|undefined>(undefined);
 useEffect(()=>()=>window.clearTimeout(timer.current),[]);
 const label=t(state==="copied"?"chat.copy.copied":state==="failed"?"chat.copy.failed":kind==="code"?"chat.copy.code":"chat.copy.message");
 const outcome=state==="copied"?" wf-tone-success text-green hover:text-green":state==="failed"?" wf-tone-danger text-red hover:text-red":"";
 const icon=state==="failed"?<Glyph name="warning" size={labelled?11:14}/>:<BuiIcon size={labelled?11:15} strokeWidth={state==="copied"?(labelled?3:2.2):(labelled?2:1.8)}>{state==="copied"?BUI_PATHS.check:BUI_PATHS.copy}</BuiIcon>;
 const copy=async()=>{
  window.clearTimeout(timer.current);
  setState(await copyText(value)?"copied":"failed");
  timer.current=window.setTimeout(()=>setState("idle"),2000);
 };
 if(labelled)return <button type="button" aria-label={label} onClick={copy}
  className={`-mr-1 ml-auto flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-medium transition-colors duration-100 hover:bg-hover ${state==="copied"?"text-green":state==="failed"?"text-red":"text-ink-3 hover:text-ink"}`}>
  {icon}<span aria-hidden="true">{t(state==="copied"?"chat.copy.copied":state==="failed"?"chat.copy.failed":"chat.copy.short")}</span><span className="wf-sr-only" aria-live="polite">{state==="idle"?"":label}</span>
 </button>;
 return <Tooltip title={label}><button type="button" className={`${MESSAGE_ACTION}${outcome}`} aria-label={label} onClick={copy}>{icon}<span className="wf-sr-only" aria-live="polite">{label}</span></button></Tooltip>;
}
