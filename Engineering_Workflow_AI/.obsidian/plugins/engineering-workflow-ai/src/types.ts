export type WorkflowMode = "auto" | "build" | "evolve" | "audit";
export type PlanMode = Exclude<WorkflowMode, "auto">;
export type OperationAction = "create" | "replace";

export interface PluginSettings {
  model: string;
  maxFiles: number;
  maxContextChars: number;
  contextStrategyVersion: number;
  codeRootsByProject: Record<string, string[]>;
  codeBaselines: Record<string, CodeBaseline>;
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
