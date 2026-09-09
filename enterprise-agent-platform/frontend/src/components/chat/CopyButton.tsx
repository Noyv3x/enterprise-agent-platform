import {useEffect,useRef,useState} from "react";
import {Button} from "antd";
import {useI18n} from "../../i18n";
import {copyText} from "../../utils/clipboard";
export function CopyButton({value,kind}:{value:string;kind:"message"|"code"}) {
 const {t}=useI18n();
 const [state,setState]=useState<"idle"|"copied"|"failed">("idle");
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
 const label=t(state==="copied"?"chat.copy.copied":state==="failed"?"chat.copy.failed":kind==="code"?"chat.copy.code":"chat.copy.message");
 return <Button type="text" aria-label={label} onClick={async()=>{
  if(timer.current)clearTimeout(timer.current);
  setState(await copyText(value)?"copied":"failed");
  timer.current=setTimeout(()=>setState("idle"),2000);
 }}><span aria-live="polite">{label}</span></Button>;
}
