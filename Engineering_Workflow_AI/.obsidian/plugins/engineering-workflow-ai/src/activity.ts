import type { AgentActivityEvent, AgentTokenUsage } from "./types";

export function parseAgentTokenUsage(value: unknown): AgentTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = finiteNonNegativeInteger(record.input_tokens);
  const outputTokens = finiteNonNegativeInteger(record.output_tokens);
  const reportedTotal = finiteNonNegativeInteger(record.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && reportedTotal === undefined) return undefined;
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: reportedTotal ?? input + output
  };
}

export function totalAgentTokenUsage(events: AgentActivityEvent[]): AgentTokenUsage {
  return events.reduce<AgentTokenUsage>((total, event) => ({
    inputTokens: total.inputTokens + (event.usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (event.usage?.outputTokens ?? 0),
    totalTokens: total.totalTokens + (event.usage?.totalTokens ?? 0)
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
}

export function formatAgentActivityEvent(event: AgentActivityEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const scope = event.stageId ? ` · ${event.stageId}` : "";
  const status = event.status.toUpperCase();
  const duration = event.durationMs === undefined ? "" : ` · ${formatDuration(event.durationMs)}`;
  const usage = event.usage
    ? `\n  tokens: ${formatNumber(event.usage.inputTokens)} in · ${formatNumber(event.usage.outputTokens)} out · ${formatNumber(event.usage.totalTokens)} total`
    : "";
  const details = event.details?.length ? `\n${event.details.map((detail) => `  ${detail}`).join("\n")}` : "";
  return `[${time}] ${event.agent}${scope} · ${status}${duration}\n${event.message}${usage}${details}`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}
