import { useI18n } from "../../i18n";
import { BUI_PATHS, BuiIcon } from "../ui/beautiful";

/**
 * Beautiful UI Prompt Bar send: a tactile 28px square — brand fill when there is something to send, a quiet
 * hairline grey otherwise. Icon-only; the visible name lives in the composer hint, the accessible name in `aria-label`.
 */
export function SendButton({ disabled, loading = false }: { disabled: boolean; loading?: boolean }) {
  const { t } = useI18n();
  const ready = !disabled && !loading;
  return <button type="submit" disabled={disabled || loading} aria-busy={loading || undefined}
    aria-label={t("chat.composer.send")} title={t("chat.composer.sendTitle")}
    className={`flex size-7 shrink-0 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] disabled:cursor-default ${ready
      ? "bg-accent text-on-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] hover:brightness-95"
      : "bg-line-strong text-ink-2"}`}>
    {loading
      ? <span aria-hidden="true" className="size-3 rounded-full border-[1.5px] border-ink-3 border-t-ink" style={{ animation: "spin 700ms linear infinite" }} />
      : <BuiIcon size={16} strokeWidth={2.4}>{BUI_PATHS.arrowUp}</BuiIcon>}
  </button>;
}
