/* Brand color → Beautiful UI accent tokens (--accent, --accent-ink, --accent-tint) for light and dark.
 * The brand color is used as given for --accent (send button, focus ring, small emphasis). --accent-ink is the same
 * hue with its OKLCH lightness moved until text drawn in it reaches 4.5:1 on every ground it is used on (page,
 * surface and the accent tint), so any valid brand color stays readable. Ink stays the primary button color. */

type Rgb = readonly [number, number, number];
type Oklch = readonly [number, number, number];

export interface AccentTokens {
  accent: string;
  accentInk: string;
  accentTint: string;
}

/** Upstream grounds (foundation.css) the accent text sits on, as OKLCH. */
const GROUNDS = {
  light: { page: [0.985, 0.001, 286.376], surface: [1, 0, 0] },
  dark: { page: [0.209, 0.004, 264.477], surface: [0.26, 0.006, 271.191] },
} as const satisfies Record<string, Record<string, Oklch>>;

const TEXT_CONTRAST = 4.5;
/** The accent itself (focus ring, send button fill, markers) keeps the WCAG non-text floor against the grounds. */
const MARK_CONTRAST = 3;
/** Tint strength over the surface: upstream's light tint is ~8% of the accent, dark is 16% alpha. */
const TINT = { light: 0.1, dark: 0.16 } as const;

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklch(rgb: Rgb): Oklch {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(B, A) * 180) / Math.PI;
  return [L, Math.hypot(A, B), hue < 0 ? hue + 360 : hue];
}

/** Linear sRGB, possibly out of gamut. */
function oklchToLinear([L, C, H]: Oklch): Rgb {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (linear: Rgb) => linear.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);

/** sRGB for an OKLCH color, reducing chroma (same lightness and hue) until it fits the gamut. */
export function oklchToRgb(color: Oklch): Rgb {
  let [L, C, H] = color;
  L = Math.min(1, Math.max(0, L));
  let linear = oklchToLinear([L, C, H]);
  if (!inGamut(linear)) {
    let low = 0;
    let high = C;
    for (let step = 0; step < 24; step += 1) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear([L, mid, H]))) low = mid;
      else high = mid;
    }
    C = low;
    linear = oklchToLinear([L, C, H]);
  }
  return linear.map((channel) => fromLinear(Math.min(1, Math.max(0, channel)))) as unknown as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two sRGB colors. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(top: Rgb, bottom: Rgb, amount: number): Rgb {
  return top.map((channel, index) => channel * amount + bottom[index] * (1 - amount)) as unknown as Rgb;
}

/** Same hue and chroma, lightness moved (darker on light grounds, lighter on dark) until every ground passes. */
function readable(brand: Oklch, grounds: Rgb[], dark: boolean, floor: number): Rgb {
  const passes = (rgb: Rgb) => grounds.every((ground) => contrast(rgb, ground) >= floor);
  const start = oklchToRgb(brand);
  if (passes(start)) return start;
  let L = brand[0];
  for (let step = 0; step < 100; step += 1) {
    L = dark ? Math.min(1, L + 0.01) : Math.max(0, L - 0.01);
    const candidate = oklchToRgb([L, brand[1], brand[2]]);
    if (passes(candidate)) return candidate;
  }
  return dark ? [1, 1, 1] : [0, 0, 0];
}

function tokensFor(brandHex: string, mode: "light" | "dark"): AccentTokens {
  const brand = hexToRgb(brandHex);
  const brandLch = rgbToOklch(brand);
  const page = oklchToRgb(GROUNDS[mode].page);
  const surface = oklchToRgb(GROUNDS[mode].surface);
  const tint = mix(brand, surface, TINT[mode]);
  // Dark mode lifts the accent a little, as upstream does (0.626 → 0.68), so the ring and send button keep presence.
  const lifted: Oklch = mode === "dark" && brandLch[0] < 0.68 ? [0.68, brandLch[1], brandLch[2]] : brandLch;
  const accent = readable(lifted, [page, surface], mode === "dark", MARK_CONTRAST);
  const ink = readable(rgbToOklch(accent), [page, surface, tint], mode === "dark", TEXT_CONTRAST);
  return { accent: rgbToHex(accent), accentInk: rgbToHex(ink), accentTint: rgbToHex(tint) };
}

/** Accent tokens for both themes from a validated `#rrggbb` brand color. */
export function brandAccentTokens(brandHex: string): { light: AccentTokens; dark: AccentTokens } {
  return { light: tokensFor(brandHex, "light"), dark: tokensFor(brandHex, "dark") };
}

/** CSS that overrides the upstream accent tokens; `:root:root` / `:root.dark` outrank foundation.css. */
export function brandAccentCss(brandHex: string): string {
  const { light, dark } = brandAccentTokens(brandHex);
  const block = (tokens: AccentTokens) =>
    `--accent:${tokens.accent};--accent-ink:${tokens.accentInk};--accent-tint:${tokens.accentTint};`;
  return `:root:root{${block(light)}}:root.dark{${block(dark)}}`;
}

/** Contrast helpers for tests and the admin preview. */
export function hexContrast(a: string, b: string): number {
  return contrast(hexToRgb(a), hexToRgb(b));
}

export function groundHex(mode: "light" | "dark", ground: "page" | "surface"): string {
  return rgbToHex(oklchToRgb(GROUNDS[mode][ground]));
}
