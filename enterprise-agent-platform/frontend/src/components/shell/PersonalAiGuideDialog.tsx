import { Alert, Button } from "antd";
import { useEffect, useRef, useState } from "react";
import { resourceKeys } from "../../data/resourceState";
import { useI18n, type MessageKey } from "../../i18n";
import { hasPermission, isAgentActive } from "../../store/selectors";
import { useStore, useStoreHandle } from "../../store/useStore";
import type { IconName } from "../../types";
import { Dialog } from "../common/Dialog";
import { Icon } from "../common/Icon";

const GUIDE_ITEMS: ReadonlyArray<{
  id: string;
  icon: IconName;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  promptKey: MessageKey;
}> = [
  {
    id: "computer",
    icon: "terminal",
    titleKey: "personalAi.guide.computer.title",
    descriptionKey: "personalAi.guide.computer.description",
    promptKey: "personalAi.guide.computer.prompt",
  },
  {
    id: "files",
    icon: "doc",
    titleKey: "personalAi.guide.files.title",
    descriptionKey: "personalAi.guide.files.description",
    promptKey: "personalAi.guide.files.prompt",
  },
  {
    id: "web",
    icon: "browser",
    titleKey: "personalAi.guide.web.title",
    descriptionKey: "personalAi.guide.web.description",
    promptKey: "personalAi.guide.web.prompt",
  },
  {
    id: "sylver",
    icon: "link",
    titleKey: "personalAi.guide.sylver.title",
    descriptionKey: "personalAi.guide.sylver.description",
    promptKey: "personalAi.guide.sylver.prompt",
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

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("personalAi.guide.title")}
      description={t("personalAi.guide.description")}
      className="personal-ai-guide"
      afterOpenChange={(nextOpen) => {
        if (nextOpen || !pendingFocusRef.current) return;
        pendingFocusRef.current = false;
        onDraftFilled();
      }}
      footer={<Button onClick={close}>{t("personalAi.guide.close")}</Button>}
    >
      <p className="personal-ai-guide__reopen-note">
        <Icon name="sparkles" size={17} />
        <span>{t("personalAi.guide.reopen")}</span>
      </p>
      <div className="personal-ai-guide__list">
        {GUIDE_ITEMS.map((item) => {
          const title = t(item.titleKey);
          return (
            <div className="personal-ai-guide__item" key={item.id}>
              <span className="personal-ai-guide__icon"><Icon name={item.icon} size={20} /></span>
              <span className="personal-ai-guide__copy">
                <strong>{title}</strong>
                <span>{t(item.descriptionKey)}</span>
              </span>
              <Button
                type="default"
                onClick={() => tryPrompt(item.promptKey)}
                aria-label={t("personalAi.guide.tryNamed", { capability: title })}
              >
                {t("personalAi.guide.try")}
              </Button>
            </div>
          );
        })}
      </div>
      {draftBlocked ? (
        <Alert
          className="personal-ai-guide__draft-alert"
          type="warning"
          showIcon
          title={t("personalAi.guide.draftPreserved")}
        />
      ) : null}
    </Dialog>
  );
}
