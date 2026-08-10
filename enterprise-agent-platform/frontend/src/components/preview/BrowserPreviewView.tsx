import { Button, Input, Space, Spin, Tag } from "antd";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  acquireBrowserControl,
  releaseBrowserControl,
  sendBrowserControlInput,
  type BrowserControlInput,
} from "../../data/previewActions";
import { intlLocale, useI18n } from "../../i18n";
import { isApiError } from "../../lib/api";
import {
  BROWSER_CONTROL_RELINQUISH_EVENT,
  browserControlRelinquishScope,
  waitForBrowserControlRelinquish,
} from "../../lib/browserControl";
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
const DRAG_MOVEMENT_THRESHOLD_PX = 6;
const MAX_DRAG_POINTS = 64;
const MAX_LOCAL_DRAG_POINTS = 256;
const MAX_DRAG_DURATION_MS = 10_000;

interface BrowserDragPoint {
  x: number;
  y: number;
  at_ms: number;
}

interface ActivePointerGesture {
  pointerId: number;
  surface: HTMLDivElement;
  startedAt: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
  points: BrowserDragPoint[];
}

interface LocalPointerFeedback {
  left: number;
  top: number;
  dragging: boolean;
}

function compressDragPoints(points: BrowserDragPoint[]): BrowserDragPoint[] {
  if (points.length <= MAX_DRAG_POINTS) return points;
  const compressed = [points[0]!];
  const finalIndex = points.length - 1;
  for (let index = 1; index < MAX_DRAG_POINTS - 1; index += 1) {
    compressed.push(points[Math.round((index * finalIndex) / (MAX_DRAG_POINTS - 1))]!);
  }
  compressed.push(points[finalIndex]!);
  return compressed;
}

function boundLocalDragPoints(points: BrowserDragPoint[]): BrowserDragPoint[] {
  if (points.length <= MAX_LOCAL_DRAG_POINTS) return points;
  return [
    points[0]!,
    ...points.slice(1, -1).filter((_point, index) => index % 2 === 0),
    points[points.length - 1]!,
  ];
}

interface ActiveBrowserLease {
  id: string;
  tabId: string;
  expiresAt: number;
  generation: number;
  scope: AgentPreviewScope;
}

