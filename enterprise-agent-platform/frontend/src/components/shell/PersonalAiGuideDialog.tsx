import { Button } from "../ui/beautiful"
import { useEffect, useRef, useState } from "react";
import { resourceKeys } from "../../data/resourceState";
import { useI18n, type MessageKey } from "../../i18n";
import { hasPermission, isAgentActive } from "../../store/selectors";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Dialog } from "../common/Dialog";
import { GuideSheet, Notice } from "../ui/beautiful"

const GUIDE_ITEMS: ReadonlyArray<{
  id: string;
  titleKey: MessageKey;
  promptKey: MessageKey;
}> = [
  {
    id: "computer",
    titleKey: "personalAi.guide.computer.title",
    promptKey: "personalAi.guide.computer.prompt",
  },
  {
    id: "files",
    titleKey: "personalAi.guide.files.title",
    promptKey: "personalAi.guide.files.prompt",
  },
  {
    id: "web",
    titleKey: "personalAi.guide.web.title",
    promptKey: "personalAi.guide.web.prompt",
  },
];

export function PersonalAiGuideDialog({ onDraftFilled }: { onDraftFilled: () => void }) {
  const store = useStoreHandle();
  const { t } = useI18n();
  const [draftBlocked, setDraftBlocked] = useState(false);
  const pendingFocusRef = useRef(false);

  const open = useStore((state) => state.personalAiGuideOpen);
  const shownThisSession = useStore((state) => state.personalAiGuideShownThisSession);
  const activeView = useStore((state) => state.activeView);
  const userId = useStore((state) => state.user?.id);
  const canUsePersonalAi = useStore((state) => hasPermission(state, "private_agent"));
  const history = useStore((state) => {
    const id = state.user?.id;
    return id == null ? undefined : state.messageHistory[`private:${String(id)}`];
  });
  const privateResourceStatus = useStore(
    (state) => state.resourceStates[resourceKeys.privateChat]?.status,
  );
  const hasPrivateMessages = useStore((state) => state.privateMessages.length > 0);
  const hasPrivateOptimisticMessage = useStore((state) => {
    const id = state.user?.id;
    if (id == null) return false;
    return state.pendingMessages.some(
      (message) => message.scope_type === "private" && String(message.scope_id) === String(id),
    );
  });
  const personalAiActive = useStore((state) => isAgentActive(state.agentStatuses.private));

  useEffect(() => {
    if (
      shownThisSession
      || open
      || activeView !== "private"
      || !canUsePersonalAi
      || userId == null
      || !history
      || history.loading
      || !!history.error
      || privateResourceStatus === "loading"
      || privateResourceStatus === "error"
      || hasPrivateMessages
      || hasPrivateOptimisticMessage
      || personalAiActive
    ) {
      return;
    }
    store.dispatch({
      type: "SET_PERSONAL_AI_GUIDE_OPEN",
      payload: { open: true, markShown: true },
    });
  }, [
    activeView,
    canUsePersonalAi,
    hasPrivateMessages,
    hasPrivateOptimisticMessage,
    history,
    open,
    personalAiActive,
    privateResourceStatus,
    shownThisSession,
    store,
    userId,
  ]);

  useEffect(() => {
    if (!open) setDraftBlocked(false);
  }, [open]);

  const close = () => {
    setDraftBlocked(false);
    store.dispatch({ type: "SET_PERSONAL_AI_GUIDE_OPEN", payload: { open: false } });
  };

  const tryPrompt = (promptKey: MessageKey) => {
    if (userId == null) return;
    const draftKey = `private:${String(userId)}`;
    const state = store.getState();
    if (
      (state.drafts[draftKey] || "").length > 0
      || (state.draftFiles[draftKey]?.length || 0) > 0
    ) {
      setDraftBlocked(true);
      return;
    }
    store.dispatch({
      type: "SET_DRAFT",
      payload: { key: draftKey, value: t(promptKey) },
    });
    pendingFocusRef.current = true;
    close();
  };

  return <Dialog open={open} onClose={close} title={t("personalAi.guide.title")}
    afterOpenChange={nextOpen => {
      if (nextOpen || !pendingFocusRef.current) return;
      pendingFocusRef.current = false;
      onDraftFilled();
    }} footer={<Button onClick={close}>{t("personalAi.guide.close")}</Button>}>
    <GuideSheet title={t("personalAi.guide.computer.title")} intro={t("personalAi.guide.description")}
      sections={[
        { key: "files", title: t("personalAi.guide.files.title"), body: t("personalAi.guide.files.description") },
        { key: "web", title: t("personalAi.guide.web.title"), body: t("personalAi.guide.web.description") },
        { key: "skills", title: t("workroom.guideSkillsTitle"), body: t("workroom.guideSkillsBody") },
      ]}
      examples={GUIDE_ITEMS.map(item => ({ key: item.id, label: t("personalAi.guide.tryNamed", { capability: t(item.titleKey) }), onSelect: () => tryPrompt(item.promptKey) }))}
      notice={draftBlocked ? <Notice tone="warning" title={t("personalAi.guide.draftPreserved")} /> : undefined}
      action={<p className="bui-muted">{t("personalAi.guide.reopen")}</p>} />
  </Dialog>;
}
