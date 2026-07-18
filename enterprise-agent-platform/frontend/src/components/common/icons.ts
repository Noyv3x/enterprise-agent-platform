/* =====================================================================
   The ICONS registry — ported verbatim from legacy-app.js:135-166. Each
   entry is a list of SVG primitives ([tag, attrs]); the hand-tuned path/coord
   data is the source of truth and must not drift. Rendered by <Icon/>.
   ===================================================================== */

import type { SVGProps } from "react";
import type { IconName } from "../../types";

/** A single SVG child primitive: a tag discriminant + its typed attributes. */
export type IconPrimitive =
  | readonly ["line", SVGProps<SVGLineElement>]
  | readonly ["path", SVGProps<SVGPathElement>]
  | readonly ["circle", SVGProps<SVGCircleElement>]
  | readonly ["rect", SVGProps<SVGRectElement>];

export const ICONS: Record<IconName, readonly IconPrimitive[]> = {
  hash: [
    ["line", { x1: 4, y1: 9, x2: 20, y2: 9 }],
    ["line", { x1: 4, y1: 15, x2: 20, y2: 15 }],
    ["line", { x1: 10, y1: 3, x2: 8, y2: 21 }],
    ["line", { x1: 16, y1: 3, x2: 14, y2: 21 }],
  ],
  bot: [
    ["rect", { x: 4, y: 9, width: 16, height: 11, rx: 2.5 }],
    ["path", { d: "M12 9V5" }],
    ["circle", { cx: 12, cy: 3.6, r: 1.3 }],
    ["path", { d: "M9.4 14h.01" }],
    ["path", { d: "M14.6 14h.01" }],
    ["path", { d: "M4 13.5H2.5" }],
    ["path", { d: "M21.5 13.5H20" }],
  ],
  library: [
    ["path", { d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20" }],
    ["path", { d: "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" }],
  ],
  settings: [
    ["line", { x1: 3, y1: 8, x2: 21, y2: 8 }],
    ["circle", { cx: 9, cy: 8, r: 2.3 }],
    ["line", { x1: 3, y1: 16, x2: 21, y2: 16 }],
    ["circle", { cx: 15, cy: 16, r: 2.3 }],
  ],
  send: [
    ["path", { d: "M12 19V5" }],
    ["path", { d: "M6 11l6-6 6 6" }],
  ],
  search: [
    ["circle", { cx: 11, cy: 11, r: 7 }],
    ["line", { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }],
  ],
  sun: [
    ["circle", { cx: 12, cy: 12, r: 4 }],
    ["path", { d: "M12 2v2" }],
    ["path", { d: "M12 20v2" }],
    ["path", { d: "M2 12h2" }],
    ["path", { d: "M20 12h2" }],
    ["path", { d: "M4.9 4.9l1.4 1.4" }],
    ["path", { d: "M17.7 17.7l1.4 1.4" }],
    ["path", { d: "M19.1 4.9l-1.4 1.4" }],
    ["path", { d: "M6.3 17.7l-1.4 1.4" }],
  ],
  moon: [["path", { d: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" }]],
  logout: [
    ["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }],
    ["path", { d: "M16 17l5-5-5-5" }],
    ["line", { x1: 21, y1: 12, x2: 9, y2: 12 }],
  ],
  plus: [
    ["line", { x1: 12, y1: 5, x2: 12, y2: 19 }],
    ["line", { x1: 5, y1: 12, x2: 19, y2: 12 }],
  ],
  checkCircle: [
    ["path", { d: "M22 11.08V12a10 10 0 1 1-5.93-9.14" }],
    ["path", { d: "M22 4L12 14.01l-3-3" }],
  ],
  alert: [
    ["path", { d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" }],
    ["line", { x1: 12, y1: 9, x2: 12, y2: 13 }],
    ["line", { x1: 12, y1: 17, x2: 12.01, y2: 17 }],
  ],
  refresh: [
    ["path", { d: "M21 2v6h-6" }],
    ["path", { d: "M3 12a9 9 0 0 1 15-6.7L21 8" }],
    ["path", { d: "M3 22v-6h6" }],
    ["path", { d: "M21 12a9 9 0 0 1-15 6.7L3 16" }],
  ],
  download: [
    ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }],
    ["path", { d: "M7 10l5 5 5-5" }],
    ["line", { x1: 12, y1: 15, x2: 12, y2: 3 }],
  ],
  upload: [
    ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }],
    ["path", { d: "M17 8l-5-5-5 5" }],
    ["line", { x1: 12, y1: 3, x2: 12, y2: 15 }],
  ],
  paperclip: [
    ["path", { d: "M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7L9.2 18.2a2 2 0 0 1-2.8-2.8l9.2-9.2" }],
  ],
  close: [
    ["line", { x1: 18, y1: 6, x2: 6, y2: 18 }],
    ["line", { x1: 6, y1: 6, x2: 18, y2: 18 }],
  ],
  menu: [
    ["line", { x1: 3, y1: 6, x2: 21, y2: 6 }],
    ["line", { x1: 3, y1: 12, x2: 21, y2: 12 }],
    ["line", { x1: 3, y1: 18, x2: 21, y2: 18 }],
  ],
  external: [
    ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
    ["path", { d: "M15 3h6v6" }],
    ["line", { x1: 10, y1: 14, x2: 21, y2: 3 }],
  ],
  loader: [
    ["line", { x1: 12, y1: 2, x2: 12, y2: 6 }],
    ["line", { x1: 12, y1: 18, x2: 12, y2: 22 }],
    ["line", { x1: 4.9, y1: 4.9, x2: 7.8, y2: 7.8 }],
    ["line", { x1: 16.2, y1: 16.2, x2: 19.1, y2: 19.1 }],
    ["line", { x1: 2, y1: 12, x2: 6, y2: 12 }],
    ["line", { x1: 18, y1: 12, x2: 22, y2: 12 }],
    ["line", { x1: 4.9, y1: 19.1, x2: 7.8, y2: 16.2 }],
    ["line", { x1: 16.2, y1: 7.8, x2: 19.1, y2: 4.9 }],
  ],
  key: [
    ["circle", { cx: 7.5, cy: 15.5, r: 3.5 }],
    ["path", { d: "M10 13l9-9" }],
    ["path", { d: "M18 5l2 2" }],
    ["path", { d: "M15 8l2 2" }],
  ],
  server: [
    ["rect", { x: 3, y: 4, width: 18, height: 7, rx: 1.6 }],
    ["rect", { x: 3, y: 13, width: 18, height: 7, rx: 1.6 }],
    ["line", { x1: 7, y1: 7.5, x2: 7.01, y2: 7.5 }],
    ["line", { x1: 7, y1: 16.5, x2: 7.01, y2: 16.5 }],
  ],
  shield: [
    ["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }],
    ["path", { d: "M9 12l2 2 4-4" }],
  ],
  doc: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }],
    ["path", { d: "M14 2v6h6" }],
    ["line", { x1: 8, y1: 13, x2: 16, y2: 13 }],
    ["line", { x1: 8, y1: 17, x2: 13, y2: 17 }],
  ],
  image: [
    ["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }],
    ["circle", { cx: 8.5, cy: 10, r: 1.5 }],
    ["path", { d: "M21 15l-4.5-4.5L7 19" }],
  ],
  message: [
    ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }],
  ],
  barChart: [
    ["line", { x1: 4, y1: 20, x2: 20, y2: 20 }],
    ["rect", { x: 6, y: 10, width: 3, height: 7, rx: 1 }],
    ["rect", { x: 11, y: 5, width: 3, height: 12, rx: 1 }],
    ["rect", { x: 16, y: 8, width: 3, height: 9, rx: 1 }],
  ],
  trash: [
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M8 6V4h8v2" }],
    ["path", { d: "M19 6l-1 15H6L5 6" }],
    ["path", { d: "M10 11v6" }],
    ["path", { d: "M14 11v6" }],
  ],
  link: [
    ["path", { d: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" }],
    ["path", { d: "M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" }],
  ],
  users: [
    ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }],
    ["circle", { cx: 9, cy: 7, r: 4 }],
    ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.9" }],
    ["path", { d: "M16 3.1a4 4 0 0 1 0 7.8" }],
  ],
  browser: [
    ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ["path", { d: "M3 9h18" }],
    ["path", { d: "M7 6.5h.01" }],
    ["path", { d: "M10 6.5h.01" }],
  ],
  terminal: [
    ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ["path", { d: "m7 9 3 3-3 3" }],
    ["path", { d: "M13 15h4" }],
  ],
  calendar: [
    ["rect", { x: 3, y: 5, width: 18, height: 16, rx: 2 }],
    ["path", { d: "M16 3v4" }],
    ["path", { d: "M8 3v4" }],
    ["path", { d: "M3 10h18" }],
    ["path", { d: "M8 14h.01" }],
    ["path", { d: "M12 14h.01" }],
    ["path", { d: "M16 14h.01" }],
    ["path", { d: "M8 18h.01" }],
    ["path", { d: "M12 18h.01" }],
  ],
  sparkles: [
    ["path", { d: "m12 3 1.25 3.75L17 8l-3.75 1.25L12 13l-1.25-3.75L7 8l3.75-1.25L12 3z" }],
    ["path", { d: "m5 14 .75 2.25L8 17l-2.25.75L5 20l-.75-2.25L2 17l2.25-.75L5 14z" }],
    ["path", { d: "m19 13 .75 2.25L22 16l-2.25.75L19 19l-.75-2.25L16 16l2.25-.75L19 13z" }],
  ],
};
