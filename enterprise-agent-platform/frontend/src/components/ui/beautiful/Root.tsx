import { createContext, useContext, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";

export const PortalContext = createContext<React.RefObject<HTMLDivElement | null> | undefined>(undefined);
export function useBeautifulContainer() { return useContext(PortalContext); }

function luminance(color: number[]) {
  const linear = color.map((component) => { const s = component / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
function brandVariables(raw: string | undefined, mode: "light" | "dark"): CSSProperties {
  if (!raw || !/^#[\da-f]{6}$/i.test(raw)) return {};
  const base = [1, 3, 5].map((offset) => Number.parseInt(raw.slice(offset, offset + 2), 16));
  // Bounds also include the most contrasting possible 10% branding tint.
  const backdrop = mode === "dark" ? [62, 64, 68] : [224, 226, 230];
  const target = mode === "dark" ? [247, 248, 250] : [24, 26, 29];
  const contrast = (a: number, b: number) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  const backdropLuminance = luminance(backdrop);
  let accessible = base;
  for (let step = 0; step <= 100; step++) {
    accessible = base.map((value, index) => Math.round(value + (target[index]! - value) * step / 100));
    if (contrast(luminance(accessible), backdropLuminance) >= 4.5) break;
  }
  const baseLuminance = luminance(base);
  const onAccent = contrast(baseLuminance, luminance([253, 254, 254])) >= contrast(baseLuminance, luminance([3, 4, 5])) ? "rgb(253 254 254)" : "rgb(3 4 5)";
  return { "--accent": raw, "--accent-ink": `rgb(${accessible.join(" ")})`, "--accent-tint": `color-mix(in srgb, ${raw} 10%, var(--surface))`, "--on-accent": onAccent } as CSSProperties;
}
export interface BeautifulRootProps { mode: "light" | "dark"; primaryColor?: string; motion?: boolean; children: ReactNode }
export function BeautifulRoot({ mode, primaryColor, motion = true, children }: BeautifulRootProps) {
  const root = useRef<HTMLDivElement>(null);
  const variables = useMemo(() => brandVariables(primaryColor, mode), [primaryColor, mode]);
  return <div ref={root} className={`bui-root ${mode}`} data-motion={motion ? "full" : "reduced"} style={variables}><PortalContext.Provider value={root}><Tooltip.Provider>{children}</Tooltip.Provider></PortalContext.Provider></div>;
}
