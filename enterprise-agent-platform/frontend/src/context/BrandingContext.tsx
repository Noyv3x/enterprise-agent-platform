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
  etag?: string;
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
const STORAGE_REVALIDATE_DELAY_MS = 40;

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

function brandingEtag(revision: number): string {
  return `"branding-${revision}"`;
}

function validatedBrandingEtag(value: unknown, revision: number): string | undefined {
  return value === brandingEtag(revision) ? value : undefined;
}

function sameBrandingSnapshot(left: BrandingSnapshot, right: BrandingSnapshot): boolean {
  return left.schema_version === right.schema_version
    && left.revision === right.revision
    && left.product_name === right.product_name
    && left.agent_name === right.agent_name
    && left.primary_color === right.primary_color
    && left.logo_url === right.logo_url;
}

function sameBrandingCache(left: BrandingCache | null, right: BrandingCache): boolean {
  return Boolean(
    left
    && left.etag === right.etag
    && sameBrandingSnapshot(left.snapshot, right.snapshot),
  );
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
    const etag = validatedBrandingEtag(parsed.etag, snapshot.revision);
    return {
      snapshot,
      ...(etag ? { etag } : {}),
    };
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
  cached: BrandingCache | null,
  signal?: AbortSignal,
): Promise<BrandingCache | null> {
  const headers = new Headers({ Accept: "application/json" });
  const cachedSnapshot = cached ? parseBrandingSnapshot(cached.snapshot) : null;
  const cachedEtag = cachedSnapshot
    ? validatedBrandingEtag(cached?.etag, cachedSnapshot.revision)
    : undefined;
  if (cachedEtag) headers.set("If-None-Match", cachedEtag);
  const response = await fetch(endpoints.platformBranding.path(), {
    method: "GET",
    credentials: "include",
    cache: "no-cache",
    headers,
    signal,
  });
  if (response.status === 304 && cachedSnapshot && cachedEtag) {
    return { snapshot: cachedSnapshot, etag: cachedEtag };
  }
  if (!response.ok) throw new Error(`Branding request failed (${response.status})`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const snapshot = parseBrandingSnapshot(payload);
  if (!snapshot) return null;
  const etag = validatedBrandingEtag(response.headers.get("ETag"), snapshot.revision);
  return {
    snapshot,
    ...(etag ? { etag } : {}),
  };
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { locale, t } = useI18n();
  const [initialCache] = useState<BrandingCache | null>(() => readBrandingCache());
  const [branding, setBranding] = useState<BrandingSnapshot>(
    () => initialCache?.snapshot ?? DEFAULT_BRANDING,
  );
  const brandingRef = useRef(branding);
  const cacheRef = useRef<BrandingCache | null>(initialCache);

  const acceptMonotonicBranding = useCallback((next: BrandingCache): boolean => {
    const current = brandingRef.current;
    const identical = sameBrandingSnapshot(current, next.snapshot);
    if (
      next.snapshot.revision < current.revision
      || (next.snapshot.revision === current.revision && !identical)
    ) {
      return false;
    }
    const cacheChanged = !sameBrandingCache(cacheRef.current, next);
    brandingRef.current = next.snapshot;
    cacheRef.current = next;
    if (!identical) setBranding(next.snapshot);
    if (cacheChanged) writeBrandingCache(next);
    return true;
  }, []);

  const acceptPublicBranding = useCallback((
    next: BrandingCache,
    requestBaseline: BrandingSnapshot,
  ) => {
    if (sameBrandingSnapshot(brandingRef.current, requestBaseline)) {
      const identical = sameBrandingSnapshot(brandingRef.current, next.snapshot);
      const cacheChanged = !sameBrandingCache(cacheRef.current, next);
      brandingRef.current = next.snapshot;
      cacheRef.current = next;
      if (!identical) setBranding(next.snapshot);
      if (cacheChanged) writeBrandingCache(next);
      return;
    }
    acceptMonotonicBranding(next);
  }, [acceptMonotonicBranding]);

  const resetInvalidPublicBranding = useCallback(() => {
    brandingRef.current = DEFAULT_BRANDING;
    cacheRef.current = null;
    setBranding(DEFAULT_BRANDING);
    clearBrandingCache();
  }, []);

  const applyBranding = useCallback((snapshot: BrandingSnapshot) => {
    const normalized = parseBrandingSnapshot(snapshot);
    if (!normalized) {
      resetInvalidPublicBranding();
      return;
    }
    acceptMonotonicBranding({ snapshot: normalized });
  }, [acceptMonotonicBranding, resetInvalidPublicBranding]);

  useEffect(() => {
    let stopped = false;
    let requestSequence = 0;
    let controller: AbortController | null = null;
    let storageTimer: number | null = null;

    const startRequest = (cached: BrandingCache | null) => {
      requestSequence += 1;
      const sequence = requestSequence;
      const requestBaseline = brandingRef.current;
      controller?.abort();
      controller = new AbortController();
      void fetchPublicBranding(cached, controller.signal).then((next) => {
        if (stopped || sequence !== requestSequence) return;
        if (!next) {
          if (sameBrandingSnapshot(brandingRef.current, requestBaseline)) {
            resetInvalidPublicBranding();
          }
          return;
        }
        acceptPublicBranding(next, requestBaseline);
      }).catch(() => undefined);
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== BRANDING_CACHE_KEY) return;
      // A storage payload can be stale after a Manager rollback. Treat every
      // event only as a hint and converge through an unconditional public GET.
      requestSequence += 1;
      controller?.abort();
      if (storageTimer !== null) window.clearTimeout(storageTimer);
      storageTimer = window.setTimeout(() => {
        storageTimer = null;
        startRequest(null);
      }, STORAGE_REVALIDATE_DELAY_MS);
    };

    // Normalize an invalid cached ETag once at mount, before the initial
    // conditional request. Storage events themselves never write cache data.
    if (cacheRef.current) writeBrandingCache(cacheRef.current);
    else clearBrandingCache();
    startRequest(cacheRef.current);
    window.addEventListener("storage", onStorage);
    return () => {
      stopped = true;
      requestSequence += 1;
      controller?.abort();
      if (storageTimer !== null) window.clearTimeout(storageTimer);
      window.removeEventListener("storage", onStorage);
    };
  }, [acceptPublicBranding, resetInvalidPublicBranding]);

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
