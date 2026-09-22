import { App, TFile, TFolder, normalizePath } from "obsidian";
import {
  PROJECTS_ROOT,
  canonicalProjectName,
  canonicalProjectPath,
  canonicalProjectReferencePath,
  canonicalVaultPath,
  scopedVaultPath,
  validateChangePlan
} from "./safety";
import { selectContextPaths } from "./retrieval";
import type {
  ApplyReport,
  ChangeOperation,
  ContextFile,
  ContextRoute,
  ProjectIndex,
  ProjectIndexEntry,
  ValidationReport,
  VaultChangePlan,
  VaultContext
} from "./types";

interface PreparedOperation {
  operation: ChangeOperation;
  vaultPath: string;
  appliedContent: string;
  file: TFile | null;
  original: string | null;
}

export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function listProjectPaths(app: App): string[] {
  const root = app.vault.getAbstractFileByPath(PROJECTS_ROOT);
  if (!(root instanceof TFolder)) return [];
  return root.children
    .filter((child): child is TFolder => child instanceof TFolder)
    .map((folder) => canonicalProjectPath(folder.path))
    .sort((left, right) => left.localeCompare(right));
}

export async function createProject(app: App, requestedName: string): Promise<string> {
  const name = canonicalProjectName(requestedName);
  const projectPath = canonicalProjectPath(`${PROJECTS_ROOT}/${name}`);
  await ensureFolder(app, PROJECTS_ROOT);
  if (app.vault.getAbstractFileByPath(projectPath)) {
    throw new Error(`A project named "${name}" already exists.`);
  }
  await app.vault.createFolder(projectPath);
  return projectPath;
}

