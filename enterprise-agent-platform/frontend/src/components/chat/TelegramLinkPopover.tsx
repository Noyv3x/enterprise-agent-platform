/* <TelegramLinkPopover/> — one-time Telegram ownership challenge for the private
   Agent. The browser never accepts a Telegram numeric ID: it asks the platform
   for a short-lived command, which the user sends in a private chat with the
   managed bot. The secret command is retained locally because later GETs expose
   only pending status/expiry; a focused poll discovers the completed link. */

import { useEffect, useState } from "react";
import { loadPrivateTelegram } from "../../data/loaders";
import { runBusy } from "../../data/sessionActions";
import { api } from "../../lib/api";
import { EMPTY_BODY, endpoints } from "../../lib/endpoints";
import { useToast } from "../../hooks/useToast";
import { useDispatch, useStore, useStoreHandle } from "../../store/useStore";
import type { PrivateTelegramPending, PrivateTelegramResponse } from "../../types";
import { formatTimestamp } from "../../utils/format";
import {
  telegramChallengeRelativeLabel,
  telegramChallengeTiming,
  telegramLinkView,
} from "../../utils/telegramLink";
import { Icon } from "../common/Icon";

const LINK_POLL_INTERVAL_MS = 3_000;

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

  const busy = useStore((state) => state.busy);
  const telegram = useStore((state) => state.privateTelegram);
  const gateway = telegram?.gateway || {};
  const link = telegram?.link || {};
  const linked = !!link.telegram_user_id;
  const botName = gateway.bot_username ? `@${gateway.bot_username}` : "Telegram bot";

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
    ? `${botName} 已绑定`
    : !gateway.enabled
      ? "管理员尚未启用"
      : pendingActive
        ? `${botName} 等待确认`
        : `${botName} 可绑定`;

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
    await runBusy(store, async () => {
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
        throw new Error("服务未返回可用的 Telegram 绑定码，请重试");
      }
      setLocalChallenge(challenge);
      setNowSeconds(Math.floor(Date.now() / 1000));
      setCopied(false);
      toast("请在 Telegram 私聊中发送一次性绑定命令", { type: "ok", title: "绑定码已生成" });
    });
  };

  const onCopy = async () => {
    if (!command) return;
    if (await copyText(command)) {
      setCopied(true);
      toast("绑定命令已复制", { type: "ok", title: "已复制" });
    } else {
      toast("无法自动复制，请手动选择绑定命令", { title: "复制失败" });
    }
  };

  const onUnbind = async () => {
    await runBusy(store, async () => {
      await api(endpoints.deletePrivateTelegram.path(), { method: "DELETE", body: EMPTY_BODY });
      setLocalChallenge(null);
      await loadPrivateTelegram(store);
      toast("Telegram 绑定已解除", { type: "ok", title: "完成" });
    });
  };

  return (
    <section
      className="telegram-link"
      id="private-telegram-popover"
      role="dialog"
      aria-label="Telegram 私聊设置"
    >
      <div className="telegram-link__header">
        <div className="telegram-link__meta">
          <div className="telegram-link__title">
            <Icon name="message" size={16} />
            <span>Telegram 私聊</span>
          </div>
          <div className="telegram-link__sub">{status}</div>
        </div>
        <button
          className="icon-btn telegram-link__close"
          type="button"
          title="收起"
          aria-label="收起 Telegram 私聊设置"
          onClick={() => dispatch({ type: "SET_PRIVATE_TELEGRAM_EXPANDED", payload: false })}
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="telegram-link__body">
        {view === "linked" ? (
          <div className="telegram-link__account">
            <div>
              <strong>{link.telegram_username ? `@${link.telegram_username}` : "Telegram 账户"}</strong>
              <span>{`ID ${link.telegram_user_id}`}</span>
            </div>
            <button className="btn btn--danger btn--sm" type="button" disabled={busy} onClick={onUnbind}>
              解除绑定
            </button>
          </div>
        ) : view === "disabled" ? (
          <div className="notice notice--warn">请联系管理员启用 Telegram 私聊网关后再绑定。</div>
        ) : (
          <>
            <p className="telegram-link__instructions">
              {`在 Telegram 中打开 ${botName}，发送平台生成的一次性命令。绑定码仅显示一次。`}
            </p>
            {challengeVisible ? (
              <div className="telegram-challenge">
                <div className="telegram-challenge__code">
                  <span>一次性绑定码</span>
                  <strong>{code}</strong>
                </div>
                <div className="telegram-challenge__command">
                  <code>{command}</code>
                  <button className="btn btn--sm" type="button" onClick={onCopy}>
                    {copied ? "已复制" : "复制命令"}
                  </button>
                </div>
                <div className="telegram-challenge__expiry">
                  <span>{telegramChallengeRelativeLabel(timing)}</span>
                  {timing.valid ? <span>{`截止 ${formatTimestamp(pending?.expires_at)}`}</span> : null}
                </div>
                <span className="telegram-challenge__hint">
                  复制后，将完整命令发送到与 Bot 的私聊中；群组消息不会生效。
                </span>
              </div>
            ) : pendingActive ? (
              <div className="notice notice--warn">
                已有绑定请求等待确认，但一次性命令不会再次显示。请重新生成后立即复制。
              </div>
            ) : timing.expired ? (
              <div className="notice notice--warn">绑定码已过期，请重新生成。</div>
            ) : null}
            <div className="telegram-link__actions">
              <button
                className="btn btn--primary btn--sm"
                type="button"
                disabled={busy}
                onClick={() => void onGenerate()}
              >
                {pending ? "重新生成绑定码" : "生成绑定码"}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
