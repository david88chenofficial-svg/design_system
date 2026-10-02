import { App, TFile, normalizePath } from "obsidian";
import type {
  CodeTraceState,
  ExecutableStage,
  ProjectIndex,
  StageExecutionRecord
} from "./types";
import { sha256 } from "./vault";
import { deriveStageDependencies, isExecutableStageEntry, topologicallyOrderStages } from "./stage-graph";
import { stageCodeFilesChanged } from "./stage-execution";

const CODE_RELATIONSHIPS = new Set(["candidate-model", "implementation", "input-output"]);

export async function discoverExecutableStages(
  app: App,
  index: ProjectIndex,
  records: Record<string, StageExecutionRecord> = {},
  traceState?: CodeTraceState,
  codeRoots: string[] = []
): Promise<ExecutableStage[]> {
  const entries = index.entries.filter(isExecutableStageEntry);
  const dependencies = deriveStageDependencies(index, entries);
  const stages: ExecutableStage[] = [];
  for (const entry of entries) {
    const file = app.vault.getAbstractFileByPath(normalizePath(`${index.projectPath}/${entry.path}`));
    if (!(file instanceof TFile)) continue;
    const contract = await app.vault.cachedRead(file);
    const contractHash = await sha256(contract);
    const record = records[entry.id];
    const codeLinked = Boolean(record?.codeFiles.length) || Boolean(traceState?.mappings.some((mapping) =>
      mapping.workflow_id.toLowerCase() === entry.id.toLowerCase()
      && CODE_RELATIONSHIPS.has(mapping.relationship)));
    let status: ExecutableStage["status"];
    if (record && (record.contractHash !== contractHash || await stageCodeFilesChanged(record, codeRoots))) status = "stale";
    else if (record?.verdict === "pass") status = "verified";
    else if (record?.verdict === "fail") status = "failed";
    else if (record) status = "inconclusive";
    else status = codeLinked ? "unverified" : "missing-code";
    stages.push({
      id: entry.id,
      title: entry.headings[0] || entry.path.replace(/^.*\//, "").replace(/\.md$/i, ""),
      path: entry.path,
      contract,
      contractHash,
      dependencies: dependencies.get(entry.id) ?? [],
      status,
      codeLinked
    });
  }

  const ordered = topologicallyOrderStages(stages);
  const byId = new Map(ordered.map((stage) => [stage.id, stage]));
  for (const stage of ordered) {
    if (stage.status !== "verified") continue;
    const record = records[stage.id];
    const dependencyChanged = stage.dependencies.some((dependency) => {
      const dependencyRecord = records[dependency];
      return !record?.dependencySignatures
        || record.dependencySignatures[dependency] !== stageExecutionSignature(dependencyRecord);
    });
    if (dependencyChanged || stage.dependencies.some((dependency) => byId.get(dependency)?.status !== "verified")) {
      stage.status = "stale";
    }
  }
  return ordered;
}

function stageExecutionSignature(record: StageExecutionRecord | undefined): string {
  return record ? `${record.contractHash}:${record.verdict}:${record.updatedAt}` : "";
}