export async function buildProjectIndex(
  app: App,
  projectPath: string,
  userRequest: string
): Promise<ProjectIndex> {
  const root = canonicalProjectPath(projectPath);
  const allProjectFiles = projectFiles(app, root)
    .filter((file) => file.extension === "md" || file.extension === "canvas")
    .sort((left, right) => left.path.localeCompare(right.path));
  const activeVaultPath = app.workspace.getActiveFile()?.path;
  const activePath = activeVaultPath?.startsWith(`${root}/`)
    ? relativeToProject(root, activeVaultPath)
    : null;
  const primaryCanvasFile = allProjectFiles
    .filter((file) => file.extension === "canvas")
    .sort((left, right) => canvasPriority(relativeToProject(root, right.path))
      - canvasPriority(relativeToProject(root, left.path)) || left.path.localeCompare(right.path))[0];
  const primaryCanvasPath = primaryCanvasFile ? relativeToProject(root, primaryCanvasFile.path) : null;

  const entries: ProjectIndexEntry[] = allProjectFiles.map((file) => {
    const cache = file.extension === "md" ? app.metadataCache.getFileCache(file) : null;
    const frontmatter = cache?.frontmatter;
    return {
      path: relativeToProject(root, file.path),
      extension: file.extension as "md" | "canvas",
      id: metadataText(frontmatter?.id),
      type: metadataText(frontmatter?.type),
      status: metadataText(frontmatter?.status),
      headings: (cache?.headings ?? []).map((heading) => heading.heading).slice(0, 8),
      outbound: []
    };
  });
  const aliases = buildPathAliases(entries);
  for (const entry of entries) {
    if (entry.extension !== "md") continue;
    const file = allProjectFiles.find((candidate) => relativeToProject(root, candidate.path) === entry.path);
    if (!file) continue;
    const cache = app.metadataCache.getFileCache(file);
    entry.outbound = unique((cache?.links ?? [])
      .map((link) => resolveProjectLink(entry.path, link.link, aliases))
      .filter((path): path is string => Boolean(path)));
  }

  let primaryCanvasContent = "";
  if (primaryCanvasFile && primaryCanvasPath) {
    const original = await app.vault.cachedRead(primaryCanvasFile);
    primaryCanvasContent = projectRelativeCanvasContent(root, original);
    const primaryEntry = entries.find((entry) => entry.path === primaryCanvasPath);
    if (primaryEntry) {
      primaryEntry.outbound = unique(canvasLinks(primaryCanvasContent)
        .map((target) => resolveProjectLink(primaryCanvasPath, target, aliases))
        .filter((path): path is string => Boolean(path)));
    }
  }

  const maxIndexChars = 24_000;
  const canvasLimit = Math.min(14_000, maxIndexChars);
  const canvasExcerpt = primaryCanvasContent.slice(0, canvasLimit);
  const sortedEntries = [...entries].sort((left, right) =>
    indexPriority(right, userRequest, activePath) - indexPriority(left, userRequest, activePath)
    || left.path.localeCompare(right.path));
  const header = [
    `ACTIVE FILE: ${activePath ?? "none"}`,
    primaryCanvasPath
      ? `PRIMARY CANVAS: ${primaryCanvasPath}\n${canvasExcerpt}`
      : "PRIMARY CANVAS: none"
  ].join("\n");
  const lines = ["PROJECT FILE MAP (metadata only; paths are project-relative)"];
  let used = header.length + lines[0].length + 2;
  let truncated = canvasExcerpt.length < primaryCanvasContent.length;
  for (const entry of sortedEntries) {
    const line = formatIndexEntry(entry);
    if (used + line.length + 1 > maxIndexChars) {
      truncated = true;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return {
    projectPath: root,
    entries,
    primaryCanvasPath,
    primaryCanvasContent,
    activePath,
    serialized: `${header}\n\n${lines.join("\n")}`,
    truncated
  };
}

export async function buildVaultContext(
  app: App,
  index: ProjectIndex,
  route: ContextRoute,
  userRequest: string,
  maxFiles: number,
  maxContextChars: number
): Promise<VaultContext> {
  const root = index.projectPath;
  const selectedPaths = selectContextPaths(index, route, userRequest, maxFiles);

  const files: ContextFile[] = [];
  let used = 0;
  let truncated = false;
  for (const selectedPath of selectedPaths) {
    const abstract = app.vault.getAbstractFileByPath(normalizePath(`${root}/${selectedPath}`));
    if (!(abstract instanceof TFile)) continue;
    const file = abstract;
    const original = await app.vault.cachedRead(file);
    const projectContent = file.extension === "canvas"
      ? projectRelativeCanvasContent(root, original)
      : original;
    const remaining = Math.max(0, maxContextChars - used);
    if (remaining === 0) {
      truncated = true;
      break;
    }
    const content = projectContent.slice(0, Math.min(projectContent.length, remaining));
    const fileTruncated = content.length < projectContent.length;
    files.push({
      path: relativeToProject(root, file.path),
      extension: file.extension as "md" | "canvas",
      hash: await sha256(original),
      content,
      truncated: fileTruncated
    });
    used += content.length;
    truncated ||= fileTruncated;
  }

  const selectionSummary = `${route.focus}: ${route.rationale}`;
  const serializedFiles = files.length > 0
    ? files
      .map((file) => [
        `FILE: ${file.path}`,
        `SHA256: ${file.hash}`,
        `TRUNCATED: ${file.truncated}`,
        "CONTENT:",
        file.content
      ].join("\n"))
      .join("\n\n=====\n\n")
    : "(The selected project is empty. Build from the user's stated outcome.)";
  const serialized = [
    `ROUTING FOCUS: ${route.focus}`,
    `ROUTING RATIONALE: ${route.rationale}`,
    `SELECTED PATHS: ${selectedPaths.join(" -> ") || "none"}`,
    serializedFiles
  ].join("\n\n");
  return {
    projectPath: root,
    files,
    serialized,
    truncated,
    indexTruncated: index.truncated,
    selectedPaths,
    selectionSummary
  };
}

function canvasPriority(path: string): number {
  const lower = path.toLowerCase();
  if (lower.endsWith("engineering workflow.canvas")) return 100;
  if (lower.includes("workflow") || lower.includes("overview") || lower.includes("main")) return 50;
  return 1;
}

function metadataText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(metadataText).filter(Boolean).join(", ");
  return "";
}

function buildPathAliases(entries: ProjectIndexEntry[]): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const entry of entries) {
    const filename = entry.path.split("/").pop() ?? entry.path;
    const withoutExtension = entry.path.replace(/\.(md|canvas)$/i, "");
    const stem = filename.replace(/\.(md|canvas)$/i, "");
    for (const alias of [entry.path, withoutExtension, filename, stem]) {
      const key = alias.toLowerCase();
      aliases.set(key, [...(aliases.get(key) ?? []), entry.path]);
    }
  }
  return aliases;
}

