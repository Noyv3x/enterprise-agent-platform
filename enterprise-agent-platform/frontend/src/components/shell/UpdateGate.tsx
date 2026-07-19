import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "../../i18n";
import { endpoints } from "../../lib/endpoints";
import { registerPlatformUpdatingHandler } from "../../lib/api";
import type { PlatformUpdateState, PlatformUpdateStatus } from "../../types";
import { Brand } from "../common/Brand";
import { LanguageSelect } from "../common/LanguageSelect";
import { Spinner } from "../common/Spinner";

const DEFAULT_POLL_MS = 3_000;
const MIN_POLL_MS = 750;
const MAX_POLL_MS = 10_000;
const STATUS_TIMEOUT_MS = 5_000;
const KNOWN_STATES = new Set<PlatformUpdateState>([
  "idle",
  "checking",
  "waiting_for_tasks",
  "launching",
  "updating",
  "failed",
]);

function normalizedRetryAfter(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(parsed)));
}

function normalizeStatus(value: unknown): PlatformUpdateStatus {
  if (!value || typeof value !== "object") throw new Error("Invalid platform update status");
  const raw = value as Record<string, unknown>;
  const state = String(raw.state ?? raw.phase ?? "") as PlatformUpdateState;
  if (!KNOWN_STATES.has(state)) throw new Error("Invalid platform update state");
  return {
    state,
    ...(typeof raw.phase === "string" && KNOWN_STATES.has(raw.phase as PlatformUpdateState)
      ? { phase: raw.phase as PlatformUpdateState }
      : {}),
    ...(typeof raw.instance_id === "string" ? { instance_id: raw.instance_id } : {}),
    retry_after_ms: normalizedRetryAfter(raw.retry_after_ms),
  };
}

export async function fetchPlatformUpdateStatus(
  signal?: AbortSignal,
): Promise<PlatformUpdateStatus> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(endpoints.platformUpdateStatus.path(), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok && response.status !== 503) {
      throw new Error(`Platform update status request failed (${response.status})`);
    }
    return normalizeStatus(payload);
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function blocksPlatform(state: PlatformUpdateState | undefined): boolean {
  return state === "launching" || state === "updating" || state === "failed";
}

interface UpdateStatusScreenProps {
  state: "probing" | "launching" | "updating" | "failed";
}

function UpdateStatusScreen({ state }: UpdateStatusScreenProps) {
  const { t } = useI18n();
  const failed = state === "failed";
  const probing = state === "probing";

  return (
    <main
      className={`update-screen${failed ? " update-screen--failed" : ""}`}
      role={failed ? "alert" : "status"}
      aria-live="polite"
      aria-busy={!failed}
    >
      <div className="update-screen__locale"><LanguageSelect /></div>
      <section className="update-screen__card">
        <Brand />
        <div className="update-screen__indicator" aria-hidden="true">
          {failed ? <span>!</span> : <Spinner size={26} />}
        </div>
        <div className="update-screen__copy">
          <p className="eyebrow">{t("maintenance.eyebrow")}</p>
          <h1>
            {t(
              probing
                ? "maintenance.probingTitle"
                : failed
                  ? "maintenance.failedTitle"
                  : "maintenance.title",
            )}
          </h1>
          <p>
            {t(
              probing
                ? "maintenance.probingDetail"
                : failed
                  ? "maintenance.failedDetail"
                  : "maintenance.detail",
            )}
          </p>
        </div>
        {!probing && !failed ? (
          <div className="update-screen__progress" aria-hidden="true">
            <span />
          </div>
        ) : null}
        <p className="update-screen__hint">
          {t(failed ? "maintenance.failedHint" : "maintenance.hint")}
        </p>
      </section>
    </main>
  );
}

export interface UpdateGateProps {
  children: ReactNode;
  /** Injectable seams keep lifecycle tests deterministic. */
  loadStatus?: (signal?: AbortSignal) => Promise<PlatformUpdateStatus>;
  reload?: () => void;
}

function reloadWindow(): void {
  window.location.reload();
}

export function UpdateGate({
  children,
  loadStatus = fetchPlatformUpdateStatus,
  reload = reloadWindow,
}: UpdateGateProps) {
  const [status, setStatus] = useState<PlatformUpdateStatus | null>(null);
  const statusRef = useRef<PlatformUpdateStatus | null>(null);
  const maintenanceSeen = useRef(false);
  const instanceChanged = useRef(false);
  const baselineInstance = useRef("");
  const reloadRequested = useRef(false);
  const pollNow = useRef<() => void>(() => undefined);
  const maintenanceEpoch = useRef(0);

  const acceptStatus = useCallback((next: PlatformUpdateStatus) => {
    const instanceId = String(next.instance_id || "");
    if (!baselineInstance.current && instanceId) {
      baselineInstance.current = instanceId;
    } else if (
      instanceId &&
      baselineInstance.current &&
      instanceId !== baselineInstance.current
    ) {
      instanceChanged.current = true;
    }

    if (blocksPlatform(next.state)) maintenanceSeen.current = true;
    statusRef.current = next;
    setStatus(next);

    if (
      next.state === "idle" &&
      (maintenanceSeen.current || instanceChanged.current) &&
      !reloadRequested.current
    ) {
      reloadRequested.current = true;
      reload();
    }
  }, [reload]);

  useEffect(() => {
    let stopped = false;
    let running = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const schedule = (delay: number) => {
      clearTimer();
      if (!stopped && !document.hidden) {
        timer = window.setTimeout(() => void poll(), delay);
      }
    };
    const poll = async () => {
      if (stopped || running || document.hidden) return;
      running = true;
      controller = new AbortController();
      const requestEpoch = maintenanceEpoch.current;
      let delay = normalizedRetryAfter(statusRef.current?.retry_after_ms);
      try {
        const next = await loadStatus(controller.signal);
        if (stopped) return;
        if (requestEpoch !== maintenanceEpoch.current) {
          delay = MIN_POLL_MS;
          return;
        }
        delay = normalizedRetryAfter(next.retry_after_ms);
        acceptStatus(next);
      } catch {
        // Once maintenance has been observed, a restart-related network gap
        // must never reveal a usable application underneath it.
      } finally {
        running = false;
        controller = null;
        schedule(delay);
      }
    };

    pollNow.current = () => {
      clearTimer();
      if (!running) void poll();
    };
    const unregister = registerPlatformUpdatingHandler(() => {
      maintenanceEpoch.current += 1;
      maintenanceSeen.current = true;
      const forced: PlatformUpdateStatus = {
        state: "updating",
        instance_id: statusRef.current?.instance_id,
        retry_after_ms: MIN_POLL_MS,
      };
      statusRef.current = forced;
      setStatus(forced);
      controller?.abort();
      if (!running) pollNow.current();
    });
    const resume = () => {
      if (!document.hidden) pollNow.current();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    void poll();

    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      unregister();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      pollNow.current = () => undefined;
    };
  }, [acceptStatus, loadStatus]);

  if (!status) return <UpdateStatusScreen state="probing" />;
  if (blocksPlatform(status.state)) {
    const screenState: UpdateStatusScreenProps["state"] =
      status.state === "failed"
        ? "failed"
        : status.state === "launching"
          ? "launching"
          : "updating";
    return (
      <UpdateStatusScreen state={screenState} />
    );
  }
  return <>{children}</>;
}
