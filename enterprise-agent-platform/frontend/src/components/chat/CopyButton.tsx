import {useEffect,useRef,useState} from "react";
import {Button,Tooltip} from "antd";
import {useI18n} from "../../i18n";
import {copyText} from "../../utils/clipboard";
import {Glyph} from "../ui/fieldwork";
/** Icon-only copy action. The accessible name follows the outcome ("Copied"/"Copy failed") and is announced politely. */
export function CopyButton({value,kind}:{value:string;kind:"message"|"code"}) {
 const {t}=useI18n();
 const [state,setState]=useState<"idle"|"copied"|"failed">("idle");
 const timer=useRef<number|undefined>(undefined);
 useEffect(()=>()=>window.clearTimeout(timer.current),[]);
 const label=t(state==="copied"?"chat.copy.copied":state==="failed"?"chat.copy.failed":kind==="code"?"chat.copy.code":"chat.copy.message");
 return <Tooltip title={label}><Button type="text" size="small" className={`wf-message-action${state==="copied"?" wf-tone-success":state==="failed"?" wf-tone-danger":""}`} aria-label={label} icon={<Glyph name={state==="copied"?"check":state==="failed"?"warning":"copy"} size={16} />} onClick={async()=>{
  window.clearTimeout(timer.current);
  setState(await copyText(value)?"copied":"failed");
  timer.current=window.setTimeout(()=>setState("idle"),2000);
 }}><span className="wf-sr-only" aria-live="polite">{label}</span></Button></Tooltip>;
}
