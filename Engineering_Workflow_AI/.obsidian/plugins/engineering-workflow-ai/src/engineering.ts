import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AnalysisOutputArtifact,
  AnalysisRunResult,
  AnalysisRunSpec,
  EngineeringApplyReport,
  EngineeringCodeContext,
  EngineeringCodePlan,
  EngineeringContextRoute,
  EngineeringFileEntry,
  EngineeringFileManifest
} from "./types";

const ENGINEERING_EXTENSIONS = new Set([
  ".py", ".pyw", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".cs", ".java",
  ".go", ".rs", ".f", ".f90", ".f95", ".jl", ".m", ".mm",
  ".csv", ".tsv", ".json", ".toml", ".yaml", ".yml", ".txt"
]);
const WRITABLE_EXTENSIONS = new Set([
  ...ENGINEERING_EXTENSIONS,
  ".md"
]);
const OUTPUT_EXTENSIONS = new Set([
  ...WRITABLE_EXTENSIONS,
  ".png", ".svg", ".pdf", ".log", ".npy", ".npz"
]);
const TEXT_OUTPUT_EXTENSIONS = new Set([".csv", ".tsv", ".json", ".txt", ".log", ".md", ".yaml", ".yml"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", ".obsidian", "node_modules",
  ".venv", "venv", "env", "dist", "build", "coverage", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".engineering-workflow-ai"
]);
const SHA256_RE = /^[a-f0-9]{64}$/i;
const MAX_MANIFEST_FILES = 500;
const MAX_OPERATION_COUNT = 24;
const MAX_RUN_COUNT = 8;
const MAX_OPERATION_CHARS = 160_000;
const MAX_TOTAL_OPERATION_CHARS = 500_000;
const MAX_RUN_OUTPUT_CHARS = 24_000;

export function isEngineeringCodeRequest(request: string): boolean {
  const normalized = request.toLowerCase();
  if (/\b(branch|canvas|workflow|note|documentation)\b/.test(normalized)
    && !/\b(code|python|script|execute|run|plot|fit|calibrat|implement)\b/.test(normalized)) {
    return false;
  }
  return /\b(write|implement|edit|modify|add|create|update|generate|run|execute|plot|fit|calibrat|optim(?:ise|ize))\w*\b/.test(normalized)
    && /\b(code|python|script|solver|model|equation|experiment|dataset|data points?|plot|coefficient|parameter|test)\w*\b/.test(normalized);
}

export async function buildEngineeringFileManifest(roots: string[]): Promise<EngineeringFileManifest> {
  const files: EngineeringFileEntry[] = [];
  let truncated = false;
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    const remaining = MAX_MANIFEST_FILES - files.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const discovered = await enumerateEngineeringFiles(root, remaining);
    if (discovered.truncated) truncated = true;
    for (const absolutePath of discovered.paths) {
      const stats = await fs.stat(absolutePath);
      files.push({
        root_index: rootIndex,
        path: toPosix(path.relative(root, absolutePath)),
        extension: path.extname(absolutePath).toLowerCase(),
        size: stats.size
      });
    }
  }
  const serialized = [
    "ENGINEERING FILE MANIFEST",
    ...roots.map((root, index) => `ROOT ${index}: ${root}`),
    ...files.map((file) => `ROOT ${file.root_index} | ${file.path} | ${file.extension} | ${file.size} bytes`),
    truncated ? "MANIFEST TRUNCATED: true" : "MANIFEST TRUNCATED: false"
  ].join("\n");
  return { roots, files, serialized, truncated };
}

