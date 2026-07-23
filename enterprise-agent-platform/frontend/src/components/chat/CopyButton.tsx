import { useEffect, useRef, useState } from "react";
import { Button, Tooltip } from "antd";
import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import { copyText } from "../../utils/clipboard";

type CopyState = "idle" | "copied" | "failed";

export function CopyButton({ value, kind }: { value: string; kind: "message" | "code" }) {
  const { t } = useI18n();
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const label =
    state === "copied"
      ? t("chat.copy.copied")
      : state === "failed"
        ? t("chat.copy.failed")
        : kind === "code"
          ? t("chat.copy.code")
          : t("chat.copy.message");

  return (
    <Tooltip title={label}>
      <Button
        type="text"
        size="small"
        className={cx("chat-copy", `chat-copy--${kind}`, state !== "idle" && `is-${state}`)}
        aria-label={label}
        icon={<span className="chat-copy__icon" aria-hidden="true">⧉</span>}
        onClick={async () => {
          if (resetTimer.current) clearTimeout(resetTimer.current);
          setState((await copyText(value)) ? "copied" : "failed");
          resetTimer.current = setTimeout(() => setState("idle"), 2_000);
        }}
      >
        <span className="chat-copy__label" aria-live="polite">{label}</span>
      </Button>
    </Tooltip>
  );
}
