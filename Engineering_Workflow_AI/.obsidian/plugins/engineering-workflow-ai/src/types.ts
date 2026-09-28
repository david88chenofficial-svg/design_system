export type WorkflowMode = "auto" | "build" | "evolve" | "audit" | "engineer";
export type PlanMode = "build" | "evolve" | "audit";
export type OperationAction = "create" | "replace";

export interface PluginSettings {
  model: string;
  maxFiles: number;
  maxContextChars: number;
  contextStrategyVersion: number;
  codeRootsByProject: Record<string, string[]>;
  codeBaselines: Record<string, CodeBaseline>;
  codeTraceStateByProject: Record<string, CodeTraceState>;
  pythonExecutable: string;
  maxCodeFiles: number;
  maxCodeContextChars: number;
  openOnStartup: boolean;
  activeProjectPath: string;
}

export type CodeChangeStatus = "added" | "modified" | "removed";

export interface CodeSymbolSnapshot {
  key: string;
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  hash: string;
  workflowIds: string[];
}

export interface CodeFileSnapshot {
  root: string;
  path: string;
  hash: string;
  symbols: CodeSymbolSnapshot[];
}

export type CodeBaseline = Record<string, CodeFileSnapshot>;

export interface CodeChange {
  status: CodeChangeStatus;
  root: string;
  path: string;
  absolutePath: string;
  symbol: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  workflowIds: string[];
  excerpt: string;
  localUrl: string;
  githubUrl: string;
}

export interface CodeScanReport {
  roots: string[];
  filesScanned: number;
  annotatedSymbols: number;
  changes: CodeChange[];
  omittedChanges: number;
  snapshot: CodeBaseline;
  serialized: string;
  truncated: boolean;
}

export type CodeTraceRelationship =
  | "candidate-model"
  | "implementation"
  | "comparison"
  | "verification"
  | "validation"
  | "parameter"
  | "input-output"
  | "design"
  | "test"
  | "other";

export interface CodeArtifact {
  artifactId: string;
  root: string;
  path: string;
  absolutePath: string;
  symbol: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  hash: string;
  workflowIds: string[];
  declaredRole: string;
  declaredModel: string;
  declaredEquation: string;
  summary: string;
  localUrl: string;
  githubUrl: string;
}

export interface CodeTraceCatalog {
  roots: string[];
  filesScanned: number;
  artifacts: CodeArtifact[];
  annotatedArtifacts: number;
  omittedArtifacts: number;
  snapshot: CodeBaseline;
  serialized: string;
  truncated: boolean;
}

export interface CodeTraceMapping {
  artifact_id: string;
  workflow_id: string;
  relationship: CodeTraceRelationship;
  label: string;
  rationale: string;
}

export interface CodeTraceResponse {
  summary: string;
  mappings: CodeTraceMapping[];
  warnings: string[];
}

export interface CodeTraceState {
  schemaVersion: number;
  workflowSignature: string;
  artifactHashes: Record<string, string>;
  mappings: CodeTraceMapping[];
}

export interface ContextFile {
  path: string;
  extension: "md" | "canvas";
  hash: string;
  content: string;
  truncated: boolean;
}

export interface ProjectIndexEntry {
  path: string;
  extension: "md" | "canvas";
  id: string;
  type: string;
  status: string;
  headings: string[];
  outbound: string[];
}

export interface ProjectIndex {
  projectPath: string;
  entries: ProjectIndexEntry[];
  primaryCanvasPath: string | null;
  primaryCanvasContent: string;
  activePath: string | null;
  serialized: string;
  truncated: boolean;
}

export interface ContextRoute {
  focus: string;
  rationale: string;
  selected_paths: string[];
  needs_broader_context: boolean;
}

export interface VaultContext {
  projectPath: string;
  files: ContextFile[];
  serialized: string;
  truncated: boolean;
  indexTruncated: boolean;
  selectedPaths: string[];
  selectionSummary: string;
}

export interface ChangeOperation {
  operation_id: string;
  action: OperationAction;
  path: string;
  expected_hash: string;
  content: string;
  reason: string;
}

export interface VaultChangePlan {
  mode: PlanMode;
  summary: string;
  assistant_message: string;
  operations: ChangeOperation[];
  warnings: string[];
  validation_checks: string[];
}

export interface ValidationReport {
  markdownFiles: number;
  canvasFiles: number;
  brokenLinks: string[];
  ambiguousLinks: string[];
  duplicateIds: string[];
  invalidCanvases: string[];
}

export interface ApplyReport {
  created: string[];
  replaced: string[];
  journalPath: string;
  validation: ValidationReport;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface EngineeringFileEntry {
  root_index: number;
  path: string;
  extension: string;
  size: number;
}

export interface EngineeringFileManifest {
  roots: string[];
  files: EngineeringFileEntry[];
  serialized: string;
  truncated: boolean;
}

export interface EngineeringContextSelection {
  root_index: number;
  path: string;
}

export interface EngineeringContextRoute {
  focus: string;
  rationale: string;
  selected_files: EngineeringContextSelection[];
  needs_more_context: boolean;
}

export interface EngineeringContextFile extends EngineeringContextSelection {
  absolutePath: string;
  hash: string;
  content: string;
  truncated: boolean;
}

export interface EngineeringCodeContext {
  roots: string[];
  files: EngineeringContextFile[];
  serialized: string;
  truncated: boolean;
}

export interface CodeEditOperation {
  operation_id: string;
  action: "create" | "replace";
  root_index: number;
  path: string;
  expected_hash: string;
  search: string;
  content: string;
  reason: string;
}

export interface AnalysisRunSpec {
  run_id: string;
  root_index: number;
  args: string[];
  expected_outputs: string[];
  reason: string;
}

export interface EngineeringCodePlan {
  summary: string;
  assistant_message: string;
  operations: CodeEditOperation[];
  runs: AnalysisRunSpec[];
  warnings: string[];
  verification_checks: string[];
}

export interface AnalysisOutputArtifact {
  path: string;
  absolutePath: string;
  exists: boolean;
  hash: string;
  size: number;
  excerpt: string;
}

export interface AnalysisRunResult {
  run_id: string;
  root_index: number;
  args: string[];
  reason: string;
  success: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  outputs: AnalysisOutputArtifact[];
}

export interface EngineeringApplyReport {
  created: string[];
  modified: string[];
  runs: AnalysisRunResult[];
}
