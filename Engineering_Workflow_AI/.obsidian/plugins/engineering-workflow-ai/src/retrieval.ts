import type { ContextRoute, ProjectIndex, ProjectIndexEntry } from "./types";

const CORE_PATTERN = /(^|\/)(home|current status|engineering stream|current approved|current candidate)(\.md)?$/i;

export function createFallbackRoute(index: ProjectIndex, request: string): ContextRoute {
  const ranked = index.entries
    .filter((entry) => entry.path !== index.primaryCanvasPath)
    .map((entry) => ({ entry, score: relevance(entry, request) }))
    .sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path));
  const positive = ranked.filter((item) => item.score > 0).slice(0, 3).map((item) => item.entry.path);
  const selected = positive.length > 0
    ? positive
    : [
      ...(index.activePath ? [index.activePath] : []),
      ...ranked.filter((item) => CORE_PATTERN.test(item.entry.path)).map((item) => item.entry.path)
    ].filter((path, position, paths) => paths.indexOf(path) === position).slice(0, 3);
  return {
    focus: selected.length > 0 ? "Best local graph match" : "Project overview",
    rationale: "The AI router was unavailable, so the plugin selected context from local path, metadata, heading and link matches.",
    selected_paths: selected,
    needs_broader_context: false
  };
}

export function selectContextPaths(
  index: ProjectIndex,
  route: ContextRoute,
  request: string,
  maxFiles: number
): string[] {
  if (index.entries.length === 0 || maxFiles <= 0) return [];
  const byPath = new Map(index.entries.map((entry) => [entry.path.toLowerCase(), entry]));
  const byName = groupBy(index.entries, (entry) => basename(entry.path).toLowerCase());
  const byStem = groupBy(index.entries, (entry) => stem(entry.path).toLowerCase());
  const chosen: string[] = [];
  const add = (path: string | null | undefined): void => {
    if (!path || chosen.length >= maxFiles || chosen.includes(path)) return;
    if (byPath.has(path.toLowerCase())) chosen.push(byPath.get(path.toLowerCase())!.path);
  };

  add(index.primaryCanvasPath);

  const routeSeeds: string[] = [];
  for (const raw of route.selected_paths) {
    const resolved = resolveSelection(raw, byPath, byName, byStem);
    if (resolved) {
      add(resolved);
      if (resolved !== index.primaryCanvasPath && !routeSeeds.includes(resolved)) routeSeeds.push(resolved);
    }
  }

  if (routeSeeds.length === 0) {
    const fallback = createFallbackRoute(index, request);
    for (const raw of fallback.selected_paths) {
      const resolved = resolveSelection(raw, byPath, byName, byStem);
      if (resolved) {
        add(resolved);
        if (resolved !== index.primaryCanvasPath && !routeSeeds.includes(resolved)) routeSeeds.push(resolved);
      }
    }
  }

  const inbound = new Map<string, string[]>();
  for (const entry of index.entries) {
    for (const target of entry.outbound) {
      inbound.set(target, [...(inbound.get(target) ?? []), entry.path]);
    }
  }
  let frontier = [...routeSeeds];
  const visited = new Set(frontier);
  for (let depth = 0; depth < 2 && frontier.length > 0 && chosen.length < maxFiles; depth += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      const entry = byPath.get(path.toLowerCase());
      if (!entry) continue;
      const neighbours = [...entry.outbound, ...(inbound.get(entry.path) ?? [])]
        .filter((candidate) => candidate !== index.primaryCanvasPath)
        .sort((left, right) => {
          const leftEntry = byPath.get(left.toLowerCase());
          const rightEntry = byPath.get(right.toLowerCase());
          return relevance(rightEntry, request) - relevance(leftEntry, request) || left.localeCompare(right);
        });
      for (const neighbour of neighbours) {
        add(neighbour);
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }

  for (const entry of index.entries.filter((item) => CORE_PATTERN.test(item.path))) add(entry.path);
  return chosen.slice(0, maxFiles);
}

function resolveSelection(
  raw: string,
  byPath: Map<string, ProjectIndexEntry>,
  byName: Map<string, ProjectIndexEntry[]>,
  byStem: Map<string, ProjectIndexEntry[]>
): string | null {
  const cleaned = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const exact = byPath.get(cleaned.toLowerCase());
  if (exact) return exact.path;
  const name = basename(cleaned).toLowerCase();
  const matches = name.includes(".") ? byName.get(name) : byStem.get(name);
  return matches?.length === 1 ? matches[0].path : null;
}

function relevance(entry: ProjectIndexEntry | undefined, request: string): number {
  if (!entry) return 0;
  const tokens = tokenize(request);
  const path = entry.path.toLowerCase();
  const metadata = [entry.id, entry.type, entry.status, ...entry.headings].join(" ").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (path.includes(token)) score += 5;
    if (metadata.includes(token)) score += 2;
  }
  if (CORE_PATTERN.test(entry.path)) score += 1;
  return score;
}

function tokenize(text: string): string[] {
  return Array.from(new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])
    .filter((token) => !["the", "and", "for", "with", "that", "this", "want", "add", "new", "into", "from"].includes(token))));
}

function groupBy(
  entries: ProjectIndexEntry[],
  key: (entry: ProjectIndexEntry) => string
): Map<string, ProjectIndexEntry[]> {
  const result = new Map<string, ProjectIndexEntry[]>();
  for (const entry of entries) result.set(key(entry), [...(result.get(key(entry)) ?? []), entry]);
  return result;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function stem(path: string): string {
  return basename(path).replace(/\.(md|canvas)$/i, "");
}