function resolveProjectLink(sourcePath: string, rawTarget: string, aliases: Map<string, string[]>): string | null {
  let target: string;
  try {
    target = decodeURIComponent(rawTarget).trim().replace(/\\/g, "/");
  } catch {
    return null;
  }
  target = target.split("|")[0].split("#")[0].replace(/^\.\//, "");
  if (!target) return null;
  const rootPrefix = `${PROJECTS_ROOT}/`;
  if (target.startsWith(rootPrefix)) {
    const projectAndRelative = target.slice(rootPrefix.length).split("/");
    if (projectAndRelative.length < 2) return null;
    target = projectAndRelative.slice(1).join("/");
  }
  const sourceFolder = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const candidates = [target, sourceFolder ? `${sourceFolder}/${target}` : target];
  const matches = new Set<string>();
  for (const candidate of candidates) {
    for (const key of [candidate, candidate.replace(/\.(md|canvas)$/i, "")]) {
      for (const match of aliases.get(normalizePath(key).toLowerCase()) ?? []) matches.add(match);
    }
  }
  return matches.size === 1 ? Array.from(matches)[0] : null;
}

function canvasLinks(content: string): string[] {
  try {
    const data = JSON.parse(content) as {
      nodes?: Array<{ type?: string; file?: string; text?: string }>;
    };
    if (!Array.isArray(data.nodes)) return [];
    const targets: string[] = [];
    for (const node of data.nodes) {
      if (node.type === "file" && node.file) targets.push(node.file);
      for (const match of (node.text ?? "").matchAll(/\[\[([^\]|#]+)/g)) targets.push(match[1].trim());
    }
    return unique(targets);
  } catch {
    return [];
  }
}

function indexPriority(entry: ProjectIndexEntry, request: string, activePath: string | null): number {
  let score = entry.path === activePath ? 1_000 : 0;
  if (entry.path.toLowerCase().endsWith("engineering workflow.canvas")) score += 900;
  if (/(^|\/)(home|current status|engineering stream|current approved|current candidate)(\.md)?$/i.test(entry.path)) score += 700;
  const haystack = [entry.path, entry.id, entry.type, entry.status, ...entry.headings].join(" ").toLowerCase();
  const tokens = request.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  for (const token of new Set(tokens)) if (haystack.includes(token)) score += 50;
  return score;
}

function formatIndexEntry(entry: ProjectIndexEntry): string {
  const fields = [
    entry.path,
    entry.id ? `id=${entry.id}` : "",
    entry.type ? `type=${entry.type}` : "",
    entry.status ? `status=${entry.status}` : "",
    entry.headings.length > 0 ? `headings=${entry.headings.join(" > ")}` : "",
    entry.outbound.length > 0 ? `links=${entry.outbound.join(", ")}` : ""
  ].filter(Boolean);
  return fields.join(" | ");
}

export async function applyChangePlan(
  app: App,
  projectPath: string,
  plan: VaultChangePlan
): Promise<ApplyReport> {
  validateChangePlan(plan);
  const root = canonicalProjectPath(projectPath);
  const prepared = await preflight(app, root, plan.operations);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const journalFolder = normalizePath(`${root}/04 Development Log/AI Changes/${stamp}`);
  await ensureFolder(app, journalFolder);

  const journal = {
    created_at: new Date().toISOString(),
    project: root,
    summary: plan.summary,
    mode: plan.mode,
    operations: prepared.map(({ operation, vaultPath, appliedContent, original }) => ({
      operation,
      vault_path: vaultPath,
      materialized_content: appliedContent === operation.content ? undefined : appliedContent,
      original_content: original
    }))
  };
  const journalPath = normalizePath(`${journalFolder}/change-journal.json`);
  await app.vault.create(journalPath, JSON.stringify(journal, null, 2));

  const created: string[] = [];
  const replaced: string[] = [];
  for (const item of prepared) {
    const { operation, vaultPath, appliedContent, file, original } = item;
    if (operation.action === "create") {
      await ensureFolder(app, parentPath(vaultPath));
      await app.vault.create(vaultPath, appliedContent);
      created.push(operation.path);
      continue;
    }
    if (!(file instanceof TFile) || original === null) {
      throw new Error(`Replacement target disappeared during apply: ${operation.path}`);
    }
    await app.vault.process(file, (current) => {
      if (current !== original) {
        throw new Error(`File changed after preview; no replacement was applied: ${operation.path}`);
      }
      return appliedContent;
    });
    replaced.push(operation.path);
  }

  const validation = await validateVaultStructure(app, root);
  return { created, replaced, journalPath, validation };
}

async function preflight(
  app: App,
  projectPath: string,
  operations: ChangeOperation[]
): Promise<PreparedOperation[]> {
  const prepared: PreparedOperation[] = [];
  for (const operation of operations) {
    operation.path = normalizePath(canonicalVaultPath(operation.path));
    const vaultPath = normalizePath(scopedVaultPath(projectPath, operation.path));
    const appliedContent = materializeContent(projectPath, operation.path, operation.content);
    const existing = app.vault.getAbstractFileByPath(vaultPath);
    if (operation.action === "create") {
      if (existing) throw new Error(`Create target already exists: ${operation.path}`);
      prepared.push({ operation, vaultPath, appliedContent, file: null, original: null });
      continue;
    }
    if (!(existing instanceof TFile)) {
      throw new Error(`Replacement target does not exist as a file: ${operation.path}`);
    }
    const original = await app.vault.read(existing);
    const actualHash = await sha256(original);
    if (actualHash.toLowerCase() !== operation.expected_hash.toLowerCase()) {
      throw new Error(`Replacement target changed since the plan was generated: ${operation.path}`);
    }
    prepared.push({ operation, vaultPath, appliedContent, file: existing, original });
  }
  return prepared;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  if (!path) return;
  const parts = normalizePath(path).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFile) throw new Error(`A file blocks the required folder: ${current}`);
    if (!(existing instanceof TFolder)) await app.vault.createFolder(current);
  }
}

function parentPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function materializeContent(projectPath: string, relativePath: string, content: string): string {
  if (!relativePath.toLowerCase().endsWith(".canvas")) return content;
  const data = JSON.parse(content) as {
    nodes: Array<{ type?: string; file?: string; [key: string]: unknown }>;
    edges: unknown[];
  };
  for (const node of data.nodes) {
    if (node.type !== "file" || !node.file) continue;
    const filePath = node.file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (filePath.startsWith(`${projectPath}/`)) {
      node.file = filePath;
      continue;
    }
    if (filePath.startsWith(`${PROJECTS_ROOT}/`)) {
      throw new Error(`Canvas file node points outside the selected project: ${node.file}`);
    }
    node.file = scopedVaultPath(projectPath, canonicalProjectReferencePath(filePath));
  }
  return JSON.stringify(data, null, 2);
}

function projectRelativeCanvasContent(projectPath: string, content: string): string {
  try {
    const data = JSON.parse(content) as {
      nodes?: Array<{ type?: string; file?: string; [key: string]: unknown }>;
      edges?: unknown[];
    };
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) return content;
    for (const node of data.nodes) {
      if (node.type === "file" && node.file?.startsWith(`${projectPath}/`)) {
        node.file = node.file.slice(projectPath.length + 1);
      }
    }
    return JSON.stringify(data, null, 2);
  } catch {
    return content;
  }
}

export async function validateVaultStructure(app: App, projectPath: string): Promise<ValidationReport> {
  const root = canonicalProjectPath(projectPath);
  const allFiles = projectFiles(app, root);
  const markdown = allFiles.filter((file) => file.extension === "md");
  const canvases = allFiles.filter((file) => file.extension === "canvas");
  const byName = new Map<string, string[]>();
  const byStem = new Map<string, string[]>();
  for (const file of allFiles) {
    const relativePath = relativeToProject(root, file.path);
    pushMap(byName, file.name.toLowerCase(), relativePath);
    pushMap(byStem, file.basename.toLowerCase(), relativePath);
  }

  const brokenLinks: string[] = [];
  const ambiguousLinks: string[] = [];
  const ids = new Map<string, string[]>();
  const invalidCanvases: string[] = [];
  for (const file of markdown) {
    const source = relativeToProject(root, file.path);
    const text = await app.vault.cachedRead(file);
    checkLinks(source, text, root, byName, byStem, brokenLinks, ambiguousLinks);
    const frontmatter = text.startsWith("---") ? text.split("---", 3)[1] : "";
    const id = /^id:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter)?.[1]?.trim().toLowerCase();
    if (id) pushMap(ids, id, source);
  }
  for (const file of canvases) {
    const source = relativeToProject(root, file.path);
    const text = await app.vault.cachedRead(file);
    try {
      const data = JSON.parse(text) as { nodes?: Array<{ type?: string; text?: string; file?: string }>; edges?: unknown[] };
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error("missing nodes or edges");
      const combined = data.nodes.map((node) => node.text ?? "").join("\n");
      checkLinks(source, combined, root, byName, byStem, brokenLinks, ambiguousLinks);
      for (const node of data.nodes) {
        if (node.type === "file" && node.file) {
          checkTarget(source, node.file, root, byName, byStem, brokenLinks, ambiguousLinks);
        }
      }
    } catch (error) {
      invalidCanvases.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const duplicateIds = Array.from(ids.entries())
    .filter(([, paths]) => paths.length > 1)
    .map(([id, paths]) => `${id}: ${paths.join(", ")}`);
  return {
    markdownFiles: markdown.length,
    canvasFiles: canvases.length,
    brokenLinks: unique(brokenLinks),
    ambiguousLinks: unique(ambiguousLinks),
    duplicateIds,
    invalidCanvases: unique(invalidCanvases)
  };
}

function projectFiles(app: App, projectPath: string): TFile[] {
  const prefix = `${canonicalProjectPath(projectPath)}/`;
  return app.vault.getFiles().filter((file) => file.path.startsWith(prefix));
}

function relativeToProject(projectPath: string, vaultPath: string): string {
  const prefix = `${canonicalProjectPath(projectPath)}/`;
  if (!vaultPath.startsWith(prefix)) throw new Error(`Path is outside the selected project: ${vaultPath}`);
  return vaultPath.slice(prefix.length);
}

function checkLinks(
  source: string,
  text: string,
  projectPath: string,
  byName: Map<string, string[]>,
  byStem: Map<string, string[]>,
  broken: string[],
  ambiguous: string[]
): void {
  for (const match of text.matchAll(/\[\[([^\]|#]+)/g)) {
    checkTarget(source, match[1].trim(), projectPath, byName, byStem, broken, ambiguous);
  }
}

function checkTarget(
  source: string,
  rawTarget: string,
  projectPath: string,
  byName: Map<string, string[]>,
  byStem: Map<string, string[]>,
  broken: string[],
  ambiguous: string[]
): void {
  let target: string;
  try {
    target = decodeURIComponent(rawTarget).replace(/\\/g, "/");
  } catch {
    broken.push(`${source} -> ${rawTarget}`);
    return;
  }
  if (target.startsWith(`${projectPath}/`)) target = target.slice(projectPath.length + 1);
  if (target.startsWith(`${PROJECTS_ROOT}/`)) {
    broken.push(`${source} -> ${rawTarget}`);
    return;
  }
  const name = target.split("/").pop()?.toLowerCase() ?? target.toLowerCase();
  const hasExtension = name.includes(".");
  const matches = (hasExtension ? byName.get(name) : byStem.get(name)) ?? [];
  if (matches.length === 0) broken.push(`${source} -> ${rawTarget}`);
  else if (matches.length > 1 && !target.includes("/")) ambiguous.push(`${source} -> ${rawTarget}`);
}

function pushMap(map: Map<string, string[]>, key: string, value: string): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}
