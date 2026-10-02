import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  EngineeringCodeContext,
  EngineeringCodePlan,
  ModelRunnerSpec,
  StageCodePlan,
  StageVerificationCaseResult,
  StageVerificationPlan,
  StageVerificationProgress,
  StageVerificationVerdict,
  StageExecutionRecord
} from "./types";
import { validateEngineeringCodePlan } from "./engineering";

const MAX_CASES = 6;
const MAX_INPUT_CHARS = 80_000;
const MAX_RUN_OUTPUT_CHARS = 24_000;
const MAX_RESULT_CHARS = 48_000;

export function validateStageCodePlan(
  plan: StageCodePlan,
  context: EngineeringCodeContext,
  expectedStageId: string
): void {
  if (!plan || plan.stage_id !== expectedStageId || typeof plan.summary !== "string"
    || typeof plan.assistant_message !== "string" || !Array.isArray(plan.operations)
    || !Array.isArray(plan.warnings)) {
    throw new Error("The Coder returned an invalid stage code plan.");
  }
  validateEngineeringCodePlan(asEngineeringCodePlan(plan), context);
  if (plan.operations.length > 0 && !plan.runner) {
    throw new Error("The Coder changed a stage but did not provide its standard Python runner.");
  }
  if (plan.runner) {
    validateRunner(plan.runner, context.roots);
    const runnerWasReviewed = plan.operations.some((operation) =>
      operation.root_index === plan.runner?.root_index && operation.path === plan.runner.path)
      || context.files.some((file) =>
        file.root_index === plan.runner?.root_index && file.path === plan.runner.path && !file.truncated);
    if (!runnerWasReviewed) {
      throw new Error("The stage runner must be created by this plan or supplied in full for review.");
    }
  }
}

export function asEngineeringCodePlan(plan: StageCodePlan): EngineeringCodePlan {
  return {
    summary: plan.summary,
    assistant_message: plan.assistant_message,
    operations: plan.operations,
    runs: [],
    warnings: plan.warnings,
    verification_checks: []
  };
}

export function validateStageVerificationPlan(
  plan: StageVerificationPlan,
  expectedStageId: string
): void {
  if (!plan || plan.stage_id !== expectedStageId || typeof plan.summary !== "string"
    || !Array.isArray(plan.cases) || !Array.isArray(plan.warnings)
    || typeof plan.blocked_reason !== "string") {
    throw new Error("The Verifier returned an invalid verification plan.");
  }
  if (plan.cases.length > MAX_CASES) throw new Error(`The Verifier may prepare at most ${MAX_CASES} cases.`);
  if (plan.blocked_reason.trim() && plan.cases.length > 0) {
    throw new Error("A blocked verification plan cannot also request executable cases.");
  }
  if (!plan.blocked_reason.trim() && plan.cases.length === 0) {
    throw new Error("The Verifier returned neither executable cases nor a blocking reason.");
  }
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const item of plan.cases) {
    if (!item.case_id || ids.has(item.case_id) || !Array.isArray(item.checks) || item.checks.length === 0) {
      throw new Error("Every verification case needs a unique ID and at least one check.");
    }
    ids.add(item.case_id);
    const slug = safeSegment(item.case_id);
    if (slugs.has(slug)) throw new Error("Verification case IDs must remain unique after path normalization.");
    slugs.add(slug);
    if (typeof item.input_json !== "string" || item.input_json.length > MAX_INPUT_CHARS) {
      throw new Error(`Verification case ${item.case_id} has an invalid or oversized input.`);
    }
    let input: unknown;
    try {
      input = JSON.parse(item.input_json);
    } catch {
      throw new Error(`Verification case ${item.case_id} input_json is not valid JSON.`);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`Verification case ${item.case_id} input_json must encode a JSON object.`);
    }
  }
}

export function validateStageVerificationVerdict(
  verdict: StageVerificationVerdict,
  expectedStageId: string
): void {
  if (!verdict || verdict.stage_id !== expectedStageId
    || !["pass", "fail", "inconclusive"].includes(verdict.verdict)
    || typeof verdict.summary !== "string" || !Array.isArray(verdict.key_numbers)
    || !Array.isArray(verdict.checks) || !Array.isArray(verdict.feedback)
    || !Array.isArray(verdict.failure_modes)) {
    throw new Error("The Verifier returned an invalid verdict.");
  }
  if (verdict.verdict === "pass" && verdict.checks.some((check) => check.status !== "pass")) {
    throw new Error("The Verifier cannot pass a stage while a reported check is not passing.");
  }
}

