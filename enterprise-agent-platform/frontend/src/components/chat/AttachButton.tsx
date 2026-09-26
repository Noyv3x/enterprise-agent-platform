import { Tooltip } from "antd";
import { useI18n } from "../../i18n";
import { BUI_PATHS, BuiIcon } from "../ui/beautiful";

/** Beautiful UI Prompt Bar "add" control: a quiet 28px square that inks on hover. */
export function AttachButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useI18n();
  const label = t("chat.attach.add");
  return <Tooltip title={label}>
    <button type="button" disabled={disabled} onClick={onClick} aria-label={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.94] disabled:pointer-events-none disabled:opacity-50">
      <BuiIcon size={16} strokeWidth={2}>{BUI_PATHS.plus}</BuiIcon>
    </button>
  </Tooltip>;
}
