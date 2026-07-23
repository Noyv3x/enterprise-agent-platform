/* <TelegramLinkPopover/> — one-time Telegram ownership challenge for the private
   Agent. The browser never accepts a Telegram numeric ID: it asks the platform
   for a short-lived command, which the user sends in a private chat with the
   managed bot. The secret command is retained locally because later GETs expose
   only pending status/expiry; a focused poll discovers the completed link. */

import { useEffect, useState } from "react";
import { Alert, Button } from "antd";
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
import { Dialog } from "../common/Dialog";

const LINK_POLL_INTERVAL_MS = 3_000;

function formatExpiryTimestamp(value: number | null | undefined, locale: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return String(value ?? "");
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(seconds * 1000),
  );
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the selection-based compatibility path.
  }
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.readOnly = true;
    textarea.className = "clipboard-proxy";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    return copied;
  } catch {
    return false;
  } finally {
    textarea?.remove();
  }
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

  return (
    <Dialog
      id="private-telegram-popover"
      open
      onClose={() => dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: false })}
      title={t("chat.telegram.title")}
      description={status}
      className="telegram-link-dialog"
    >
      <div className="telegram-link__body">
        {view === "linked" ? (
          <div className="telegram-link__account">
            <div>
              <strong>{link.telegram_username ? `@${link.telegram_username}` : t("chat.telegram.accountFallback")}</strong>
              <span>{`ID ${link.telegram_user_id}`}</span>
            </div>
            <Button danger size="small" disabled={busy} loading={unlinkBusy} onClick={onUnbind}>
              {t("chat.telegram.unbind")}
            </Button>
          </div>
        ) : view === "disabled" ? (
          <Alert className="telegram-link__notice" type="warning" showIcon title={t("chat.telegram.disabledNotice")} />
        ) : (
          <>
            <p className="telegram-link__instructions">
              {t("chat.telegram.instructions", { bot: botName })}
            </p>
            {challengeVisible ? (
              <div className="telegram-challenge">
                <div className="telegram-challenge__code">
                  <span>{t("chat.telegram.code")}</span>
                  <strong>{code}</strong>
                </div>
                <div className="telegram-challenge__command">
                  <code>{command}</code>
                  <Button size="small" onClick={onCopy}>
                    {copied ? t("chat.telegram.copied") : t("chat.telegram.copyCommand")}
                  </Button>
                </div>
                <div className="telegram-challenge__expiry">
                  <span>{relativeExpiry}</span>
                  {timing.valid ? (
                    <span>{t("chat.telegram.expiresAt", { time: formatExpiryTimestamp(pending?.expires_at, locale) })}</span>
                  ) : null}
                </div>
                <span className="telegram-challenge__hint">
                  {t("chat.telegram.commandHint")}
                </span>
              </div>
            ) : pendingActive ? (
              <Alert
                className="telegram-link__notice"
                type="warning"
                showIcon
                title={t("chat.telegram.pendingHidden")}
              />
            ) : timing.expired ? (
              <Alert
                className="telegram-link__notice"
                type="warning"
                showIcon
                title={t("chat.telegram.expiredNotice")}
              />
            ) : null}
            <div className="telegram-link__actions">
              <Button
                type="primary"
                size="small"
                disabled={busy}
                loading={linkBusy}
                onClick={() => void onGenerate()}
              >
                {pending ? t("chat.telegram.regenerate") : t("chat.telegram.generate")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
