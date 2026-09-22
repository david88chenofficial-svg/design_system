import type { VaultChangePlan } from "./types";

const SHA256_RE = /^[a-f0-9]{64}$/i;
const ALLOWED_EXTENSIONS = new Set(["md", "canvas"]);
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export const PROJECTS_ROOT = "Projects";

export function canonicalProjectName(input: string): string {
  const name = input.trim();
  if (!name || name.length > 80 || name === "." || name === "..") {
    throw new Error("Project name must contain 1 to 80 characters.");
  }
  if (name.startsWith(".") || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /[ .]$/.test(name)) {
    throw new Error("Project name contains characters that are unsafe in a folder name.");
  }
  if (WINDOWS_RESERVED_RE.test(name)) {
    throw new Error("Project name is reserved by Windows.");
  }
  return name;
}

export function canonicalProjectPath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = path.split("/");
  if (parts.length !== 2 || parts[0] !== PROJECTS_ROOT) {
    throw new Error(`Project must be a direct child of ${PROJECTS_ROOT}: ${input}`);
  }
  return `${PROJECTS_ROOT}/${canonicalProjectName(parts[1])}`;
}

export function canonicalProjectReferencePath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw new Error(`Path must be relative to the selected project: ${input}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Path contains an unsafe segment: ${input}`);
  }
  if (parts.some((part) => part.toLowerCase() === ".obsidian" || part.startsWith("."))) {
    throw new Error(`Hidden and Obsidian configuration paths are not allowed: ${input}`);
  }
  if (parts.some((part) => /[:*?"<>|\u0000-\u001f]/.test(part) || /[ .]$/.test(part))) {
    throw new Error(`Path contains characters that are unsafe in a file name: ${input}`);
  }
  return path;
}

export function canonicalVaultPath(input: string): string {
  const path = canonicalProjectReferencePath(input);
  if (path === PROJECTS_ROOT || path.startsWith(`${PROJECTS_ROOT}/`)) {
    throw new Error(`Operation paths must be relative to the selected project: ${input}`);
  }
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Only Markdown and Canvas files are allowed: ${input}`);
  }
  return path;
}

export function scopedVaultPath(projectPath: string, relativePath: string): string {
  return `${canonicalProjectPath(projectPath)}/${canonicalProjectReferencePath(relativePath)}`;
}

export function validateChangePlan(plan: VaultChangePlan, maxOperations = 24): void {
  if (!plan || !["build", "evolve", "audit"].includes(plan.mode)) {
    throw new Error("The AI response has an invalid workflow mode.");
  }
  if (!Array.isArray(plan.operations) || plan.operations.length > maxOperations) {
    throw new Error(`The plan exceeds the ${maxOperations}-operation safety limit.`);
  }
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const operation of plan.operations) {
    if (!operation.operation_id || ids.has(operation.operation_id)) {
      throw new Error("Every operation must have a unique operation_id.");
    }
    ids.add(operation.operation_id);
    if (operation.action !== "create" && operation.action !== "replace") {
      throw new Error(`Unsupported operation: ${String(operation.action)}`);
    }
    const path = canonicalVaultPath(operation.path);
    operation.path = path;
    const key = path.toLowerCase();
    if (paths.has(key)) {
      throw new Error(`The plan modifies the same path more than once: ${path}`);
    }
    paths.add(key);
    if (!operation.content || operation.content.length > 300_000) {
      throw new Error(`Operation content is empty or too large: ${path}`);
    }
    if (operation.action === "create" && operation.expected_hash !== "") {
      throw new Error(`Create operations must use an empty expected_hash: ${path}`);
    }
    if (operation.action === "replace" && !SHA256_RE.test(operation.expected_hash)) {
      throw new Error(`Replace operations require the supplied SHA-256 hash: ${path}`);
    }
    if (path.toLowerCase().endsWith(".canvas")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(operation.content);
      } catch {
        throw new Error(`Canvas content is not valid JSON: ${path}`);
      }
      if (!isCanvasData(parsed)) {
        throw new Error(`Canvas content must contain nodes and edges arrays: ${path}`);
      }
    }
  }
}

function isCanvasData(value: unknown): value is { nodes: unknown[]; edges: unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.nodes) && Array.isArray(record.edges);
}
