import type { ReactNode } from "react";
import { useBranding } from "../../context/BrandingContext";
import { useTheme } from "../../hooks/useTheme";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { BeautifulRoot } from "./beautiful/Root";

export function BeautifulProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const { branding } = useBranding();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  return <BeautifulRoot mode={theme} primaryColor={branding.primary_color} motion={!reducedMotion}>{children}</BeautifulRoot>;
}
