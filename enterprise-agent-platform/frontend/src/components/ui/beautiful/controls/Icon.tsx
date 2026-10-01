/* Open line icons for the controls and shell — 24px grid, round caps, drawn in the style of upstream's inline SVGs
 * (components/primitives/*, components/site/UseThisHarness.tsx). Replaces upstream's commercial Central Icons. */
import type { ReactNode } from "react";

const PATHS = {
  sparkle: <><path d="M11 3.5c.5 4.1 2.4 6 6.5 6.5-4.1.5-6 2.4-6.5 6.5-.5-4.1-2.4-6-6.5-6.5 4.1-.5 6-2.4 6.5-6.5Z" /><path d="M18.5 15c.25 1.6.9 2.25 2.5 2.5-1.6.25-2.25.9-2.5 2.5-.25-1.6-.9-2.25-2.5-2.5 1.6-.25 2.25-.9 2.5-2.5Z" /></>,
  chat: <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-4.2A7.5 7.5 0 1 1 20 11.5Z" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  hash: <path d="M5 9h14.5M4.5 15H19M10.5 4.5 8.5 19.5M15.5 4.5l-2 15" />,
  shield: <path d="M12 3.5 5.5 6v5.2c0 4.1 2.8 7.6 6.5 9.3 3.7-1.7 6.5-5.2 6.5-9.3V6L12 3.5Z" />,
  gear: <><circle cx="12" cy="12" r="2.75" /><path d="M19.2 14.6a1.4 1.4 0 0 0 .3 1.5l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.4 1.4 0 0 0-1.5-.3 1.4 1.4 0 0 0-.8 1.3v.1a1.7 1.7 0 1 1-3.4 0v-.1a1.4 1.4 0 0 0-.9-1.3 1.4 1.4 0 0 0-1.5.3l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.4 1.4 0 0 0 .3-1.5 1.4 1.4 0 0 0-1.3-.8h-.1a1.7 1.7 0 1 1 0-3.4h.1a1.4 1.4 0 0 0 1.3-.9 1.4 1.4 0 0 0-.3-1.5l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.4 1.4 0 0 0 1.5.3h.1a1.4 1.4 0 0 0 .8-1.3v-.1a1.7 1.7 0 1 1 3.4 0v.1a1.4 1.4 0 0 0 .8 1.3 1.4 1.4 0 0 0 1.5-.3l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.4 1.4 0 0 0-.3 1.5v.1a1.4 1.4 0 0 0 1.3.8h.1a1.7 1.7 0 1 1 0 3.4h-.1a1.4 1.4 0 0 0-1.3.8Z" /></>,
  compose: <><path d="M11 4.5H7a2.5 2.5 0 0 0-2.5 2.5v10A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5v-4" /><path d="M17.6 3.9a1.9 1.9 0 0 1 2.7 2.7l-7.1 7.1-3.4.7.7-3.4 7.1-7.1Z" /></>,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M9.5 4.5v15M15.5 10l-2 2 2 2" /></>,
  menu: <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />,
  logout: <><path d="M9.5 20H6.5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3" /><path d="M15.5 16.5 20 12l-4.5-4.5M20 12H9.5" /></>,
  sun: <><circle cx="12" cy="12" r="3.75" /><path d="M12 3v1.5M12 19.5V21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M3 12h1.5M19.5 12H21M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1" /></>,
  moon: <path d="M19.5 14.2A7.8 7.8 0 1 1 9.8 4.5a6.2 6.2 0 0 0 9.7 9.7Z" />,
  monitor: <><rect x="3.5" y="4.5" width="17" height="11.5" rx="2.5" /><path d="M8.5 19.5h7M12 16v3.5" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.2 2.3 3.3 5.2 3.3 8.5s-1.1 6.2-3.3 8.5c-2.2-2.3-3.3-5.2-3.3-8.5s1.1-6.2 3.3-8.5Z" /></>,
  user: <><circle cx="12" cy="8.5" r="3.75" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  more: <g fill="currentColor" stroke="none"><circle cx="5.5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18.5" cy="12" r="1.6" /></g>,
  pencil: <path d="M15.8 4.7a2.1 2.1 0 0 1 3 3L8 18.5l-4 1 1-4L15.8 4.7Z" />,
  trash: <path d="M4.5 7h15M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 11.1A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.9L17.5 7M10.5 11v5M13.5 11v5" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronUpDown: <path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  check: <path d="M20 6L9 17l-5-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 16v-4.5M12 8h.01" /></>,
  success: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.2l2.4 2.4 4.6-5" /></>,
  warning: <path d="M10.3 4.3 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0ZM12 9.5v4M12 17h.01" />,
  danger: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5M12 16h.01" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.75" /></>,
  eyeOff: <path d="M3.5 3.5l17 17M10.4 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.8 3.6M6.5 6.9A15.6 15.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 4.5-1.2M10 10.1a2.75 2.75 0 0 0 3.9 3.9" />,
  lock: <><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>,
  refresh: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4h-4" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  external: <><path d="M14 5h5v5" /><path d="M19 5l-8 8" /><path d="M19 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" /></>,
  upload: <><path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9" /><path d="M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" /></>,
  download: <><path d="M12 4.5v11M7.5 11 12 15.5 16.5 11" /><path d="M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" /></>,
  play: <path d="M7.5 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9 4.64a1 1 0 0 0-1.5.86Z" />,
  pause: <path d="M8.5 5.5v13M15.5 5.5v13" />,
  history: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" /><path d="M4.5 4.5V9H9M12 8v4l2.75 1.75" /></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9.5Z" />,
  browser: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M3.5 9h17M6.5 6.75h.01M9 6.75h.01" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

/** A decorative line icon; label the control that contains it, not the icon. */
export function Icon({
  name,
  size = 18,
  strokeWidth = 1.8,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
