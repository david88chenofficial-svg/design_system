import { describe, expect, it } from "vitest";
import {
  canonicalProjectName,
  canonicalProjectPath,
  canonicalVaultPath,
  scopedVaultPath,
  validateChangePlan
} from "../src/safety";
import type { VaultChangePlan } from "../src/types";

function plan(overrides: Partial<VaultChangePlan> = {}): VaultChangePlan {
  return {
    mode: "evolve",
    summary: "Test",
    assistant_message: "Test",
    operations: [],
    warnings: [],
    validation_checks: [],
    ...overrides
  };
}

describe("vault path safety", () => {
  it("accepts Markdown and Canvas paths", () => {
    expect(canonicalVaultPath("01 Analysis Tool/New Branch.md")).toBe("01 Analysis Tool/New Branch.md");
    expect(canonicalVaultPath("00 Start Here/Engineering Workflow.canvas")).toBe("00 Start Here/Engineering Workflow.canvas");
  });

  it.each(["../outside.md", "C:\\outside.md", ".obsidian/plugins/x.md", "script.ts", "/absolute.md", "Projects/Other/Home.md"])(
    "rejects %s",
    (path) => expect(() => canonicalVaultPath(path)).toThrow()
  );
});

describe("project isolation", () => {
  it("accepts a safe project name and direct project path", () => {
    expect(canonicalProjectName("Seal Design System")).toBe("Seal Design System");
    expect(canonicalProjectPath("Projects/Seal Design System")).toBe("Projects/Seal Design System");
  });

  it.each(["../Seal", ".hidden", "Seal/Other", "CON", "Seal:"])(
    "rejects unsafe project name %s",
    (name) => expect(() => canonicalProjectName(name)).toThrow()
  );

  it("scopes an AI operation to the selected project", () => {
    expect(scopedVaultPath("Projects/Seal Design System", "00 Start Here/Home.md"))
      .toBe("Projects/Seal Design System/00 Start Here/Home.md");
  });

  it("rejects nested and outside project roots", () => {
    expect(() => canonicalProjectPath("Seal Design System")).toThrow();
    expect(() => canonicalProjectPath("Projects/Group/Seal")).toThrow();
  });
});

describe("change plan safety", () => {
  it("requires replacement hashes", () => {
    expect(() => validateChangePlan(plan({
      operations: [{
        operation_id: "op-1",
        action: "replace",
        path: "Current Status.md",
        expected_hash: "",
        content: "replacement",
        reason: "test"
      }]
    }))).toThrow(/SHA-256/);
  });

  it("rejects malformed Canvas content", () => {
    expect(() => validateChangePlan(plan({
      operations: [{
        operation_id: "op-1",
        action: "create",
        path: "Broken.canvas",
        expected_hash: "",
        content: "{}",
        reason: "test"
      }]
    }))).toThrow(/nodes and edges/);
  });
});
