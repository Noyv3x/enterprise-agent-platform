export interface LiveBufferOptions {
  /** Minimum spacing between sends; the first text after a quiet period is sent immediately. */
  intervalMs: number;
  send: (text: string) => void;
  /** Total UTF-8 bytes forwarded; reaching it flushes the allowed prefix, calls `onLimit` once and drops the rest. */
  limitBytes?: number;
  onLimit?: () => void;
}

// Coalesces an ordered text stream into at most one send per interval. Pending
// text is bounded by the interval's worth of input (or `limitBytes`), so a fast
// producer never grows memory without limit.
export class LiveBuffer {
  private pending = "";
  private bytes = 0;
  private last = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly options: LiveBufferOptions) {}

  push(text: string): void {
    if (this.stopped || !text) return;
    const { limitBytes } = this.options;
    if (limitBytes !== undefined) {
      const remaining = limitBytes - this.bytes;
      const size = Buffer.byteLength(text);
      if (size > remaining) {
        let kept = "";
        let used = 0;
        for (const char of text) {
          const width = Buffer.byteLength(char);
          if (used + width > remaining) break;
          kept += char;
          used += width;
        }
        this.pending += kept;
        this.flush();
        this.stopped = true;
        this.options.onLimit?.();
        return;
      }
      this.bytes += size;
    }
    this.pending += text;
    if (this.timer) return;
    const wait = this.last + this.options.intervalMs - Date.now();
    if (wait <= 0) this.flush();
    else { this.timer = setTimeout(() => this.flush(), wait); this.timer.unref(); }
  }

  /** Send everything pending now, preserving order. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.pending) return;
    const text = this.pending;
    this.pending = "";
    this.last = Date.now();
    this.options.send(text);
  }

  /** Flush and refuse further input. */
  close(): void {
    this.flush();
    this.stopped = true;
  }
}