export function BrowserPreviewView({
  scope,
  controlRequestId,
}: {
  scope: AgentPreviewScope;
  controlRequestId?: string | number | null;
}) {
  const { t, locale } = useI18n();
  const [lease, setLease] = useState<ActiveBrowserLease | null>(null);
  const leaseActiveForScope = Boolean(
    lease
    && `${lease.scope.scope_type}:${String(lease.scope.scope_id)}` === `${scope.scope_type}:${String(scope.scope_id)}`,
  );
  const { state, refresh } = useBrowserPreview(scope, leaseActiveForScope);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState("");
  const [textInput, setTextInput] = useState("");
  const [pointerFeedback, setPointerFeedback] = useState<LocalPointerFeedback | null>(null);
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
  const pointerGestureRef = useRef<ActivePointerGesture | null>(null);
  const suppressClickRef = useRef(false);
  const consumedControlRequestRef = useRef<string | number | null>(null);
  const consumedControlScopeRef = useRef("");
  const [quickControlTimedOut, setQuickControlTimedOut] = useState(false);
  const lastUpdate = previewTime(state.capturedAt || state.checkedAt, intlLocale(locale));
  const scopeKey = `${scope.scope_type}:${String(scope.scope_id)}`;
  if (consumedControlScopeRef.current !== scopeKey) {
    consumedControlScopeRef.current = scopeKey;
    consumedControlRequestRef.current = null;
  }
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

  const waitForControlIdle = useCallback(async () => {
    for (;;) {
      const pending = controlQueueRef.current;
      await pending.catch(() => undefined);
      if (pending === controlQueueRef.current) return;
    }
  }, []);

  const clearPointerGesture = useCallback(() => {
    const gesture = pointerGestureRef.current;
    pointerGestureRef.current = null;
    setPointerFeedback(null);
    if (gesture) {
      try {
        if (gesture.surface.hasPointerCapture?.(gesture.pointerId)) {
          gesture.surface.releasePointerCapture(gesture.pointerId);
        }
      } catch {
        // The browser may have already released capture during blur/cancel.
      }
    }
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
    clearPointerGesture();
    if (message) setControlError(message);
    queueBestEffortRelease(expected);
  }, [clearPointerGesture, queueBestEffortRelease]);

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

  const sendInput = useCallback((input: BrowserControlInput): Promise<void> => {
    const active = leaseRef.current;
    if (!active || currentTabRef.current !== active.tabId) return Promise.resolve();
    const sequence = ++sequenceRef.current;
    return enqueueControl(async () => {
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
      clearPointerGesture();
      const latest = leaseRef.current;
      if (latest) {
        leaseRef.current = null;
        sequenceRef.current = 0;
        queueBestEffortRelease(latest);
      }
    };
  }, [clearPointerGesture, queueBestEffortRelease, scopeKey]);

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

  useEffect(() => {
    const onMessageSubmit = (event: Event) => {
      const requestedScope = browserControlRelinquishScope(event);
      if (
        requestedScope
        && `${requestedScope.scope_type}:${requestedScope.scope_id}` === scopeKey
      ) {
        controlLifecycleRef.current += 1;
        relinquishLease();
        waitForBrowserControlRelinquish(event, waitForControlIdle());
      }
    };
    window.addEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, onMessageSubmit);
    return () => window.removeEventListener(BROWSER_CONTROL_RELINQUISH_EVENT, onMessageSubmit);
  }, [relinquishLease, scopeKey, waitForControlIdle]);

  const beginControl = useCallback(async () => {
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
  }, [
    controlBusy,
    enqueueControl,
    queueBestEffortRelease,
    relinquishLease,
    scope.scope_id,
    scope.scope_type,
    state.tabId,
    t,
  ]);

  const hasQuickControlRequest = (
    (typeof controlRequestId === "number" && controlRequestId > 0)
    || (typeof controlRequestId === "string" && controlRequestId.length > 0)
  );

  useEffect(() => {
    setQuickControlTimedOut(false);
    if (!hasQuickControlRequest || state.tabId) return;
    const requested = controlRequestId;
    const timer = window.setTimeout(() => {
      // A work-record handoff is single-shot even when the browser never
      // becomes ready. Consume it with the timeout so a stale tab discovery
      // cannot unexpectedly seize control later.
      consumedControlRequestRef.current = requested ?? null;
      setQuickControlTimedOut(true);
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [controlRequestId, hasQuickControlRequest, state.tabId]);

  useEffect(() => {
    if (
      controlRequestId === undefined
      || controlRequestId === null
      || controlRequestId === ""
      || (typeof controlRequestId === "number" && controlRequestId <= 0)
      || !state.tabId
      || Object.is(consumedControlRequestRef.current, controlRequestId)
    ) {
      return;
    }
    // Defer one task so React StrictMode can finish its development-only
    // setup/cleanup probe. Consume before asynchronous acquisition; a failed
    // request remains visible and must never become an automatic retry.
    const requested = controlRequestId;
    const timer = window.setTimeout(() => {
      if (Object.is(consumedControlRequestRef.current, requested)) return;
      consumedControlRequestRef.current = requested;
      void beginControl();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [beginControl, controlRequestId, state.tabId]);

  const frameCoordinates = (
    clientX: number,
    clientY: number,
    clampToFrame = false,
  ): { x: number; y: number } | null => {
    const image = imageRef.current;
    if (!image || !image.naturalWidth || !image.naturalHeight) return null;
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const shownWidth = image.naturalWidth * scale;
    const shownHeight = image.naturalHeight * scale;
    const left = rect.left + (rect.width - shownWidth) / 2;
    const top = rect.top + (rect.height - shownHeight) / 2;
    if (
      !clampToFrame
      && (clientX < left || clientX > left + shownWidth || clientY < top || clientY > top + shownHeight)
    ) return null;
    const boundedX = Math.max(left, Math.min(left + shownWidth, clientX));
    const boundedY = Math.max(top, Math.min(top + shownHeight, clientY));
    return { x: (boundedX - left) / scale, y: (boundedY - top) / scale };
  };

  const pointerFeedbackAt = (surface: HTMLDivElement, clientX: number, clientY: number) => {
    const rect = surface.getBoundingClientRect();
    return {
      left: Math.max(0, Math.min(rect.width, clientX - rect.left)),
      top: Math.max(0, Math.min(rect.height, clientY - rect.top)),
    };
  };

  const appendPointerPoint = (
    gesture: ActivePointerGesture,
    clientX: number,
    clientY: number,
    final = false,
  ): boolean => {
    const point = frameCoordinates(clientX, clientY, true);
    if (!point) return false;
    const previous = gesture.points[gesture.points.length - 1]!;
    const maxAt = final ? MAX_DRAG_DURATION_MS : MAX_DRAG_DURATION_MS - 1;
    if (previous.at_ms >= maxAt) return false;
    const elapsed = Math.max(0, Math.floor(performance.now() - gesture.startedAt));
    const atMs = Math.max(previous.at_ms + 1, Math.min(maxAt, elapsed));
    gesture.points = boundLocalDragPoints([
      ...gesture.points,
      { x: point.x, y: point.y, at_ms: atMs },
    ]);
    return true;
  };

  const onFramePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      !controlling
      || !event.isPrimary
      || (event.pointerType === "mouse" && event.button !== 0)
      || pointerGestureRef.current
    ) return;
    const point = frameCoordinates(event.clientX, event.clientY);
    if (!point) return;
    const surface = event.currentTarget;
    try {
      surface.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    pointerGestureRef.current = {
      pointerId: event.pointerId,
      surface,
      startedAt: performance.now(),
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
      points: [{ x: point.x, y: point.y, at_ms: 0 }],
    };
    suppressClickRef.current = false;
    setPointerFeedback({
      ...pointerFeedbackAt(surface, event.clientX, event.clientY),
      dragging: false,
    });
    surface.focus({ preventScroll: true });
  };

  const onFramePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointerGestureRef.current;
    if (!controlling || !gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const distance = Math.hypot(
      event.clientX - gesture.startClientX,
      event.clientY - gesture.startClientY,
    );
    if (distance >= DRAG_MOVEMENT_THRESHOLD_PX) gesture.moved = true;
    if (gesture.moved) appendPointerPoint(gesture, event.clientX, event.clientY);
    setPointerFeedback({
      ...pointerFeedbackAt(gesture.surface, event.clientX, event.clientY),
      dragging: gesture.moved,
    });
  };

  const onFramePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - gesture.startClientX,
      event.clientY - gesture.startClientY,
    );
    if (distance >= DRAG_MOVEMENT_THRESHOLD_PX) gesture.moved = true;
    if (gesture.moved) appendPointerPoint(gesture, event.clientX, event.clientY, true);
    const points = gesture.moved ? compressDragPoints(gesture.points) : [];
    const feedback = pointerFeedbackAt(gesture.surface, event.clientX, event.clientY);
    suppressClickRef.current = gesture.moved;
    if (gesture.moved) {
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    clearPointerGesture();
    if (points.length >= 2) {
      event.preventDefault();
      setPointerFeedback({ ...feedback, dragging: false });
      void sendInput({ action: "drag", points }).finally(() => setPointerFeedback(null));
    }
  };

  const onFramePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const moved = gesture.moved;
    suppressClickRef.current = moved;
    if (moved) {
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    clearPointerGesture();
    controlLifecycleRef.current += 1;
    relinquishLease();
  };

  const onFrameClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!controlling) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
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

  const waitingForQuickControl = hasQuickControlRequest
    && !quickControlTimedOut
    && !state.tabId
    && !Object.is(consumedControlRequestRef.current, controlRequestId);

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
          onPointerDown={onFramePointerDown}
          onPointerMove={onFramePointerMove}
          onPointerUp={onFramePointerUp}
          onPointerCancel={onFramePointerCancel}
          onLostPointerCapture={onFramePointerCancel}
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
          ) : state.activity === "idle" && !waitingForQuickControl ? (
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
          {pointerFeedback ? (
            <span
              className={pointerFeedback.dragging
                ? "browser-preview__pointer-feedback is-dragging"
                : "browser-preview__pointer-feedback"}
              style={{
                "--pointer-left": `${pointerFeedback.left}px`,
                "--pointer-top": `${pointerFeedback.top}px`,
              } as CSSProperties}
              aria-hidden="true"
            />
          ) : null}
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
