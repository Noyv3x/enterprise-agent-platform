import { useState } from "react";
import { Button, Empty, Progress } from "antd";
import { useI18n } from "../../i18n";
import type { ContextUsage, Message } from "../../types";
import { formatNumber } from "../../utils/format";
import { Dialog } from "../common/Dialog";
import { Icon } from "../common/Icon";

export function latestContextUsage(messages: readonly Message[]): ContextUsage | null {
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

export function ContextDetailsDialog({ messages }: { messages: readonly Message[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const usage = latestContextUsage(messages);

  return (
    <>
      <Button
        className="ctx-details__trigger"
        size="small"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="context-details-dialog"
        title={t("chat.context.button")}
        icon={<Icon name="barChart" size={15} />}
        onClick={() => setOpen(true)}
      >
        <span className="ctx-details__label">{t("chat.context.button")}</span>
      </Button>
      <Dialog
        id="context-details-dialog"
        open={open}
        onClose={() => setOpen(false)}
        title={t("chat.context.title")}
        description={t("chat.context.description")}
        className="ctx-details__dialog"
      >
        {usage ? (
          <section className="ctx-details__usage" aria-label={t("chat.context.title")}>
            <div className="ctx-details__summary">
              <span>{t("chat.context.used")}</span>
              <strong>{t("chat.context.percent", { percent: usage.percent })}</strong>
            </div>
            <Progress
              className="ctx-details__progress"
              classNames={{
                body: "ctx-details__progress-body",
                rail: "ctx-details__progress-rail",
                track: "ctx-details__progress-track",
              }}
              percent={usage.percent}
              showInfo={false}
              size={["100%", 10]}
              strokeColor={{
                from: "var(--accent)",
                to: "color-mix(in srgb, var(--accent) 68%, var(--ok))",
              }}
              railColor="var(--surface-2)"
              aria-label={t("chat.context.progressLabel")}
            />
            <div className="ctx-details__tokens">
              {t("chat.context.tokens", {
                used: formatNumber(usage.used_tokens),
                total: formatNumber(usage.max_tokens),
              })}
            </div>
            {usage.estimated ? (
              <p className="ctx-details__note">{t("chat.context.estimated")}</p>
            ) : null}
          </section>
        ) : (
          <Empty
            className="ctx-details__empty"
            classNames={{
              image: "ctx-details__empty-image",
              description: "ctx-details__empty-description",
            }}
            image={<Icon name="barChart" size={22} />}
            description={t("chat.context.unavailable")}
          />
        )}
      </Dialog>
    </>
  );
}
