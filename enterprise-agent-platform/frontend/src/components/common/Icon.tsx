/* <Icon/> — the React port of legacy icon(name, {size, cls, strokeWidth})
   (legacy-app.js:196-213). Renders an inline SVG from the ICONS registry,
   preserving viewBox, currentColor stroke, default stroke-width 1.7, and
   aria-hidden. SVG attribute data is spread directly (JSX supports SVG). */

import type { IconName } from "../../types";
import { ICONS } from "./icons";

export interface IconProps {
  name: IconName;
  size?: number;
  /** Maps to the svg `class` attribute (e.g. "spin" for the loader). */
  cls?: string;
  strokeWidth?: number;
}

export function Icon({ name, size, cls, strokeWidth }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth || 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      width={size}
      height={size}
      className={cls}
    >
      {ICONS[name].map((primitive, index) => {
        switch (primitive[0]) {
          case "line":
            return <line key={index} {...primitive[1]} />;
          case "circle":
            return <circle key={index} {...primitive[1]} />;
          case "rect":
            return <rect key={index} {...primitive[1]} />;
          case "path":
            return <path key={index} {...primitive[1]} />;
        }
      })}
    </svg>
  );
}
