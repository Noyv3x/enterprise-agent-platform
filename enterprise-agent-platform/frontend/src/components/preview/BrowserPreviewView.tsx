import { Button, Input, Space } from "antd";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { intlLocale, useI18n } from "../../i18n";
import type { AgentPreviewScope } from "../../types";
import { BrowserControlBar, EmptyState, LoadingState, Notice } from "../ui/fieldwork";
import { PreviewStatus } from "./PreviewStatus";
import { useBrowserControl } from "./useBrowserControl";

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

export function BrowserPreviewView({
  scope,
  controlRequestId,
}: {
  scope: AgentPreviewScope;
  controlRequestId?: string | number | null;
}) {
  const { t, locale } = useI18n();
  const [textInput, setTextInput] = useState("");
  const [pointerFeedback, setPointerFeedback] = useState<LocalPointerFeedback | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerGestureRef = useRef<ActivePointerGesture | null>(null);
  const suppressClickRef = useRef(false);
  const consumedControlRequestRef = useRef<string | number | null>(null);
  const consumedControlScopeRef = useRef("");
  const [quickControlTimedOut, setQuickControlTimedOut] = useState(false);
  const scopeKey = `${scope.scope_type}:${String(scope.scope_id)}`;
  if (consumedControlScopeRef.current !== scopeKey) {
    consumedControlScopeRef.current = scopeKey;
    consumedControlRequestRef.current = null;
  }

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

  const clearControlGesture = useCallback(() => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    clearPointerGesture();
  }, [clearPointerGesture]);
  const {
    state, refresh, controlling, controlBusy, controlError,
    beginControl, endControl, sendInput,
  } = useBrowserControl(scope, clearControlGesture);
  const lastUpdate = previewTime(state.capturedAt || state.checkedAt, intlLocale(locale));


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
    void endControl();
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
    <section className="wf-browser-view" aria-label={t("browserPreview.title")}>
      <BrowserControlBar
        status={controlling ? t("browserPreview.assisting") : t("preview.readOnly")}
        description={<PreviewStatus connection={state.connection} idle={state.activity === "idle"} />}
        danger={Boolean(controlError)}
        action={<Space wrap>
          {state.tabId ? <Button type={controlling ? "default" : "primary"} loading={controlBusy} onClick={() => controlling ? endControl() : void beginControl()}>{t(controlling ? "browserPreview.endControl" : "browserPreview.takeControl")}</Button> : null}
          <Button onClick={refresh}>{t("preview.refresh")}</Button>
        </Space>}
      />
      {state.error ? <Notice tone="warning" title={state.error} /> : null}
      {controlError ? <Notice tone="warning" title={controlError} /> : null}
      {controlling ? <div className="wf-browser-inputs">
        <Space wrap>{(["back", "forward", "refresh"] as const).map(action => <Button key={action} onClick={() => void sendInput({action})}>{t(action === "refresh" ? "browserPreview.reload" : action === "back" ? "browserPreview.back" : "browserPreview.forward")}</Button>)}</Space>
        <div className="wf-field-row"><Input aria-label={t("browserPreview.typePlaceholder")} value={textInput} maxLength={4096} placeholder={t("browserPreview.typePlaceholder")} onChange={event => setTextInput(event.target.value)} onPressEnter={event => {
          if (event.nativeEvent.isComposing || !textInput) return;
          void sendInput({action: "text", text: textInput}); setTextInput("");
        }} /><Button disabled={!textInput} onClick={() => { if (!textInput) return; void sendInput({action: "text", text: textInput}); setTextInput(""); }}>{t("browserPreview.typeSend")}</Button></div>
      </div> : null}
      <div className="wf-browser-frame" data-controlling={controlling || undefined}
        tabIndex={controlling ? 0 : -1} role={controlling ? "application" : undefined}
        aria-label={controlling ? t("browserPreview.controlSurface") : undefined}
        onClick={onFrameClick} onPointerDown={onFramePointerDown} onPointerMove={onFramePointerMove} onPointerUp={onFramePointerUp}
        onPointerCancel={onFramePointerCancel} onLostPointerCapture={onFramePointerCancel}
        onWheel={event => { if (!controlling) return; event.preventDefault(); void sendInput({action:"wheel",delta_x:Math.round(event.deltaX),delta_y:Math.round(event.deltaY)}); }}
        onKeyDown={event => {
          if (!controlling || event.target !== event.currentTarget || (event.key === "Tab" && event.shiftKey)) return;
          if (!["Enter","Tab","Escape","Backspace","Delete"," ","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation(); void sendInput({action:"key",key:event.key === " " ? "Space" : event.key});
        }}>
        {state.frameUrl ? <img ref={imageRef} src={state.frameUrl} alt={t("browserPreview.frameAlt")} draggable={false} />
          : state.activity === "idle" && !waitingForQuickControl ? <EmptyState title={t("browserPreview.noBrowser")} description={t("browserPreview.noBrowserDetail")} />
          : <div aria-busy="true"><LoadingState label={t("browserPreview.loadingFrame")} detail={t("browserPreview.loadingFrameDetail")} /></div>}
        {pointerFeedback ? <span className="wf-browser-pointer" data-dragging={pointerFeedback.dragging || undefined} style={{left:pointerFeedback.left,top:pointerFeedback.top}} aria-hidden="true" /> : null}
      </div>
      <footer className="wf-preview-meta">
        {state.title ? <strong>{state.title}</strong> : null}
        {state.url ? <span>{state.url}</span> : null}
        {lastUpdate ? <span>{t("preview.updatedAt", {time:lastUpdate})}</span> : null}
      </footer>
    </section>
  );
}
