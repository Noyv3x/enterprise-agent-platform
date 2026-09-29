import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "../i18n";
import { endpoints } from "../lib/endpoints";
import type { BrandingSnapshot } from "../types";

export const BRANDING_CACHE_KEY = "agent-platform.branding:v1";
export const DEFAULT_BRANDING: BrandingSnapshot = Object.freeze({
  schema_version: 1,
  revision: 0,
  product_name: "Agent Platform",
  agent_name: "Agent",
  primary_color: "#1677ff",
  logo_url: null,
});

export interface BrandingCache {
  snapshot: BrandingSnapshot;
}

interface BrandingContextValue {
  branding: BrandingSnapshot;
  applyBranding: (snapshot: BrandingSnapshot) => void;
}

const defaultContext: BrandingContextValue = {
  branding: DEFAULT_BRANDING,
  applyBranding: () => undefined,
};

const BrandingContext = createContext<BrandingContextValue>(defaultContext);
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const CONTROL_RE = /\p{C}/u;
const LINE_SEPARATOR_RE = /[\u2028\u2029]/u;

export function isValidBrandingName(value: string): boolean {
  const normalized = value.trim().normalize("NFC");
  return normalized.length > 0
    && Array.from(normalized).length <= 64
    && !CONTROL_RE.test(normalized)
    && !LINE_SEPARATOR_RE.test(normalized);
}

function normalizedName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.trim().normalize("NFC") : "";
  if (!isValidBrandingName(name)) return fallback;
  return name;
}

function currentOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}

function normalizedLogoUrl(value: unknown, revision: number, origin: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.startsWith("//")) return null;
  try {
    const parsed = new URL(value, origin);
    if (
      parsed.origin !== origin ||
      parsed.pathname !== endpoints.platformBranding.path().replace(/\/branding$/, "/branding/logo") ||
      parsed.searchParams.get("v") !== String(revision)
    ) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function parseBrandingSnapshot(
  value: unknown,
  origin = currentOrigin(),
): BrandingSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const revision = raw.revision;
  if (
    raw.schema_version !== 1
    || typeof revision !== "number"
    || !Number.isSafeInteger(revision)
    || revision < 0
  ) {
    return null;
  }
  const primaryColor = typeof raw.primary_color === "string"
    ? raw.primary_color.trim()
    : "";
  const productName = normalizedName(raw.product_name, "");
  const agentName = normalizedName(raw.agent_name, "");
  const logoUrl = normalizedLogoUrl(raw.logo_url, revision, origin);
  if (
    !productName
    || !agentName
    || !COLOR_RE.test(primaryColor)
    || (raw.logo_url !== null && !logoUrl)
  ) {
    return null;
  }
  return {
    schema_version: 1,
    revision,
    product_name: productName,
    agent_name: agentName,
    primary_color: primaryColor.toLowerCase(),
    logo_url: logoUrl,
  };
}

/** Fail closed to the neutral baseline for malformed public data. */
export function normalizeBrandingSnapshot(
  value: unknown,
  origin = currentOrigin(),
): BrandingSnapshot {
  return parseBrandingSnapshot(value, origin) ?? DEFAULT_BRANDING;
}


export function parseBrandingCache(
  raw: string | null | undefined,
  origin = currentOrigin(),
): BrandingCache | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const snapshot = parseBrandingSnapshot(parsed.snapshot, origin);
    if (!snapshot) return null;
    return { snapshot };
  } catch {
    return null;
  }
}

function readBrandingCache(): BrandingCache | null {
  if (typeof window === "undefined") return null;
  try {
    return parseBrandingCache(window.localStorage.getItem(BRANDING_CACHE_KEY));
  } catch {
    return null;
  }
}

function clearBrandingCache(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(BRANDING_CACHE_KEY) !== null) {
      window.localStorage.removeItem(BRANDING_CACHE_KEY);
    }
  } catch {
    // The in-memory neutral fallback remains authoritative for this tab.
  }
}

function writeBrandingCache(cache: BrandingCache): void {
  if (typeof window === "undefined") return;
  try {
    const serialized = JSON.stringify(cache);
    if (window.localStorage.getItem(BRANDING_CACHE_KEY) !== serialized) {
      window.localStorage.setItem(BRANDING_CACHE_KEY, serialized);
    }
  } catch {
    // Public branding remains available in memory when storage is unavailable.
  }
}

export async function fetchPublicBranding(
  signal?: AbortSignal,
): Promise<BrandingSnapshot | null> {
  const response = await fetch(endpoints.platformBranding.path(), {
    method: "GET",
    credentials: "include",
    cache: "no-cache",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Branding request failed (${response.status})`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  return parseBrandingSnapshot(payload);
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { locale, t } = useI18n();
  const [branding, setBranding] = useState<BrandingSnapshot>(
    () => readBrandingCache()?.snapshot ?? DEFAULT_BRANDING,
  );
  const requestRef = useRef<AbortController | null>(null);

  const commitBranding = useCallback((snapshot: BrandingSnapshot | null) => {
    setBranding(snapshot ?? DEFAULT_BRANDING);
    if (snapshot) writeBrandingCache({ snapshot });
    else clearBrandingCache();
  }, []);

  const applyBranding = useCallback((snapshot: BrandingSnapshot) => {
    // A completed admin save supersedes any public read started before it.
    requestRef.current?.abort();
    commitBranding(parseBrandingSnapshot(snapshot));
  }, [commitBranding]);

  useEffect(() => {
    const refresh = () => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      void fetchPublicBranding(controller.signal).then((snapshot) => {
        if (!controller.signal.aborted) commitBranding(snapshot);
      }).catch(() => undefined);
    };
    const onStorage = (event: StorageEvent) => {
      // Other tabs provide an invalidation hint, never authoritative data.
      if (event.key === BRANDING_CACHE_KEY || event.key === null) refresh();
    };
    refresh();
    window.addEventListener("storage", onStorage);
    return () => {
      requestRef.current?.abort();
      window.removeEventListener("storage", onStorage);
    };
  }, [commitBranding]);

  useEffect(() => {
    document.title = branding.product_name;
    document.querySelector('meta[name="description"]')?.setAttribute(
      "content",
      t("app.description", { product: branding.product_name }),
    );
    document.documentElement.style.setProperty("--deployment-brand", branding.primary_color);
    return () => {
      document.documentElement.style.removeProperty("--deployment-brand");
    };
  }, [branding, locale, t]);

  const value = useMemo(() => ({ branding, applyBranding }), [applyBranding, branding]);
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext);
}
