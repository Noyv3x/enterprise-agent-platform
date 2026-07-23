/* <ThinkingDepthSelect/> — controlled thinking-depth dropdown (legacy
   thinkingDepthSelect, legacy-app.js:1552-1556) over THINKING_DEPTH_OPTIONS. */

import { THINKING_DEPTH_OPTIONS } from "../../../lib/constants";
import { useI18n } from "../../../i18n";
import { Select } from "antd";

const THINKING_DEPTH_KEYS = {
  none: "admin.thinkingDepth.none",
  minimal: "admin.thinkingDepth.minimal",
  low: "admin.thinkingDepth.low",
  medium: "admin.thinkingDepth.medium",
  high: "admin.thinkingDepth.high",
  xhigh: "admin.thinkingDepth.xhigh",
} as const;

export interface ThinkingDepthSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
}

export function ThinkingDepthSelect({ id, value, onChange }: ThinkingDepthSelectProps) {
  const { t } = useI18n();
  return <Select
    id={id}
    styles={{ input: { minHeight: 0 } }}
    value={value}
    onChange={onChange}
    options={THINKING_DEPTH_OPTIONS.map(([optionValue]) => ({
      value: optionValue,
      label: t(THINKING_DEPTH_KEYS[optionValue as keyof typeof THINKING_DEPTH_KEYS]),
    }))}
  />;
}
