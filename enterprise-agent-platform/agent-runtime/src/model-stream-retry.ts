import {
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export const MODEL_STREAM_MAX_RETRIES = 3;
const MODEL_STREAM_RETRY_BASE_DELAY_MS = 1_000;
const MODEL_STREAM_RETRY_JITTER = 0.2;

interface ModelStreamRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, error: AssistantMessage) => void;
  activityHeartbeatMs?: number;
  onRetryActivity?: () => void;
}

/**
 * Retry a transient provider failure only while the current model attempt is
 * still invisible to the Agent loop. Completed turns and tool executions are
 * outside this boundary and are therefore never replayed.
 */
export function withModelStreamRetry(
  stream: StreamFn,
  options: ModelStreamRetryOptions = {},
): StreamFn {
  const maxRetries = options.maxRetries ?? MODEL_STREAM_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? MODEL_STREAM_RETRY_BASE_DELAY_MS;
  const random = options.random ?? Math.random;

  return (model, context, streamOptions): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream();
    const signal = streamOptions?.signal;

    void (async () => {
      for (let attempt = 0; ; attempt += 1) {
        const buffered: AssistantMessageEvent[] = [];
        let visible = false;
        let terminal = false;
        const source = await stream(model, context, streamOptions);

        for await (const event of source) {
          if (visible) {
            output.push(event);
          } else {
            buffered.push(event);
            visible = eventHasVisibleModelOutput(event);
            if (visible) flush(output, buffered);
          }

          if (event.type === "error") {
            terminal = true;
            const mayRetry = !visible
              && attempt < maxRetries
              && !isContextOverflow(event.error, model.contextWindow)
              && !isClearlyNonRetryableAssistantError(event.error)
              && isRetryableAssistantError(event.error)
              && !signal?.aborted;
            if (mayRetry) {
              const delayMs = retryDelay(baseDelayMs, attempt, random);
              options.onRetry?.(attempt + 1, delayMs, event.error);
              await abortableDelay(
                delayMs,
                signal,
                options.activityHeartbeatMs,
                options.onRetryActivity,
              );
              break;
            }
            flush(output, buffered);
            return;
          }

          if (event.type === "done") {
            terminal = true;
            flush(output, buffered);
            return;
          }
        }
        if (!terminal) throw new Error("model stream ended without a terminal event");
      }
    })().catch((error: unknown) => {
      // EventStream.end() without a result leaves result() unresolved. Always
      // terminate through a protocol event so both iteration and result()
      // settle even when a custom StreamFn violates its no-throw contract or
      // cancellation interrupts retry backoff.
      const aborted = signal?.aborted || isAbortError(error);
      const failure: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: aborted ? "aborted" : "error",
        errorMessage: aborted
          ? "Model request cancelled"
          : "Model stream failed before returning a terminal event",
        timestamp: Date.now(),
      };
      output.push({
        type: "error",
        reason: aborted ? "aborted" : "error",
        error: failure,
      });
    });

    return output;
  };
}

function flush(output: AssistantMessageEventStream, buffered: AssistantMessageEvent[]): void {
  while (buffered.length > 0) output.push(buffered.shift()!);
}

function eventHasVisibleModelOutput(event: AssistantMessageEvent): boolean {
  if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
    return event.delta.length > 0;
  }
  if (event.type === "text_end" || event.type === "thinking_end") {
    return event.content.length > 0;
  }
  if (event.type === "toolcall_end") return true;
  if (event.type === "error") return messageHasVisibleOutput(event.error);
  if (event.type === "done") return messageHasVisibleOutput(event.message);
  return messageHasVisibleOutput(event.partial);
}

function messageHasVisibleOutput(message: AssistantMessage): boolean {
  return message.content.some((item) => {
    if (item.type === "text") return item.text.length > 0;
    if (item.type === "thinking") return item.thinking.length > 0;
    return item.type === "toolCall";
  });
}

function isClearlyNonRetryableAssistantError(message: AssistantMessage): boolean {
  const text = message.errorMessage || "";
  return /(?:content|safety)[ _-]*(?:policy|filter)|policy[ _-]*violation|moderation|authentication|authorization|unauthori[sz]ed|forbidden|permission[ _-]*denied|invalid[^\n]*(?:api[ _-]?key|token|credential)|(?:http|status)[ _-]*(?:401|402|403)|\b(?:401|402|403)\b|account[^\n]*(?:disabled|suspended)|usage[ _-]?limit|quota|billing|payment[ _-]*required|insufficient[ _-]?quota|credit balance|(?:context(?:[ _-]*(?:length|window))?|prompt|input)[^\n]{0,100}(?:exceed(?:ed|s)?|overflow|too[ _-]*long|maximum|max[ _-]*(?:length|size)|token[ _-]*limit)|(?:maximum|max)[^\n]{0,100}(?:context|input|prompt|output|response)[^\n]{0,100}(?:token|length|size|limit)|(?:output|response)[^\n]{0,100}(?:exceed(?:ed|s)?|overflow|too[ _-]*(?:long|large)|maximum|max[ _-]*(?:length|size)|token[ _-]*limit)/i.test(text);
}

function retryDelay(baseDelayMs: number, attempt: number, random: () => number): number {
  const exponential = Math.max(0, baseDelayMs) * (2 ** attempt);
  const jitter = 1 - MODEL_STREAM_RETRY_JITTER + (2 * MODEL_STREAM_RETRY_JITTER * random());
  return Math.max(0, Math.round(exponential * jitter));
}

function abortableDelay(
  delayMs: number,
  signal: AbortSignal | undefined,
  activityHeartbeatMs: number | undefined,
  onActivity: (() => void) | undefined,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortException());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(settle, delayMs);
    const heartbeatMs = Math.max(0, activityHeartbeatMs ?? 0);
    const heartbeat = onActivity && heartbeatMs > 0
      ? setInterval(onActivity, heartbeatMs)
      : undefined;
    const abort = (): void => {
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
      reject(abortException());
    };
    function settle(): void {
      if (heartbeat) clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function abortException(): Error {
  const error = new Error("Model retry cancelled");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
