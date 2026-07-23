/* Product icon renderer. All icons have an explicit default size so SVGs never
   fall back to the browser's 300 x 150 replaced-element dimensions. */

import type { IconName } from "../../types";
import { ICONS } from "./icons";

export interface IconProps {
  name: IconName;
  size?: number;
  /** Maps to the svg `class` attribute (e.g. "spin" for the loader). */
  cls?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 18, cls, strokeWidth }: IconProps) {
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
