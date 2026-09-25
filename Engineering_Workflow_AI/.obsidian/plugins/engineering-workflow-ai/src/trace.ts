import { App, TFile, normalizePath } from "obsidian";
import type {
  CodeArtifact,
  CodeTraceCatalog,
  CodeTraceMapping,
  CodeTraceResponse,
  ProjectIndex,
  VaultChangePlan
} from "./types";
import { sha256 } from "./vault";

const TRACE_START = "<!-- workflow-ai-code-trace:start -->";
const TRACE_END = "<!-- workflow-ai-code-trace:end -->";

export interface CodeTracePlanResult {
  plan: VaultChangePlan;
  mappingCount: number;
  targetCount: number;
}

export async function buildCodeTracePlan(
  app: App,
  projectPath: string,
  index: ProjectIndex,
  catalog: CodeTraceCatalog,
  response: CodeTraceResponse
): Promise<CodeTracePlanResult> {
  const artifacts = new Map(catalog.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const entriesById = new Map<string, typeof index.entries>();
  for (const entry of index.entries.filter((item) => item.extension === "md" && item.id)) {
    const key = entry.id.toLowerCase();
    entriesById.set(key, [...(entriesById.get(key) ?? []), entry]);
  }
  const grouped = new Map<string, Array<{ mapping: CodeTraceMapping; artifact: CodeArtifact }>>();
  for (const mapping of response.mappings) {
    const artifact = artifacts.get(mapping.artifact_id);
    const targets = entriesById.get(mapping.workflow_id.toLowerCase()) ?? [];
    if (!artifact || targets.length === 0) continue;
    if (targets.length > 1) throw new Error(`Workflow ID ${mapping.workflow_id} is duplicated; code links were not generated.`);
    grouped.set(targets[0].path, [...(grouped.get(targets[0].path) ?? []), { mapping, artifact }]);
  }

  const operations: VaultChangePlan["operations"] = [];
  const mappedPaths = new Set(grouped.keys());
  for (const entry of index.entries.filter((item) => item.extension === "md")) {
    const vaultPath = normalizePath(`${projectPath}/${entry.path}`);
    const file = app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) continue;
    const original = await app.vault.cachedRead(file);
    if (!mappedPaths.has(entry.path) && !original.includes(TRACE_START)) continue;
    const rows = grouped.get(entry.path) ?? [];
    const block = rows.length > 0 ? renderTraceBlock(rows, catalog) : "";
    const content = upsertTraceBlock(original, block);
    if (content === original) continue;
    operations.push({
      operation_id: `code-trace-${operations.length + 1}`,
      action: "replace",
      path: entry.path,
      expected_hash: await sha256(original),
      content,
      reason: rows.length > 0
        ? `Synchronize ${rows.length} exact code-artifact link(s) with workflow record ${entry.id || entry.path}.`
        : "Remove a generated code-trace block that no longer has a mapped implementation artifact."
    });
  }
  if (operations.length > 24) {
    throw new Error(`Code traceability affects ${operations.length} notes, exceeding the 24-note review limit. Narrow the code roots or workflow annotations.`);
  }

  const mappingCount = Array.from(grouped.values()).reduce((total, rows) => total + rows.length, 0);
  const targetCount = grouped.size;
  return {
    mappingCount,
    targetCount,
    plan: {
      mode: "evolve",
      summary: `Synchronize ${mappingCount} exact code-artifact mapping(s) across ${targetCount} workflow record(s).`,
      assistant_message: operations.length > 0
        ? `I found ${mappingCount} code-to-workflow relationship(s). The generated sections contain exact line links and keep model selection, verification and validation status unchanged.`
        : `The existing generated code links already match the ${mappingCount} classified relationship(s); no note changes are required.`,
      operations,
      warnings: response.warnings,
      validation_checks: [
        "Every generated code link comes from the local scanner rather than model-authored URLs.",
        "Every target workflow ID exists uniquely in the selected project.",
        "Generated sections do not change decision, verification, validation, release or approval status.",
        "Human-authored note content outside the generated section is preserved."
      ]
    }
  };
}

function renderTraceBlock(
  rows: Array<{ mapping: CodeTraceMapping; artifact: CodeArtifact }>,
  catalog: CodeTraceCatalog
): string {
  const sorted = [...rows].sort((left, right) =>
    left.mapping.relationship.localeCompare(right.mapping.relationship)
    || left.mapping.label.localeCompare(right.mapping.label)
    || left.artifact.path.localeCompare(right.artifact.path)
    || left.artifact.lineStart - right.artifact.lineStart);
  const table = sorted.map(({ mapping, artifact }) => {
    const local = `[open lines ${artifact.lineStart}-${artifact.lineEnd}](${artifact.localUrl})`;
    const revision = artifact.githubUrl ? ` · [GitHub permalink](${artifact.githubUrl})` : " · uncommitted/no GitHub permalink";
    const declared = [
      artifact.declaredModel ? `model: ${artifact.declaredModel}` : "",
      artifact.declaredEquation ? `equation: ${artifact.declaredEquation}` : ""
    ].filter(Boolean).join("; ");
    const symbol = escapeTable(`${artifact.path} :: ${artifact.symbol}`);
    const label = escapeTable(mapping.label);
    const relationship = escapeTable(mapping.relationship);
    const basis = escapeTable(`${mapping.rationale}${declared ? ` (${declared})` : ""}`);
    return `| ${label} | ${relationship} | \`${symbol}\` — ${local}${revision} | ${basis} | ${reviewStatus(mapping.relationship)} |`;
  });
  return [
    TRACE_START,
    "## Code traceability",
    "",
    "> Generated by Engineering Workflow AI from exact scanner locations. These links record implementation relationships only; they do not select a model or establish verification, validation, release maturity, or approval. Edit source annotations or rebuild links instead of editing this generated table.",
    "",
    `Scanned ${catalog.filesScanned} source file(s); classified ${sorted.length} artifact(s) for this workflow record.`,
    "",
    "| Candidate or artifact | Relationship | Exact implementation | Mapping basis | Engineering status |",
    "|---|---|---|---|---|",
    ...table,
    TRACE_END
  ].join("\n");
}

function upsertTraceBlock(original: string, block: string): string {
  const start = original.indexOf(TRACE_START);
  const end = original.indexOf(TRACE_END);
  if (start >= 0 && end >= start) {
    const after = end + TRACE_END.length;
    const replacement = block ? `${block}\n` : "";
    return `${original.slice(0, start).trimEnd()}\n\n${replacement}${original.slice(after).trimStart()}`.trimEnd() + "\n";
  }
  if (!block) return original;
  return `${original.trimEnd()}\n\n${block}\n`;
}

function reviewStatus(relationship: CodeTraceMapping["relationship"]): string {
  if (relationship === "candidate-model") return "Candidate only; selection remains open";
  if (relationship === "verification" || relationship === "test") return "Verification implementation linked; result not established";
  if (relationship === "validation") return "Validation implementation linked; physical agreement not established";
  if (relationship === "comparison") return "Comparison implementation linked; conclusion remains open";
  if (relationship === "parameter") return "Parameter implementation linked; engineering basis remains open";
  if (relationship === "design") return "Design implementation linked; design approval unchanged";
  return "Implementation observed; engineering review required";
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").replace(/`/g, "'").trim();
}
