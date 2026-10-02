import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyEngineeringCodePlan } from "../src/engineering";
import {
  asEngineeringCodePlan,
  executeStageVerification,
  hashStageCodeFiles,
  persistStageVerificationRecord,
  serializeStageVerificationEvidence,
  stageCodeFilesChanged,
  validateStageCodePlan,
  validateStageVerificationPlan,
  validateStageVerificationVerdict
} from "../src/stage-execution";
import type { EngineeringCodeContext, StageCodePlan, StageVerificationPlan } from "../src/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-ai-stage-"));
  temporaryDirectories.push(directory);
  return fs.realpath(directory);
}

describe("stage Coder boundary", () => {
  it("applies Coder changes without executing the declared runner", async () => {
    const root = await temporaryDirectory();
    const context: EngineeringCodeContext = { roots: [root], files: [], serialized: "", truncated: false };
    const plan: StageCodePlan = {
      stage_id: "STG-AERO",
      summary: "Create a stage runner",
      assistant_message: "Ready for review",
      operations: [{
        operation_id: "runner",
        action: "create",
        root_index: 0,
        path: "aero_runner.py",
        expected_hash: "",
        search: "",
        content: "require('node:fs').writeFileSync('coder-ran.txt', 'unsafe');\n",
        reason: "Test the Coder/Verifier execution boundary."
      }],
      runner: { root_index: 0, path: "aero_runner.py" },
      warnings: []
    };

    validateStageCodePlan(plan, context, "STG-AERO");
    const report = await applyEngineeringCodePlan(asEngineeringCodePlan(plan), context, process.execPath);

    expect(report.runs).toEqual([]);
    await expect(fs.stat(path.join(root, "coder-ran.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unreviewed runner path", async () => {
    const root = await temporaryDirectory();
    const context: EngineeringCodeContext = { roots: [root], files: [], serialized: "", truncated: false };
    const plan: StageCodePlan = {
      stage_id: "STG-AERO",
      summary: "unsafe runner",
      assistant_message: "unsafe",
      operations: [{
        operation_id: "model",
        action: "create",
        root_index: 0,
        path: "model.py",
        expected_hash: "",
        search: "",
        content: "value = 1\n",
        reason: "model"
      }],
      runner: { root_index: 0, path: "unseen_runner.py" },
      warnings: []
    };

    expect(() => validateStageCodePlan(plan, context, "STG-AERO")).toThrow(/supplied in full/);
  });
});

describe("Verifier-controlled stage execution", () => {
  it("does not start verification after its session is aborted", async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, "model_runner.py"), "process.exit(0);\n", "utf8");
    const plan: StageVerificationPlan = {
      stage_id: "STG-ABORT",
      summary: "Cancelled verification",
      cases: [{ case_id: "cancelled", input_json: "{}", checks: ["does not run"] }],
      warnings: [],
      blocked_reason: ""
    };
    const controller = new AbortController();
    controller.abort();

    await expect(executeStageVerification(
      plan,
      { root_index: 0, path: "model_runner.py" },
      [root],
      process.execPath,
      "STG-ABORT",
      1,
      controller.signal
    )).rejects.toMatchObject({ name: "AbortError" });
    await expect(fs.stat(path.join(root, "verification_results"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes Verifier inputs, invokes the runner directly, and records JSON evidence", async () => {
    const root = await temporaryDirectory();
    const runner = path.join(root, "model_runner.py");
    await fs.writeFile(runner, [
      "const fs = require('node:fs');",
      "const inputIndex = process.argv.indexOf('--input');",
      "const outputIndex = process.argv.indexOf('--output');",
      "const input = JSON.parse(fs.readFileSync(process.argv[inputIndex + 1], 'utf8'));",
      "fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ force_n: input.pressure_pa * input.area_m2 }));"
    ].join("\n"), "utf8");
    const plan: StageVerificationPlan = {
      stage_id: "STG-STRUCT",
      summary: "Check pressure-to-force transfer",
      cases: [{
        case_id: "unit-area",
        input_json: JSON.stringify({ pressure_pa: 1250, area_m2: 2 }),
        checks: ["force_n equals pressure_pa multiplied by area_m2"]
      }],
      warnings: [],
      blocked_reason: ""
    };

    const progress: string[] = [];
    const results = await executeStageVerification(
      plan,
      { root_index: 0, path: "model_runner.py" },
      [root],
      process.execPath,
      "STG-STRUCT",
      1,
      undefined,
      (event) => progress.push(`${event.phase}:${event.caseId}:${event.success ?? "pending"}`)
    );

    expect(results).toHaveLength(1);
    expect(progress).toEqual(["started:unit-area:pending", "completed:unit-area:true"]);
    expect(results[0]).toMatchObject({ success: true, output_exists: true, exit_code: 0 });
    expect(JSON.parse(results[0].output_text)).toEqual({ force_n: 2500 });
    expect(await fs.readFile(path.join(root, "verification_results", "stg-struct", "attempt_1", "unit-area", "input.json"), "utf8"))
      .toContain('"pressure_pa": 1250');
    expect(await fs.readFile(path.join(root, "verification_results", "stg-struct", "attempt_1", "verification-plan.json"), "utf8"))
      .toContain('"case_id": "unit-area"');
    expect(serializeStageVerificationEvidence(plan, results)).toContain("DETERMINISTIC EXECUTION EVIDENCE");

    const recordPath = await persistStageVerificationRecord(
      plan,
      results,
      {
        stage_id: "STG-STRUCT",
        verdict: "pass",
        summary: "force transfer is correct",
        key_numbers: ["force_n=2500"],
        checks: [{ check: "force relation", status: "pass", evidence: "1250 × 2 = 2500" }],
        feedback: [],
        failure_modes: []
      },
      { root_index: 0, path: "model_runner.py" },
      [root],
      "STG-STRUCT",
      1
    );
    expect(recordPath).toBe("0:verification_results/stg-struct/attempt_1/verification-record.json");
    expect(await fs.readFile(path.join(root, "verification_results", "stg-struct", "attempt_1", "verification-record.json"), "utf8"))
      .toContain('"verdict": "pass"');
  });

  it("rejects malformed plans and self-contradictory pass verdicts", () => {
    expect(() => validateStageVerificationPlan({
      stage_id: "STG-AERO",
      summary: "bad",
      cases: [{ case_id: "bad", input_json: "not-json", checks: ["check"] }],
      warnings: [],
      blocked_reason: ""
    }, "STG-AERO")).toThrow(/valid JSON/);

    expect(() => validateStageVerificationVerdict({
      stage_id: "STG-AERO",
      verdict: "pass",
      summary: "contradiction",
      key_numbers: [],
      checks: [{ check: "finite output", status: "fail", evidence: "NaN" }],
      feedback: [],
      failure_modes: []
    }, "STG-AERO")).toThrow(/cannot pass/);
  });

  it("invalidates verification when a recorded implementation file changes", async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, "model.py"), "value = 1\n", "utf8");
    const codeHashes = await hashStageCodeFiles(["0:model.py"], [root]);
    const record = {
      stageId: "STG-AERO",
      contractHash: "a".repeat(64),
      verdict: "pass" as const,
      attempts: 1,
      codeFiles: ["0:model.py"],
      codeHashes,
      dependencySignatures: {},
      summary: "passed",
      updatedAt: "2026-10-02T10:00:00.000Z"
    };

    expect(await stageCodeFilesChanged(record, [root])).toBe(false);
    await fs.writeFile(path.join(root, "model.py"), "value = 2\n", "utf8");
    expect(await stageCodeFilesChanged(record, [root])).toBe(true);
  });
});
