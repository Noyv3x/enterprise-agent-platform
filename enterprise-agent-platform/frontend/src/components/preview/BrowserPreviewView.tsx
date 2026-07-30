import { Button, Input, Space, Spin, Tag } from "antd";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  acquireBrowserControl,
  releaseBrowserControl,
  sendBrowserControlInput,
  type BrowserControlInput,
} from "../../data/previewActions";
import { intlLocale, useI18n } from "../../i18n";
import { isApiError } from "../../lib/api";
import type { AgentPreviewScope } from "../../types";
import { EmptyState } from "../common/EmptyState";
import { Icon } from "../common/Icon";
import { InlineAlert } from "../common/InlineAlert";
import { PreviewStatus } from "./PreviewStatus";
import { useBrowserPreview } from "./useBrowserPreview";

function previewTime(value: string | number | null, locale: string): string {
  if (value == null || value === "") return "";
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const DEFAULT_BROWSER_LEASE_MS = 90_000;

interface ActiveBrowserLease {
  id: string;
  tabId: string;
  expiresAt: number;
  generation: number;
  scope: AgentPreviewScope;
}

export function BrowserPreviewView({ scope }: { scope: AgentPreviewScope }) {
  const { t, locale } = useI18n();
  const { state, refresh } = useBrowserPreview(scope);
  const [lease, setLease] = useState<ActiveBrowserLease | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState("");
  const [textInput, setTextInput] = useState("");
  const sequenceRef = useRef(0);
  const leaseGenerationRef = useRef(0);
  const leaseRef = useRef<ActiveBrowserLease | null>(null);
  const controlQueueRef = useRef<Promise<void>>(Promise.resolve());
  const acquireInFlightRef = useRef(false);
  const mountedRef = useRef(false);
  const viewGenerationRef = useRef(0);
  const controlLifecycleRef = useRef(0);
  const currentTabRef = useRef(state.tabId);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUpdate = previewTime(state.capturedAt || state.checkedAt, intlLocale(locale));
  const scopeKey = `${scope.scope_type}:${String(scope.scope_id)}`;
  currentTabRef.current = state.tabId;
  const controlling = Boolean(
    lease
    && lease.tabId === state.tabId
    && `${lease.scope.scope_type}:${String(lease.scope.scope_id)}` === scopeKey,
  );

  const enqueueControl = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const next = controlQueueRef.current.catch(() => undefined).then(operation);
    controlQueueRef.current = next.then(() => undefined, () => undefined);
    return next;
  }, []);

  const queueBestEffortRelease = useCallback((active: ActiveBrowserLease) => {
    void enqueueControl(() => releaseBrowserControl(
      active.scope,
      active.tabId,
      active.id,
    )).catch(() => undefined);
  }, [enqueueControl]);

  const relinquishLease = useCallback((
    expected: ActiveBrowserLease | null = leaseRef.current,
    message = "",
  ) => {
    const current = leaseRef.current;
    if (!expected || !current || current.generation !== expected.generation) return;
    leaseRef.current = null;
    sequenceRef.current = 0;
    setLease(null);
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (message) setControlError(message);
    queueBestEffortRelease(expected);
  }, [queueBestEffortRelease]);

  const refreshLeaseExpiry = useCallback((
    active: ActiveBrowserLease,
    expiresInMs: number | undefined,
  ) => {
    const current = leaseRef.current;
    if (!current || current.generation !== active.generation) return;
    const duration = typeof expiresInMs === "number" && Number.isFinite(expiresInMs) && expiresInMs > 0
      ? expiresInMs
      : DEFAULT_BROWSER_LEASE_MS;
    const next = { ...current, expiresAt: Date.now() + duration };
    leaseRef.current = next;
    setLease(next);
  }, []);

  const sendInput = useCallback((input: BrowserControlInput) => {
    const active = leaseRef.current;
    if (!active || currentTabRef.current !== active.tabId) return;
    const sequence = ++sequenceRef.current;
    void enqueueControl(async () => {
      const current = leaseRef.current;
      if (!current || current.generation !== active.generation) return;
      if (Date.now() >= current.expiresAt) {
        relinquishLease(current);
        return;
      }
      setControlError("");
      try {
        const result = await sendBrowserControlInput(
          current.scope,
          current.tabId,
          current.id,
          sequence,
          input,
        );
        refreshLeaseExpiry(current, result.expires_in_ms);
        refresh();
      } catch (error) {
        if (isApiError(error, 409)) {
          relinquishLease(current, t("browserPreview.controlExpired"));
          return;
        }
        if (leaseRef.current?.generation === current.generation) {
          setControlError(error instanceof Error ? error.message : String(error));
        }
      }
    });
  }, [enqueueControl, refresh, refreshLeaseExpiry, relinquishLease, t]);

  const endControl = useCallback(() => {
    relinquishLease();
  }, [relinquishLease]);

  useEffect(() => {
    const generation = ++viewGenerationRef.current;
    mountedRef.current = true;
    const active = leaseRef.current;
    if (
      active
      && `${active.scope.scope_type}:${String(active.scope.scope_id)}` !== scopeKey
    ) {
      leaseRef.current = null;
      sequenceRef.current = 0;
      setLease(null);
      queueBestEffortRelease(active);
    }
    return () => {
      if (viewGenerationRef.current === generation) {
        mountedRef.current = false;
        viewGenerationRef.current += 1;
      }
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      const latest = leaseRef.current;
      if (latest) {
        leaseRef.current = null;
        sequenceRef.current = 0;
        queueBestEffortRelease(latest);
      }
    };
  }, [queueBestEffortRelease, scopeKey]);

  useEffect(() => {
    const active = leaseRef.current;
    if (active && active.tabId !== state.tabId) {
      controlLifecycleRef.current += 1;
      relinquishLease(active);
    }
  }, [relinquishLease, state.tabId]);

  useEffect(() => {
    if (!lease) return;
    const remaining = lease.expiresAt - Date.now();
    if (remaining <= 0) {
      relinquishLease(lease);
      return;
    }
    const timer = setTimeout(() => relinquishLease(lease), remaining);
    return () => clearTimeout(timer);
  }, [lease, relinquishLease]);

  useEffect(() => {
    const onBlur = () => {
      controlLifecycleRef.current += 1;
      relinquishLease();
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        controlLifecycleRef.current += 1;
        relinquishLease();
      }
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [relinquishLease]);

  const beginControl = async () => {
    const requestedTab = state.tabId;
    if (!requestedTab || controlBusy || acquireInFlightRef.current) return;
    const previousLease = leaseRef.current;
    if (previousLease) relinquishLease(previousLease);
    const requestedScope: AgentPreviewScope = {
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
    };
    const viewGeneration = viewGenerationRef.current;
    const controlLifecycle = controlLifecycleRef.current;
    acquireInFlightRef.current = true;
    setControlBusy(true);
    setControlError("");
    try {
      const result = await enqueueControl(() => acquireBrowserControl(
        requestedScope,
        requestedTab,
      ));
      if (!result.lease_id) throw new Error(t("browserPreview.controlFailed"));
      const active: ActiveBrowserLease = {
        id: result.lease_id,
        tabId: requestedTab,
        expiresAt: Date.now() + (
          result.expires_in_ms && result.expires_in_ms > 0
            ? result.expires_in_ms
            : DEFAULT_BROWSER_LEASE_MS
        ),
        generation: ++leaseGenerationRef.current,
        scope: requestedScope,
      };
      if (
        !mountedRef.current
        || viewGenerationRef.current !== viewGeneration
        || controlLifecycleRef.current !== controlLifecycle
        || currentTabRef.current !== requestedTab
        || document.hidden
      ) {
        queueBestEffortRelease(active);
        return;
      }
      sequenceRef.current = 0;
      leaseRef.current = active;
      setLease(active);
    } catch (error) {
      if (mountedRef.current && viewGenerationRef.current === viewGeneration) {
        setControlError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      acquireInFlightRef.current = false;
      if (mountedRef.current && viewGenerationRef.current === viewGeneration) {
        setControlBusy(false);
      }
    }
  };

  const frameCoordinates = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const image = imageRef.current;
    if (!image || !image.naturalWidth || !image.naturalHeight) return null;
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const shownWidth = image.naturalWidth * scale;
    const shownHeight = image.naturalHeight * scale;
    const left = rect.left + (rect.width - shownWidth) / 2;
    const top = rect.top + (rect.height - shownHeight) / 2;
    if (clientX < left || clientX > left + shownWidth || clientY < top || clientY > top + shownHeight) return null;
    return { x: (clientX - left) / scale, y: (clientY - top) / scale };
  };

  const onFrameClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!controlling) return;
    const point = frameCoordinates(event.clientX, event.clientY);
    if (!point) return;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    if (event.detail > 1) {
      clickTimerRef.current = null;
      void sendInput({ action: "double_click", ...point });
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      void sendInput({ action: "click", ...point });
    }, 220);
  };

  return (
    <section className="browser-preview" aria-label={t("browserPreview.title")}>
      <header className="preview-toolbar">
        <div className="preview-toolbar__status">
          <PreviewStatus connection={state.connection} idle={state.activity === "idle"} />
          <Tag className="preview-readonly" icon={<Icon name="shield" size={12} />}>
            {controlling ? t("browserPreview.assisting") : t("preview.readOnly")}
          </Tag>
          {lastUpdate ? <span className="preview-updated">{t("preview.updatedAt", { time: lastUpdate })}</span> : null}
        </div>
        <Space size={6}>
          {state.tabId ? (
            <Button
              size="small"
              type={controlling ? "default" : "primary"}
              danger={controlling}
              loading={controlBusy}
              onClick={() => controlling ? void endControl() : void beginControl()}
            >
              {controlling ? t("browserPreview.endControl") : t("browserPreview.takeControl")}
            </Button>
          ) : null}
          <Button className="preview-toolbar__action" size="small" icon={<Icon name="refresh" size={14} />} onClick={refresh}>
            <span>{t("preview.refresh")}</span>
          </Button>
        </Space>
      </header>
      {state.error ? (
        <InlineAlert variant="warning">{state.error || t("preview.loadFailed")}</InlineAlert>
      ) : null}
      {controlError ? <InlineAlert variant="warning">{controlError}</InlineAlert> : null}
      {controlling ? (
        <div className="browser-preview__controls">
          <Space.Compact>
            <Button size="small" onClick={() => void sendInput({ action: "back" })}>{t("browserPreview.back")}</Button>
            <Button size="small" onClick={() => void sendInput({ action: "forward" })}>{t("browserPreview.forward")}</Button>
            <Button size="small" onClick={() => void sendInput({ action: "refresh" })}>{t("browserPreview.reload")}</Button>
          </Space.Compact>
          <Space.Compact className="browser-preview__text-control">
            <Input
              size="small"
              value={textInput}
              maxLength={4096}
              placeholder={t("browserPreview.typePlaceholder")}
              onChange={(event) => setTextInput(event.target.value)}
              onPressEnter={() => {
                if (!textInput) return;
                void sendInput({ action: "text", text: textInput });
                setTextInput("");
              }}
            />
            <Button size="small" disabled={!textInput} onClick={() => {
              if (!textInput) return;
              void sendInput({ action: "text", text: textInput });
              setTextInput("");
            }}>{t("browserPreview.typeSend")}</Button>
          </Space.Compact>
        </div>
      ) : null}
      <div className="browser-preview__window">
        <div className="browser-preview__chrome" aria-hidden="true">
          <span className="browser-preview__lights"><i /><i /><i /></span>
          <div className="browser-preview__address">
            <Icon name="shield" size={12} />
            <span>{state.url || state.title || t("browserPreview.page")}</span>
          </div>
        </div>
        <div
          className={controlling ? "browser-preview__screen is-controlling" : "browser-preview__screen"}
          tabIndex={controlling ? 0 : -1}
          role={controlling ? "application" : undefined}
          aria-label={controlling ? t("browserPreview.controlSurface") : undefined}
          onClick={onFrameClick}
          onWheel={(event) => {
            if (!controlling) return;
            event.preventDefault();
            void sendInput({ action: "wheel", delta_x: Math.round(event.deltaX), delta_y: Math.round(event.deltaY) });
          }}
          onKeyDown={(event) => {
            if (!controlling || event.target !== event.currentTarget) return;
            const allowed = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
            if (!allowed.has(event.key)) return;
            event.preventDefault();
            void sendInput({ action: "key", key: event.key === " " ? "Space" : event.key });
          }}
        >
          {state.frameUrl ? (
            <img
              ref={imageRef}
              src={state.frameUrl}
              alt={t("browserPreview.frameAlt")}
              draggable={false}
            />
          ) : state.activity === "idle" ? (
            <EmptyState
              icon="browser"
              title={t("browserPreview.noBrowser")}
              text={t("browserPreview.noBrowserDetail")}
            />
          ) : (
            <div
              className="browser-preview__loading"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              <Spin size="large" />
              <h3>{t("browserPreview.loadingFrame")}</h3>
              <p>{t("browserPreview.loadingFrameDetail")}</p>
            </div>
          )}
          {!controlling ? <div className="browser-preview__readonly-shield" aria-hidden="true" /> : null}
        </div>
      </div>
      {state.title || state.url ? (
        <footer className="browser-preview__meta">
          <strong>{state.title || t("browserPreview.page")}</strong>
          {state.url ? <span>{state.url}</span> : null}
        </footer>
      ) : null}
    </section>
  );
}