export async function readEngineeringCodeContext(
  manifest: EngineeringFileManifest,
  route: EngineeringContextRoute,
  maxFiles: number,
  maxChars: number
): Promise<EngineeringCodeContext> {
  const available = new Set(manifest.files.map((file) => `${file.root_index}|${file.path}`));
  const unique = new Map<string, { root_index: number; path: string }>();
  for (const selection of route.selected_files) {
    const relativePath = canonicalRelativePath(selection.path, ENGINEERING_EXTENSIONS);
    const key = `${selection.root_index}|${relativePath}`;
    if (!Number.isInteger(selection.root_index) || !manifest.roots[selection.root_index] || !available.has(key)) continue;
    unique.set(key, { root_index: selection.root_index, path: relativePath });
    if (unique.size >= maxFiles) break;
  }

  const files: EngineeringCodeContext["files"] = [];
  let remaining = maxChars;
  let truncated = route.needs_more_context || manifest.truncated;
  for (const selection of unique.values()) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const absolutePath = await resolveExistingPath(manifest.roots[selection.root_index], selection.path);
    const original = await fs.readFile(absolutePath, "utf8");
    const normalized = normalizeLf(original);
    const content = normalized.slice(0, remaining);
    const fileTruncated = content.length < normalized.length;
    files.push({
      ...selection,
      absolutePath,
      hash: hash(original),
      content,
      truncated: fileTruncated
    });
    remaining -= content.length;
    if (fileTruncated) truncated = true;
  }
  const serialized = [
    ...manifest.roots.map((root, index) => `ROOT ${index}: ${root}`),
    ...files.map((file) => [
      `FILE ROOT ${file.root_index}: ${file.path}`,
      `SHA-256: ${file.hash}`,
      file.truncated ? "CONTENT TRUNCATED: true" : "CONTENT TRUNCATED: false",
      "```",
      file.content,
      "```"
    ].join("\n"))
  ].join("\n\n---\n\n");
  return { roots: manifest.roots, files, serialized, truncated };
}

export function validateEngineeringCodePlan(
  plan: EngineeringCodePlan,
  context: EngineeringCodeContext
): void {
  if (!plan || typeof plan.summary !== "string" || typeof plan.assistant_message !== "string"
    || !Array.isArray(plan.operations) || !Array.isArray(plan.runs)
    || !Array.isArray(plan.warnings) || !Array.isArray(plan.verification_checks)) {
    throw new Error("The model returned an invalid engineering code plan.");
  }
  if (plan.operations.length > MAX_OPERATION_COUNT) {
    throw new Error(`The code plan exceeds the ${MAX_OPERATION_COUNT}-operation limit.`);
  }
  if (plan.runs.length > MAX_RUN_COUNT) {
    throw new Error(`The code plan exceeds the ${MAX_RUN_COUNT}-run limit.`);
  }
  const contextFiles = new Map(context.files.map((file) => [`${file.root_index}|${file.path}`, file]));
  const operationIds = new Set<string>();
  let totalChars = 0;
  for (const operation of plan.operations) {
    if (!operation.operation_id || operationIds.has(operation.operation_id)) {
      throw new Error("Every code operation must have a unique operation_id.");
    }
    operationIds.add(operation.operation_id);
    if (!Number.isInteger(operation.root_index) || !context.roots[operation.root_index]) {
      throw new Error(`Code operation ${operation.operation_id} targets an unknown root.`);
    }
    operation.path = canonicalRelativePath(operation.path, WRITABLE_EXTENSIONS);
    if (typeof operation.content !== "string" || typeof operation.search !== "string" || typeof operation.reason !== "string") {
      throw new Error(`Code operation ${operation.operation_id} has invalid text fields.`);
    }
    totalChars += operation.content.length + operation.search.length;
    if (operation.content.length + operation.search.length > MAX_OPERATION_CHARS) {
      throw new Error(`Code operation ${operation.operation_id} is too large.`);
    }
    const existing = contextFiles.get(`${operation.root_index}|${operation.path}`);
    if (operation.action === "create") {
      if (operation.expected_hash || operation.search || existing) {
        throw new Error(`Create operation ${operation.operation_id} must target a new file with empty hash and search text.`);
      }
    } else if (operation.action === "replace") {
      if (!existing || existing.truncated) {
        throw new Error(`Replace operation ${operation.operation_id} must target a fully loaded context file.`);
      }
      if (!SHA256_RE.test(operation.expected_hash) || operation.expected_hash !== existing.hash) {
        throw new Error(`Replace operation ${operation.operation_id} did not preserve the supplied file hash.`);
      }
      if (!operation.search) {
        throw new Error(`Replace operation ${operation.operation_id} must include exact search text.`);
      }
    } else {
      throw new Error(`Code operation ${operation.operation_id} has an unsupported action.`);
    }
  }
  if (totalChars > MAX_TOTAL_OPERATION_CHARS) {
    throw new Error("The code plan is too large to review safely in one operation.");
  }
  const runIds = new Set<string>();
  for (const run of plan.runs) validateRunSpec(run, context.roots, runIds);
}

