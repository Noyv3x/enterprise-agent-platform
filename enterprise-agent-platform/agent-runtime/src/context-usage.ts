import { estimateTokens, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContextUsage } from "./types.js";

/** One Run, one fixed request envelope. Durable assistant usage is audit data only. */
export class RequestContextUsage {
  private readonly fixedTokens: number;
  private pending: AgentMessage[] | undefined;
  private anchor: { prefix: AgentMessage[]; tokens: number } | undefined;

  constructor(systemPrompt: string, tools: readonly Pick<AgentTool, "name" | "description" | "parameters">[]) {
    this.fixedTokens = estimateTokens({
      role: "user",
      content: systemPrompt + JSON.stringify(tools.map(({ name, description, parameters }) => ({
        name, description, parameters,
      }))),
      timestamp: 0,
    });
  }

  beginRequest(source: AgentMessage[]): void {
    this.pending = source.slice();
    if (this.anchor && !this.anchor.prefix.every((message, index) => source[index] === message)) {
      this.anchor = undefined;
    }
  }

  completeResponse(message: AssistantMessage): void {
    const prefix = this.pending;
    this.pending = undefined;
    if (!prefix || message.stopReason === "error" || message.stopReason === "aborted") return;
    const usage = message.usage;
    if (!usage) return;
    const components = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
    if (!components.every((value) => Number.isFinite(value) && value >= 0)) return;
    const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.anchor = { prefix: [...prefix, message], tokens };
  }

  measure(source: AgentMessage[], projected: AgentMessage[], contextWindow: number): ContextUsage | undefined {
    const maximum = Number.isFinite(contextWindow) ? Math.max(0, Math.round(contextWindow)) : 0;
    if (!maximum) return undefined;
    if (this.anchor && !this.anchor.prefix.every((message, index) => source[index] === message)) {
      this.anchor = undefined;
    }
    const anchor = this.anchor;
    let tokens = anchor?.tokens ?? this.fixedTokens;
    const start = anchor?.prefix.length ?? 0;
    for (let index = start; index < projected.length; index += 1) tokens += estimateTokens(projected[index]!);
    const used = Math.max(0, Math.round(tokens));
    return {
      used_tokens: used,
      max_tokens: maximum,
      percent: Math.max(0, Math.min(100, Math.round((used / maximum) * 100))),
      estimated: !anchor || projected.length > start,
    };
  }
}
