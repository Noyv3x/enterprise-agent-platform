/* <ThinkingDepthSelect/> — controlled thinking-depth dropdown (legacy
   thinkingDepthSelect, legacy-app.js:1552-1556) over THINKING_DEPTH_OPTIONS. */

import { THINKING_DEPTH_OPTIONS } from "../../../lib/constants";

export interface ThinkingDepthSelectProps {
  value: string;
  onChange: (value: string) => void;
}

export function ThinkingDepthSelect({ value, onChange }: ThinkingDepthSelectProps) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {THINKING_DEPTH_OPTIONS.map(([optionValue, label]) => (
        <option key={optionValue} value={optionValue}>
          {label}
        </option>
      ))}
    </select>
  );
}
