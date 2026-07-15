import { useI18n } from "../../i18n";
import type { AgentPreviewScopeOption } from "./usePreviewScope";

export function PreviewScopeSelect({
  options,
  selected,
  onChange,
}: {
  options: AgentPreviewScopeOption[];
  selected: AgentPreviewScopeOption | null;
  onChange: (key: string) => void;
}) {
  const { t } = useI18n();
  if (!selected) return null;
  return (
    <label className="preview-scope">
      <span>{t("preview.scope")}</span>
      <select value={selected.key} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.key} value={option.key}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
