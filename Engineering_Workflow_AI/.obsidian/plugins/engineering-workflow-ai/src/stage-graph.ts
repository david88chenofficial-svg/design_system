import type { ExecutableStage, ProjectIndex, ProjectIndexEntry } from "./types";

const REQUIRED_STAGE_HEADINGS = [
  "inputs",
  "model or method",
  "outputs",
  "acceptance and verification"
];

interface CanvasStageNode {
  stageId: string;
  heading: string;
}

interface CanvasDocument {
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
}

export function isExecutableStageEntry(entry: ProjectIndexEntry): boolean {
  if (entry.extension !== "md" || entry.type.toLowerCase() !== "stage" || !entry.id) return false;
  const headings = new Set(entry.headings.map((heading) => heading.trim().toLowerCase()));
  return REQUIRED_STAGE_HEADINGS.every((heading) => headings.has(heading));
}

export function deriveStageDependencies(
  index: Pick<ProjectIndex, "primaryCanvasContent">,
  entries: ProjectIndexEntry[]
): Map<string, string[]> {
  const result = new Map(entries.map((entry) => [entry.id, [] as string[]]));
  if (!index.primaryCanvasContent.trim()) return result;
  let canvas: CanvasDocument;
  try {
    canvas = JSON.parse(index.primaryCanvasContent) as CanvasDocument;
  } catch {
    return result;
  }
  const aliases = buildAliases(entries);
  const nodes = new Map<string, CanvasStageNode>();
  for (const raw of canvas.nodes ?? []) {
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!id) continue;
    const reference = canvasReference(raw);
    if (!reference) continue;
    const stageId = aliases.get(normalizeReference(reference.target));
    if (stageId) nodes.set(id, { stageId, heading: reference.heading.toLowerCase() });
  }
  for (const raw of canvas.edges ?? []) {
    const from = nodes.get(typeof raw.fromNode === "string" ? raw.fromNode : "");
    const to = nodes.get(typeof raw.toNode === "string" ? raw.toNode : "");
    if (!from || !to || from.stageId === to.stageId) continue;
    const isMainStageEdge = !from.heading && !to.heading;
    const isInterfaceEdge = from.heading === "outputs" && (to.heading === "inputs" || !to.heading);
    if (!isMainStageEdge && !isInterfaceEdge) continue;
    const current = result.get(to.stageId) ?? [];
    if (!current.includes(from.stageId)) current.push(from.stageId);
    result.set(to.stageId, current);
  }
  return result;
}

export function topologicallyOrderStages(stages: ExecutableStage[]): ExecutableStage[] {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const remaining = new Map(stages.map((stage) => [
    stage.id,
    new Set(stage.dependencies.filter((dependency) => byId.has(dependency)))
  ]));
  const ordered: ExecutableStage[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => byId.get(id))
      .filter((stage): stage is ExecutableStage => Boolean(stage))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (ready.length === 0) {
      ordered.push(...[...remaining.keys()]
        .map((id) => byId.get(id))
        .filter((stage): stage is ExecutableStage => Boolean(stage))
        .sort((left, right) => left.path.localeCompare(right.path)));
      break;
    }
    for (const stage of ready) {
      ordered.push(stage);
      remaining.delete(stage.id);
      for (const dependencies of remaining.values()) dependencies.delete(stage.id);
    }
  }
  return ordered;
}

export function findDependencyCycleBlockers(stages: ExecutableStage[]): string[] {
  const known = new Set(stages.map((stage) => stage.id));
  const remaining = new Map(stages.map((stage) => [
    stage.id,
    new Set(stage.dependencies.filter((dependency) => known.has(dependency)))
  ]));
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id);
    if (ready.length === 0) return [...remaining.keys()].sort();
    for (const id of ready) {
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return [];
}

function buildAliases(entries: ProjectIndexEntry[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const entry of entries) {
    const withoutExtension = entry.path.replace(/\.md$/i, "");
    aliases.set(normalizeReference(entry.path), entry.id);
    aliases.set(normalizeReference(withoutExtension), entry.id);
    aliases.set(normalizeReference(withoutExtension.replace(/^.*\//, "")), entry.id);
  }
  return aliases;
}

function canvasReference(raw: Record<string, unknown>): { target: string; heading: string } | null {
  if (typeof raw.file === "string") {
    const [target, heading = ""] = raw.file.split("#", 2);
    return { target, heading };
  }
  if (typeof raw.text !== "string") return null;
  const match = raw.text.match(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]/);
  if (!match) return null;
  return { target: match[1].trim(), heading: (match[2] ?? "").trim() };
}

function normalizeReference(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "").toLowerCase();
}
