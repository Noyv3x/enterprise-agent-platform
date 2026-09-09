import { useEffect, useState } from "react";
import { Button } from "antd";
import { loadPrivateTelegram } from "../../data/loaders";
import { runBusy } from "../../data/sessionActions";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { EMPTY_BODY, endpoints } from "../../lib/endpoints";
import { useToast } from "../../hooks/useToast";
import { useDispatch, useStore, useStoreHandle } from "../../store/useStore";
import type { PrivateTelegramPending, PrivateTelegramResponse } from "../../types";
import {
  telegramChallengeTiming,
  telegramLinkView,
} from "../../utils/telegramLink";
import { OverlayPanel, Notice, Section, FactGrid, StatusMark } from "../ui/fieldwork";
import {copyText} from "../../utils/clipboard";

const LINK_POLL_INTERVAL_MS = 3_000;

function formatExpiryTimestamp(value: number | null | undefined, locale: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return String(value ?? "");
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(seconds * 1000),
  );
}

export function TelegramLinkPopover() {
  const store = useStoreHandle();
  const dispatch = useDispatch();
  const toast = useToast();
  const { locale, t } = useI18n();

  const pendingOperations = useStore((state) => state.pendingOperations);
  const linkBusy = pendingOperations.includes("telegram:link");
  const unlinkBusy = pendingOperations.includes("telegram:unlink");
  const busy = linkBusy || unlinkBusy;
  const telegram = useStore((state) => state.privateTelegram);
  const gateway = telegram?.gateway || {};
  const link = telegram?.link || {};
  const linked = !!link.telegram_user_id;
  const botName = gateway.bot_username ? `@${gateway.bot_username}` : t("chat.telegram.botFallback");

  const [localChallenge, setLocalChallenge] = useState<PrivateTelegramPending | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [copied, setCopied] = useState(false);
  const pending = localChallenge || telegram?.pending || null;
  const timing = telegramChallengeTiming(pending?.expires_at, nowSeconds);
  const pendingActive = pending?.status === "pending" && !timing.expired;
  const command = String(pending?.command || "").trim();
  const code = String(pending?.code || "").trim();
  const challengeVisible = pendingActive && !!command && !!code;
  const view = telegramLinkView(!!gateway.enabled, linked);

  const status = linked
    ? t("chat.telegram.statusLinked", { bot: botName })
    : !gateway.enabled
      ? t("chat.telegram.statusDisabled")
      : pendingActive
        ? t("chat.telegram.statusPending", { bot: botName })
        : t("chat.telegram.statusAvailable", { bot: botName });

  const relativeExpiry = !timing.valid
    ? t("chat.telegram.expiryUnknown")
    : timing.expired
      ? t("chat.telegram.expired")
      : timing.secondsRemaining < 60
        ? t("chat.telegram.expiresSeconds", { count: timing.secondsRemaining })
        : t("chat.telegram.expiresMinutes", { count: timing.minutesRemaining });

  useEffect(() => {
    if (linked) setLocalChallenge(null);
  }, [linked]);

  useEffect(() => {
    if (localChallenge && telegramChallengeTiming(localChallenge.expires_at, nowSeconds).expired) {
      setLocalChallenge(null);
    }
  }, [localChallenge, nowSeconds]);

  useEffect(() => {
    if (!pending?.expires_at) return;
    setNowSeconds(Math.floor(Date.now() / 1000));
    const timer = window.setInterval(
      () => setNowSeconds(Math.floor(Date.now() / 1000)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [pending?.expires_at]);

  useEffect(() => {
    if (!gateway.enabled || linked || !pendingActive) return;
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        await loadPrivateTelegram(store);
      } catch {
        // The global session handler owns auth failures; transient polling is quiet.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), LINK_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [gateway.enabled, linked, pendingActive, store]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const onGenerate = async () => {
    await runBusy(store, "telegram:link", async () => {
      const result = await api<PrivateTelegramResponse>(endpoints.updatePrivateTelegram.path(), {
        method: "PUT",
        body: EMPTY_BODY,
      });
      const challenge = result.pending;
      // Keep the one-time secret out of the global store: routine chat refreshes
      // may inspect that state, while only this mounted popover needs the command.
      store.dispatch({
        type: "SET_PRIVATE_TELEGRAM",
        payload: challenge
          ? {
              ...result,
              pending: { status: challenge.status, expires_at: challenge.expires_at },
            }
          : result,
      });
      if (
        challenge?.status !== "pending" ||
        !String(challenge.code || "").trim() ||
        !String(challenge.command || "").trim()
      ) {
        throw new Error(t("chat.telegram.errorNoCode"));
      }
      setLocalChallenge(challenge);
      setNowSeconds(Math.floor(Date.now() / 1000));
      setCopied(false);
      toast(t("chat.telegram.generatedToast"), { type: "ok", title: t("chat.telegram.generatedTitle") });
    });
  };

  const onCopy = async () => {
    if (!command) return;
    if (await copyText(command)) {
      setCopied(true);
      toast(t("chat.telegram.copiedToast"), { type: "ok", title: t("chat.telegram.copied") });
    } else {
      toast(t("chat.telegram.copyFailed"), { title: t("chat.telegram.copyFailedTitle") });
    }
  };

  const onUnbind = async () => {
    await runBusy(store, "telegram:unlink", async () => {
      await api(endpoints.deletePrivateTelegram.path(), { method: "DELETE", body: EMPTY_BODY });
      setLocalChallenge(null);
      await loadPrivateTelegram(store);
      toast(t("chat.telegram.unboundToast"), { type: "ok", title: t("chat.telegram.doneTitle") });
    });
  };

  return <OverlayPanel open onClose={()=>dispatch({type:"SET_PRIVATE_TELEGRAM_EXPANDED",payload:false})} title={t("chat.telegram.title")} description={status} closeLabel={t("common.close")}
 footer={<Button disabled={busy} loading={pendingOperations.includes("telegram:refresh")} onClick={()=>void runBusy(store,"telegram:refresh",()=>loadPrivateTelegram(store))}>{t("chat.telegram.refresh")}</Button>}>
 <StatusMark tone={linked?"success":gateway.enabled?"info":"warning"}>{status}</StatusMark>
 {view==="disabled"?<Notice tone="warning" title={t("chat.telegram.disabledNotice")}/>:view==="linked"?<Section actions={<Button danger disabled={busy} loading={unlinkBusy} onClick={()=>void onUnbind()}>{t("chat.telegram.unbind")}</Button>}>
 <FactGrid items={[{key:"account",label:t("chat.telegram.accountFallback"),value:link.telegram_username?`@${link.telegram_username}`:t("chat.telegram.accountFallback")},{key:"id",label:"ID",value:String(link.telegram_user_id)}]}/>
 </Section>:<Section description={t("chat.telegram.instructions",{bot:botName})}>
 {challengeVisible?<Section tone="inset" title={t("chat.telegram.code")} actions={<Button onClick={()=>void onCopy()}>{copied?t("chat.telegram.copied"):t("chat.telegram.copyCommand")}</Button>}>
 <strong>{code}</strong><pre className="wf-telegram-command">{command}</pre>
 <p role="status">{relativeExpiry}</p>{timing.valid&&<p>{t("chat.telegram.expiresAt",{time:formatExpiryTimestamp(pending?.expires_at,locale)})}</p>}
 <p>{t("chat.telegram.commandHint")}</p>
 </Section>:pendingActive?<Notice tone="warning" title={t("chat.telegram.pendingHidden")}/>:timing.expired?<Notice tone="warning" title={t("chat.telegram.expiredNotice")}/>:null}
 <Button type="primary" disabled={busy} loading={linkBusy} onClick={()=>void onGenerate()}>{pending?t("chat.telegram.regenerate"):t("chat.telegram.generate")}</Button>
 </Section>}
 </OverlayPanel>;
}