export async function executeStageVerification(
  plan: StageVerificationPlan,
  runner: ModelRunnerSpec,
  roots: string[],
  pythonExecutable: string,
  stageId: string,
  attempt: number,
  signal?: AbortSignal,
  onProgress?: (progress: StageVerificationProgress) => void
): Promise<StageVerificationCaseResult[]> {
  signal?.throwIfAborted();
  validateStageVerificationPlan(plan, stageId);
  validateRunner(runner, roots);
  const root = path.resolve(roots[runner.root_index]);
  const runnerAbsolute = path.resolve(root, runner.path);
  assertWithinRoot(root, runnerAbsolute);
  const runnerReal = await fs.realpath(runnerAbsolute);
  assertWithinRoot(root, runnerReal);
  const stageSegment = safeSegment(stageId);
  const attemptSegment = `attempt_${attempt}`;
  const attemptDirectory = path.resolve(root, "verification_results", stageSegment, attemptSegment);
  assertWithinRoot(root, attemptDirectory);
  await fs.mkdir(attemptDirectory, { recursive: true });
  await fs.writeFile(
    path.join(attemptDirectory, "verification-plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
    "utf8"
  );
  const results: StageVerificationCaseResult[] = [];
  for (const [caseIndex, item] of plan.cases.entries()) {
    signal?.throwIfAborted();
    onProgress?.({
      phase: "started",
      caseId: item.case_id,
      index: caseIndex + 1,
      total: plan.cases.length
    });
    const caseSegment = safeSegment(item.case_id);
    const relativeDirectory = path.posix.join("verification_results", stageSegment, attemptSegment, caseSegment);
    const absoluteDirectory = path.resolve(root, relativeDirectory);
    assertWithinRoot(root, absoluteDirectory);
    await fs.mkdir(absoluteDirectory, { recursive: true });
    const inputPath = path.posix.join(relativeDirectory, "input.json");
    const outputPath = path.posix.join(relativeDirectory, "result.json");
    const inputAbsolute = path.resolve(root, inputPath);
    const outputAbsolute = path.resolve(root, outputPath);
    assertWithinRoot(root, inputAbsolute);
    assertWithinRoot(root, outputAbsolute);
    await fs.writeFile(inputAbsolute, `${JSON.stringify(JSON.parse(item.input_json), null, 2)}\n`, "utf8");
    await fs.unlink(outputAbsolute).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    const execution = await runPython(
      pythonExecutable,
      [toPosix(path.relative(root, runnerReal)), "--input", inputPath, "--output", outputPath],
      root,
      signal
    );
    signal?.throwIfAborted();
    let outputExists = false;
    let outputHash = "";
    let outputText = "";
    let success = execution.success;
    let stderr = execution.stderr;
    try {
      const content = await fs.readFile(outputAbsolute, "utf8");
      outputExists = true;
      outputHash = createHash("sha256").update(content).digest("hex");
      outputText = content.slice(0, MAX_RESULT_CHARS);
      JSON.parse(content);
    } catch (error) {
      success = false;
      const message = error instanceof Error ? error.message : String(error);
      stderr = `${stderr}\nResult contract failure: ${message}`.trim().slice(-MAX_RUN_OUTPUT_CHARS);
    }
    results.push({
      case_id: item.case_id,
      input_path: `${runner.root_index}:${inputPath}`,
      output_path: `${runner.root_index}:${outputPath}`,
      success,
      exit_code: execution.exitCode,
      stdout: execution.stdout,
      stderr,
      output_exists: outputExists,
      output_hash: outputHash,
      output_text: outputText,
      checks: item.checks
    });
    onProgress?.({
      phase: "completed",
      caseId: item.case_id,
      index: caseIndex + 1,
      total: plan.cases.length,
      success,
      exitCode: execution.exitCode
    });
  }
  return results;
}

export async function persistStageVerificationRecord(
  plan: StageVerificationPlan,
  results: StageVerificationCaseResult[],
  verdict: StageVerificationVerdict,
  runner: ModelRunnerSpec,
  roots: string[],
  stageId: string,
  attempt: number
): Promise<string> {
  validateStageVerificationPlan(plan, stageId);
  validateStageVerificationVerdict(verdict, stageId);
  validateRunner(runner, roots);
  const root = path.resolve(roots[runner.root_index]);
  const relativePath = path.posix.join(
    "verification_results",
    safeSegment(stageId),
    `attempt_${attempt}`,
    "verification-record.json"
  );
  const absolutePath = path.resolve(root, relativePath);
  assertWithinRoot(root, absolutePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify({
    schema_version: 1,
    stage_id: stageId,
    attempt,
    runner,
    verification_plan: plan,
    execution_results: results,
    verdict,
    recorded_at: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  return `${runner.root_index}:${relativePath}`;
}

export function serializeStageVerificationEvidence(
  plan: StageVerificationPlan,
  results: StageVerificationCaseResult[]
): string {
  return [
    "VERIFIER-AUTHORED CASES",
    JSON.stringify(plan, null, 2),
    "",
    "DETERMINISTIC EXECUTION EVIDENCE",
    ...results.map((result) => [
      `CASE ${result.case_id} | success=${result.success} | exit=${result.exit_code ?? "unknown"}`,
      `INPUT: ${result.input_path}`,
      `OUTPUT: ${result.output_path} | exists=${result.output_exists} | sha256=${result.output_hash || "n/a"}`,
      `PLANNED CHECKS:\n${result.checks.map((check) => `- ${check}`).join("\n")}`,
      `STDOUT:\n${result.stdout || "(empty)"}`,
      `STDERR:\n${result.stderr || "(empty)"}`,
      `RESULT JSON:\n${result.output_text || "(missing)"}`
    ].join("\n"))
  ].join("\n\n").slice(0, 160_000);
}

export async function hashStageCodeFiles(
  codeFiles: string[],
  roots: string[]
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const value of Array.from(new Set(codeFiles))) {
    const match = value.match(/^(\d+):(.*)$/);
    if (!match) throw new Error(`Invalid recorded stage-code path: ${value}`);
    const rootIndex = Number.parseInt(match[1], 10);
    const root = roots[rootIndex];
    if (!root) throw new Error(`Recorded stage-code path targets an unknown root: ${value}`);
    const relativePath = match[2].replace(/\\/g, "/");
    const absolutePath = path.resolve(root, relativePath);
    assertWithinRoot(root, absolutePath);
    const realPath = await fs.realpath(absolutePath);
    assertWithinRoot(root, realPath);
    const content = await fs.readFile(realPath);
    hashes[`${rootIndex}:${relativePath}`] = createHash("sha256").update(content).digest("hex");
  }
  return hashes;
}

export async function stageCodeFilesChanged(
  record: StageExecutionRecord,
  roots: string[]
): Promise<boolean> {
  if (!record.codeHashes || roots.length === 0) return false;
  try {
    const current = await hashStageCodeFiles(Object.keys(record.codeHashes), roots);
    const paths = Object.keys(record.codeHashes).sort();
    return paths.some((recordedPath) => current[recordedPath] !== record.codeHashes?.[recordedPath]);
  } catch {
    return true;
  }
}

function validateRunner(runner: ModelRunnerSpec, roots: string[]): void {
  if (!Number.isInteger(runner.root_index) || !roots[runner.root_index]) {
    throw new Error("The stage runner targets an unknown engineering root.");
  }
  const normalized = runner.path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("The stage runner path is unsafe.");
  }
  if (!/\.pyw?$/i.test(normalized)) throw new Error("The stage runner must be a relative Python file.");
  runner.path = normalized;
}

async function runPython(
  pythonExecutable: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<{ success: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    execFile(
      pythonExecutable,
      args,
      { cwd, timeout: 120_000, maxBuffer: 2_000_000, windowsHide: true, signal },
      (error, stdout, stderr) => {
        const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({
          success: !error,
          exitCode: code,
          stdout: String(stdout).slice(-MAX_RUN_OUTPUT_CHARS),
          stderr: `${String(stderr)}${error && !("code" in error) ? `\n${error.message}` : ""}`.slice(-MAX_RUN_OUTPUT_CHARS)
        });
      }
    );
  });
}

function safeSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`Cannot use empty identifier as a verification path: ${value}`);
  return normalized.slice(0, 80);
}

function assertWithinRoot(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Verification path escapes its configured engineering root: ${target}`);
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
