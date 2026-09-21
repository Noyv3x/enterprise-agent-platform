const glyphs = {
  home: 'M4 10 12 3l8 7v10H4V10Zm5 10v-7h6v7',
  channel: 'M9 3 7 21M17 3l-2 18M3 9h18M2 15h18',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  admin: 'M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6l-8-3Zm-4 9 3 3 5-6',
  guide: 'M3 4h6c2 0 3 1 3 3v14c0-2-1-3-3-3H3V4Zm9 3c0-2 1-3 3-3h6v14h-6c-2 0-3 1-3 3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M18 6 6 18',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  back: 'M20 12H4m6-6-6 6 6 6',
  plus: 'M12 4v16M4 12h16',
  attach: 'm8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-5 13 8-8',
  send: 'm3 4 18 8-18 8 3-8-3-8Zm3 8h15',
  file: 'M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8M8 17h5',
  terminal: 'm5 7 5 5-5 5M13 17h6',
  browser: 'M3 4h18v16H3V4Zm0 5h18M6 6.5h.1M9 6.5h.1',
  search: 'M16 16 21 21M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  memory: 'M5 4h14v16H5V4Zm3-2v4m8-4v4M8 10h8M8 14h6',
  skill: 'm12 3 2 6 7 3-7 3-2 6-2-6-7-3 7-3 2-6Z',
  schedule: 'M4 5h16v16H4V5Zm3-3v6m10-6v6M4 10h16M8 14h3m3 0h2M8 17h3',
  expand: 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6',
  check: 'm4 12 5 5L20 6',
  warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v1',
  retry: 'M20 8a9 9 0 1 0 0 8M20 3v5h-5',
  more: 'M5 12h.1M12 12h.1M19 12h.1',
  chevron: 'm8 4 8 8-8 8',
  lock: 'M5 10h14v11H5V10Zm3 0V6a4 4 0 0 1 8 0v4m-4 5v2',
  logout: 'M10 3H4v18h6m4-14 5 5-5 5M8 12h11',
  copy: 'M8 8h12v13H8V8ZM4 16H2V2h12v2',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
} as const;
export type GlyphName = keyof typeof glyphs;
export function Glyph({ name, size = 20, className }: { name: GlyphName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={glyphs[name]} /></svg>;
}

