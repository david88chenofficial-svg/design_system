import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyEngineeringCodePlan,
  buildEngineeringFileManifest,
  isEngineeringCodeRequest,
  readEngineeringCodeContext,
  validateEngineeringCodePlan
} from "../src/engineering";
import type { EngineeringCodePlan, EngineeringContextRoute } from "../src/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-ai-engineering-"));
  temporaryDirectories.push(directory);
  return fs.realpath(directory);
}

describe("engineering code intent", () => {
  it("routes implementation and experimental-analysis requests to code mode", () => {
    expect(isEngineeringCodeRequest("Implement another seal model in Python and run the comparison")).toBe(true);
    expect(isEngineeringCodeRequest("Plot these experimental data points and fit the discharge coefficient")).toBe(true);
    expect(isEngineeringCodeRequest("Add a workflow branch for model qualification")).toBe(false);
  });
});

describe("engineering code changes", () => {
  it("applies an exact hash-checked replacement and creates a data file", async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, "model.py"), "def model(x):\n    return x + 1\n", "utf8");
    const manifest = await buildEngineeringFileManifest([root]);
    const route: EngineeringContextRoute = {
      focus: "model",
      rationale: "test",
      selected_files: [{ root_index: 0, path: "model.py" }],
      needs_more_context: false
    };
    const context = await readEngineeringCodeContext(manifest, route, 4, 20_000);
    const plan: EngineeringCodePlan = {
      summary: "Change model and add data",
      assistant_message: "Ready",
      operations: [
        {
          operation_id: "edit-model",
          action: "replace",
          root_index: 0,
          path: "model.py",
          expected_hash: context.files[0].hash,
          search: "return x + 1",
          content: "return x + 2",
          reason: "Implement the requested relation."
        },
        {
          operation_id: "add-data",
          action: "create",
          root_index: 0,
          path: "data/experiment.csv",
          expected_hash: "",
          search: "",
          content: "x,y\n1,2\n",
          reason: "Preserve supplied data."
        }
      ],
      runs: [],
      warnings: [],
      verification_checks: []
    };

    const report = await applyEngineeringCodePlan(plan, context, "python");

    expect(report.modified).toEqual(["0:model.py"]);
    expect(report.created).toEqual(["0:data/experiment.csv"]);
    expect(await fs.readFile(path.join(root, "model.py"), "utf8")).toContain("return x + 2");
    expect(await fs.readFile(path.join(root, "data", "experiment.csv"), "utf8")).toContain("1,2");
  });

  it("rejects traversal and stale replacement hashes", async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, "model.py"), "value = 1\n", "utf8");
    const manifest = await buildEngineeringFileManifest([root]);
    const context = await readEngineeringCodeContext(manifest, {
      focus: "model",
      rationale: "test",
      selected_files: [{ root_index: 0, path: "model.py" }],
      needs_more_context: false
    }, 4, 20_000);
    const base: EngineeringCodePlan = {
      summary: "bad",
      assistant_message: "bad",
      operations: [],
      runs: [],
      warnings: [],
      verification_checks: []
    };
    expect(() => validateEngineeringCodePlan({
      ...base,
      operations: [{
        operation_id: "escape",
        action: "create",
        root_index: 0,
        path: "../outside.py",
        expected_hash: "",
        search: "",
        content: "pass\n",
        reason: "bad"
      }]
    }, context)).toThrow(/unsafe/);
    expect(() => validateEngineeringCodePlan({
      ...base,
      operations: [{
        operation_id: "stale",
        action: "replace",
        root_index: 0,
        path: "model.py",
        expected_hash: "0".repeat(64),
        search: "value = 1",
        content: "value = 2",
        reason: "bad"
      }]
    }, context)).toThrow(/hash/);
    expect(() => validateEngineeringCodePlan({
      ...base,
      operations: [{
        operation_id: "overwrite-evidence",
        action: "create",
        root_index: 0,
        path: "verification_results/forged.json",
        expected_hash: "",
        search: "",
        content: "{}\n",
        reason: "bad"
      }]
    }, context)).toThrow(/controller-owned/);
  });

  it("executes an approved script directly and captures declared text results", async () => {
    const root = await temporaryDirectory();
    const manifest = await buildEngineeringFileManifest([root]);
    const context = await readEngineeringCodeContext(manifest, {
      focus: "new analysis",
      rationale: "test",
      selected_files: [],
      needs_more_context: false
    }, 4, 20_000);
    const plan: EngineeringCodePlan = {
      summary: "Create and run analysis",
      assistant_message: "Ready",
      operations: [{
        operation_id: "create-runner",
        action: "create",
        root_index: 0,
        path: "runner.py",
        expected_hash: "",
        search: "",
        content: "require('node:fs').writeFileSync('results.json', JSON.stringify({rmse: 0.25, coefficient: 0.61}));\n",
        reason: "Exercise the direct executable path."
      }],
      runs: [{
        run_id: "analysis",
        root_index: 0,
        args: ["runner.py"],
        expected_outputs: ["results.json"],
        reason: "Generate metrics."
      }],
      warnings: [],
      verification_checks: []
    };

    const report = await applyEngineeringCodePlan(plan, context, process.execPath);

    expect(report.runs[0].success).toBe(true);
    expect(report.runs[0].outputs[0]).toMatchObject({ exists: true });
    expect(report.runs[0].outputs[0].excerpt).toContain('"rmse":0.25');
  });

  it("does not apply a reviewed plan after its session is aborted", async () => {
    const root = await temporaryDirectory();
    const context = await readEngineeringCodeContext(await buildEngineeringFileManifest([root]), {
      focus: "aborted change",
      rationale: "test",
      selected_files: [],
      needs_more_context: false
    }, 4, 20_000);
    const plan: EngineeringCodePlan = {
      summary: "Create a file",
      assistant_message: "Ready",
      operations: [{
        operation_id: "create-after-abort",
        action: "create",
        root_index: 0,
        path: "should-not-exist.py",
        expected_hash: "",
        search: "",
        content: "value = 1\n",
        reason: "Exercise cancellation."
      }],
      runs: [],
      warnings: [],
      verification_checks: []
    };
    const controller = new AbortController();
    controller.abort();

    await expect(applyEngineeringCodePlan(plan, context, "python", controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(fs.stat(path.join(root, "should-not-exist.py"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
