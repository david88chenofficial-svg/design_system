import { describe, expect, it } from "vitest";
import { formatAgentActivityEvent, parseAgentTokenUsage, totalAgentTokenUsage } from "../src/activity";
import type { AgentActivityEvent } from "../src/types";

describe("agent activity", () => {
  it("parses exact Responses API token usage", () => {
    expect(parseAgentTokenUsage({ input_tokens: 842, output_tokens: 158, total_tokens: 1000 })).toEqual({
      inputTokens: 842,
      outputTokens: 158,
      totalTokens: 1000
    });
  });

  it("sums only completed events carrying usage", () => {
    const events: AgentActivityEvent[] = [
      { timestamp: "2026-10-02T12:00:00.000Z", agent: "Coder", status: "started", message: "Working" },
      {
        timestamp: "2026-10-02T12:00:01.000Z",
        agent: "Coder",
        status: "completed",
        message: "Done",
        usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 }
      },
      {
        timestamp: "2026-10-02T12:00:02.000Z",
        agent: "Verifier",
        status: "completed",
        message: "Done",
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }
      }
    ];
    expect(totalAgentTokenUsage(events)).toEqual({ inputTokens: 180, outputTokens: 45, totalTokens: 225 });
  });

  it("formats relevant stage and token information without prompt content", () => {
    const text = formatAgentActivityEvent({
      timestamp: "2026-10-02T12:00:00.000Z",
      agent: "Verifier",
      status: "completed",
      stageId: "STG-AERO",
      message: "Prepared 3 cases",
      durationMs: 1500,
      usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 },
      details: ["ordinary", "invalid-input"]
    });
    expect(text).toContain("Verifier · STG-AERO · COMPLETED");
    expect(text).toContain("500 total");
    expect(text).toContain("ordinary");
  });
});
