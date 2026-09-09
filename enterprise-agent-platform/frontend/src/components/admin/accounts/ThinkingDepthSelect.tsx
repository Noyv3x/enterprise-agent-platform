import { Select } from "antd";
import { THINKING_DEPTH_OPTIONS } from "../../../lib/constants";
import { useI18n } from "../../../i18n";

const depthLabels = {
  none: "admin.thinkingDepth.none", minimal: "admin.thinkingDepth.minimal",
  low: "admin.thinkingDepth.low", medium: "admin.thinkingDepth.medium",
  high: "admin.thinkingDepth.high", xhigh: "admin.thinkingDepth.xhigh",
} as const;

export function ThinkingDepthSelect({ id, value, onChange }: { id?: string; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  return <Select id={id} style={{ width: "100%" }} value={value} onChange={onChange} options={THINKING_DEPTH_OPTIONS.map(([depth]) => ({ value: depth, label: t(depthLabels[depth as keyof typeof depthLabels]) }))} />;
}
