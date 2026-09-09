import { Button } from "antd";
import { useState } from "react";
import { presentPreviewUrl } from "../../data/previewActions";
import { useI18n } from "../../i18n";
import type { AgentPreviewScope, ComputerPresentClue } from "../../types";
import { LoadingState, Notice } from "../ui/fieldwork";

export function PresentComputerView({scope,present=null,compact=false}: {scope:AgentPreviewScope;present?:ComputerPresentClue|null;compact?:boolean}) {
  const {t}=useI18n();
  const [failedKey,setFailedKey]=useState("");
  const [retry,setRetry]=useState(0);
  const status=String(present?.status || "completed").trim().toLowerCase();
  const failed=["failed","error","cancelled"].includes(status);
  const running=!["completed","complete","done","failed","error","cancelled"].includes(status);
  const identity=[scope.scope_type,scope.scope_id,present?.workspace_path,present?.attachment_id,present?.revision || [present?.tool_call_id,present?.updated_sequence ?? present?.sequence,status].join(":"),retry].join("|");
  return <div className="wf-present-view" data-compact={compact || undefined}>
    {failed || failedKey === identity ? <Notice tone="warning" title={t("computer.present.failed")} action={!compact && !failed ? <Button onClick={() => {setFailedKey("");setRetry(value => value+1);}}>{t("computer.retry")}</Button> : undefined} />
      : running ? <div aria-busy="true"><LoadingState label={t("computer.loading")} /></div>
      : <iframe key={identity} title={t("computer.present.title")} src={presentPreviewUrl(scope)} sandbox="allow-scripts" referrerPolicy="no-referrer" tabIndex={compact ? -1 : undefined} onError={() => setFailedKey(identity)} />}
  </div>;
}
