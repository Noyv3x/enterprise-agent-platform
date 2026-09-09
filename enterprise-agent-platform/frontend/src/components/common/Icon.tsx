import type { IconName } from "../../types";

export interface IconProps { name: IconName; size?: number; cls?: string; strokeWidth?: number }

const paths: Record<IconName, string> = {
  hash: "M9 3 7 21M17 3l-2 18M3 9h18M2 15h18",
  bot: "M12 3v3M10 3h4M5 7h14v13H5zM2 11v5m20-5v5M8 11v2m8-2v2M9 17h6",
  library: "M3 4h4v16H3zM10 4h4v16h-4zM17 4l4 1-2 15-4-1z",
  settings: "m9 3-1 3-3 1-2 4 2 3 1 4 4 3 3-2 4-1 3-4-2-3-1-4-4-3zM9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
  send: "m3 4 19 8L3 20l3-8-3-8Zm3 8h16",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
  moon: "M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z",
  logout: "M10 3H4v18h6M9 12h12m-4-4 4 4-4 4",
  plus: "M12 4v16M4 12h16",
  checkCircle: "M21 11v1a9 9 0 1 1-5-8M8 11l4 4 9-10",
  alert: "m12 3 10 18H2L12 3Zm0 6v5m0 3v1",
  refresh: "M20 7a9 9 0 0 0-15-1L2 9m0-6v6h6M4 17a9 9 0 0 0 15 1l3-3m0 6v-6h-6",
  download: "M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6",
  upload: "M12 15V3m-5 5 5-5 5 5M4 15v6h16v-6",
  paperclip: "m8 16 8-8a2 2 0 0 0-3-3l-9 9a5 5 0 0 0 7 7L21 11a7 7 0 0 0-10-10",
  close: "M5 5l14 14M19 5 5 19",
  menu: "M3 5h18M3 12h18M3 19h18",
  external: "M14 3h7v7m0-7L10 14M10 4H3v17h17v-7",
  loader: "M12 3a9 9 0 1 1-9 9",
  key: "M8 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10m4 9 9 9m-3-3 3-3m-6 0 3-3",
  server: "M3 3h18v7H3zM3 14h18v7H3zM6 6h1m-1 11h1M11 6h7m-7 11h7",
  shield: "m12 2 9 4v7c0 4-5 7-9 9-4-2-9-5-9-9V6l9-4Zm-4 10 3 3 5-6",
  doc: "M4 2h10l6 6v14H4zM14 2v6h6M8 12h8m-8 4h8",
  image: "M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M15 6h1v1h-1z",
  message: "M3 3h18v14H9l-6 5V3Zm4 5h10M7 12h7",
  barChart: "M3 3v18h18M7 17v-6m5 6V6m5 11V9",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  users: "M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M2 21v-3a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v3M17 4a4 4 0 0 1 0 8m2 2a5 5 0 0 1 3 4v3",
  browser: "M2 3h20v18H2zM2 8h20M5 5h1m2 0h1m2 0h1",
  terminal: "M2 3h20v18H2zM6 8l4 4-4 4m7 0h5",
  calendar: "M3 5h18v16H3zM7 2v6m10-6v6M3 10h18M7 14h2m3 0h2m3 0h1M7 18h2m3 0h2",
  sparkles: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7ZM20 2v4m-2-2h4",
  computer: "M2 3h20v14H2zM8 21h8m-4-4v4",
};

export function Icon({ name, size = 18, cls, strokeWidth = 1.6 }: IconProps) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width={size} height={size}
    fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={cls}>
    <path d={paths[name]} />
  </svg>;
}