export async function applyEngineeringCodePlan(
  plan: EngineeringCodePlan,
  context: EngineeringCodeContext,
  pythonExecutable: string
): Promise<EngineeringApplyReport> {
  validateEngineeringCodePlan(plan, context);
  const originalByPath = new Map<string, { absolutePath: string; existed: boolean; content: string; eol: string }>();
  const pendingByPath = new Map<string, { absolutePath: string; content: string; rootIndex: number; relativePath: string }>();

  for (const operation of plan.operations) {
    const root = context.roots[operation.root_index];
    const absolutePath = await resolveWritablePath(root, operation.path);
    const key = `${operation.root_index}|${operation.path}`;
    let original = originalByPath.get(key);
    if (!original) {
      let content = "";
      let existed = false;
      try {
        content = await fs.readFile(absolutePath, "utf8");
        existed = true;
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      original = { absolutePath, existed, content, eol: content.includes("\r\n") ? "\r\n" : "\n" };
      originalByPath.set(key, original);
      if (operation.action === "create" && existed) throw new Error(`Create target already exists: ${operation.path}`);
      if (operation.action === "replace" && (!existed || hash(content) !== operation.expected_hash)) {
        throw new Error(`Source changed since review: ${operation.path}`);
      }
    }
    let current = pendingByPath.get(key)?.content ?? normalizeLf(original.content);
    if (operation.action === "create") {
      current = normalizeLf(operation.content);
    } else {
      const search = normalizeLf(operation.search);
      const matches = countOccurrences(current, search);
      if (matches !== 1) {
        throw new Error(`Operation ${operation.operation_id} expected one exact match in ${operation.path}, found ${matches}.`);
      }
      current = current.replace(search, normalizeLf(operation.content));
    }
    pendingByPath.set(key, {
      absolutePath,
      content: original.eol === "\r\n" ? current.replace(/\n/g, "\r\n") : current,
      rootIndex: operation.root_index,
      relativePath: operation.path
    });
  }

  const written: string[] = [];
  try {
    for (const pending of pendingByPath.values()) {
      await fs.mkdir(path.dirname(pending.absolutePath), { recursive: true });
      await fs.writeFile(pending.absolutePath, pending.content, "utf8");
      written.push(`${pending.rootIndex}:${pending.relativePath}`);
    }
  } catch (error) {
    for (const key of written.reverse()) {
      const original = originalByPath.get(key);
      if (!original) continue;
      if (original.existed) await fs.writeFile(original.absolutePath, original.content, "utf8");
      else await fs.unlink(original.absolutePath).catch(() => undefined);
    }
    throw error;
  }

  const created: string[] = [];
  const modified: string[] = [];
  for (const [key, pending] of pendingByPath) {
    const original = originalByPath.get(key);
    (original?.existed ? modified : created).push(`${pending.rootIndex}:${pending.relativePath}`);
  }
  const runs: AnalysisRunResult[] = [];
  for (const run of plan.runs) {
    runs.push(await executeAnalysisRun(run, context.roots, pythonExecutable));
  }
  return { created, modified, runs };
}

export function serializeEngineeringResult(plan: EngineeringCodePlan, report: EngineeringApplyReport): string {
  const operationByPath = new Map(plan.operations.map((operation) => [
    `${operation.root_index}:${operation.path}`,
    operation
  ]));
  return [
    "APPLIED ENGINEERING CODE CHANGES",
    ...[...report.created, ...report.modified].map((changedPath) => {
      const operation = operationByPath.get(changedPath);
      return `${changedPath} | ${operation?.reason ?? "Changed by the approved engineering plan."}`;
    }),
    "",
    "ANALYSIS RUNS",
    ...report.runs.map((run) => [
      `RUN ${run.run_id} | success=${run.success} | exit=${run.exit_code ?? "unknown"}`,
      `python ${run.args.join(" ")}`,
      `Reason: ${run.reason}`,
      `STDOUT:\n${run.stdout || "(empty)"}`,
      `STDERR:\n${run.stderr || "(empty)"}`,
      "OUTPUTS:",
      ...run.outputs.flatMap((output) => [
        `${output.exists ? "FOUND" : "MISSING"} ${output.path} | ${output.absolutePath} | sha256=${output.hash || "n/a"} | ${output.size} bytes`,
        output.excerpt ? `TEXT OUTPUT EXCERPT:\n${output.excerpt}` : ""
      ].filter(Boolean))
    ].join("\n"))
  ].join("\n").slice(0, 80_000);
}

function validateRunSpec(run: AnalysisRunSpec, roots: string[], runIds: Set<string>): void {
  if (!run.run_id || runIds.has(run.run_id)) throw new Error("Every analysis run must have a unique run_id.");
  runIds.add(run.run_id);
  if (!Number.isInteger(run.root_index) || !roots[run.root_index]) throw new Error(`Run ${run.run_id} targets an unknown root.`);
  if (!Array.isArray(run.args) || run.args.length === 0 || run.args.length > 32 || !Array.isArray(run.expected_outputs)) {
    throw new Error(`Run ${run.run_id} has invalid arguments or outputs.`);
  }
  if (run.args.some((argument) => typeof argument !== "string" || /[\r\n\0]/.test(argument))) {
    throw new Error(`Run ${run.run_id} contains an unsafe argument.`);
  }
  if (run.args[0] === "-c" || run.args[0] === "-i") throw new Error(`Run ${run.run_id} may not execute inline or interactive Python.`);
  if (run.args[0] === "-m") {
    if (!run.args[1] || !["pytest", "unittest"].includes(run.args[1])) {
      throw new Error(`Run ${run.run_id} may invoke only pytest or unittest with -m.`);
    }
  } else {
    canonicalRelativePath(run.args[0], new Set([".py", ".pyw"]));
  }
  if (run.expected_outputs.length > 24) throw new Error(`Run ${run.run_id} declares too many outputs.`);
  for (const output of run.expected_outputs) canonicalRelativePath(output, OUTPUT_EXTENSIONS);
}

async function executeAnalysisRun(
  run: AnalysisRunSpec,
  roots: string[],
  pythonExecutable: string
): Promise<AnalysisRunResult> {
  const root = roots[run.root_index];
  const result = await new Promise<{ success: boolean; exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      pythonExecutable,
      run.args,
      { cwd: root, timeout: 120_000, maxBuffer: 2_000_000, windowsHide: true },
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
  const outputs: AnalysisOutputArtifact[] = [];
  for (const relativeOutput of run.expected_outputs) {
    const relativePath = canonicalRelativePath(relativeOutput, OUTPUT_EXTENSIONS);
    const absolutePath = await resolveWritablePath(root, relativePath);
    try {
      const content = await fs.readFile(absolutePath);
      outputs.push({
        path: `${run.root_index}:${relativePath}`,
        absolutePath,
        exists: true,
        hash: hash(content),
        size: content.byteLength,
        excerpt: TEXT_OUTPUT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
          ? content.toString("utf8").slice(0, 16_000)
          : ""
      });
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      outputs.push({ path: `${run.root_index}:${relativePath}`, absolutePath, exists: false, hash: "", size: 0, excerpt: "" });
    }
  }
  return {
    run_id: run.run_id,
    root_index: run.root_index,
    args: run.args,
    reason: run.reason,
    success: result.success,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs
  };
}

function canonicalRelativePath(input: string, extensions: Set<string>): string {
  const normalized = input.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Engineering file path must be relative: ${input}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || /[:*?"<>|\u0000-\u001f]/.test(part))) {
    throw new Error(`Engineering file path is unsafe: ${input}`);
  }
  const extension = path.posix.extname(normalized).toLowerCase();
  if (!extensions.has(extension)) throw new Error(`Engineering file type is not permitted: ${input}`);
  return normalized;
}

async function resolveExistingPath(root: string, relativePath: string): Promise<string> {
  const absolutePath = path.resolve(root, relativePath);
  assertWithinRoot(root, absolutePath);
  const real = await fs.realpath(absolutePath);
  assertWithinRoot(root, real);
  return real;
}

async function resolveWritablePath(root: string, relativePath: string): Promise<string> {
  const absolutePath = path.resolve(root, relativePath);
  assertWithinRoot(root, absolutePath);
  let existingParent = path.dirname(absolutePath);
  while (true) {
    try {
      const realParent = await fs.realpath(existingParent);
      assertWithinRoot(root, realParent);
      return absolutePath;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const next = path.dirname(existingParent);
      if (next === existingParent) throw new Error(`Could not resolve a safe parent for ${relativePath}.`);
      existingParent = next;
    }
  }
}

function assertWithinRoot(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes its configured engineering root: ${target}`);
  }
}

async function enumerateEngineeringFiles(
  root: string,
  limit: number
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let truncated = false;
  async function visit(directory: string): Promise<void> {
    if (paths.length >= limit) {
      truncated = true;
      return;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (paths.length >= limit) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
      } else if (entry.isFile() && ENGINEERING_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        paths.push(absolutePath);
      }
    }
  }
  await visit(root);
  return { paths, truncated };
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(search, index)) >= 0) {
    count += 1;
    index += search.length;
  }
  return count;
}

function normalizeLf(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function hash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
