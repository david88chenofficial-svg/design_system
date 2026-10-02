import { FileSystemAdapter, ItemView, Notice, TFile, TFolder, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import { formatAgentActivityEvent, formatNumber, totalAgentTokenUsage } from "./activity";
import { ensureProjectCodeRoot, resolveCodeRoots, scanCodeInventory, serializeCodeTraceCatalog } from "./code";
import {
  requestChangePlan,
  requestCodeTraceMappings,
  requestContextRoute,
  requestEngineeringCodePlan,
  requestEngineeringContextRoute,
  requestEngineeringResultPlan,
  requestStageCodePlan,
  requestStageVerificationPlan,
  requestStageVerificationVerdict
} from "./openai";
import {
  applyEngineeringCodePlan,
  buildEngineeringFileManifest,
  isEngineeringCodeRequest,
  readEngineeringCodeContext,
  serializeEngineeringResult
} from "./engineering";
import { createFallbackRoute } from "./retrieval";
import { REFERENCE_IMAGES_DIRECTORY, prepareReferenceImage } from "./reference-images";
import {
  asEngineeringCodePlan,
  executeStageVerification,
  hashStageCodeFiles,
  persistStageVerificationRecord,
  serializeStageVerificationEvidence
} from "./stage-execution";
import { discoverExecutableStages } from "./stages";
import { findDependencyCycleBlockers } from "./stage-graph";
import { buildCodeTracePlan } from "./trace";
import { applyChangePlan, buildProjectIndex, buildVaultContext, createProject, listProjectPaths } from "./vault";
import type EngineeringWorkflowAIPlugin from "./main";
import type {
  AgentActivityAgent,
  AgentActivityContext,
  AgentActivityEvent,
  AgentActivityStatus,
  ChatMessage,
  CodeBaseline,
  CodeTraceCatalog,
  CodeTraceResponse,
  CodeTraceState,
  ContextRoute,
  EngineeringCodeContext,
  EngineeringCodePlan,
  ExecutableStage,
  ProjectIndex,
  ReferenceImage,
  StageCodePlan,
  StageVerificationVerdict,
  VaultChangePlan,
  VaultContext,
  WorkflowMode
} from "./types";

export const VIEW_TYPE_WORKFLOW_AI = "engineering-workflow-ai-chat";
const CODE_TRACE_SCHEMA_VERSION = 1;

interface ActiveOperation {
  id: number;
  controller: AbortController;
}

class SessionAbortedError extends Error {
  constructor() {
    super("The current session was aborted.");
    this.name = "AbortError";
  }
}

export class WorkflowAIView extends ItemView {
  private plugin: EngineeringWorkflowAIPlugin;
  private history: ChatMessage[] = [];
  private pendingPlan: VaultChangePlan | null = null;
  private messageList!: HTMLElement;
  private planContainer!: HTMLElement;
  private promptInput!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private abortButton!: HTMLButtonElement;
  private codeReviewButton!: HTMLButtonElement;
  private mode: WorkflowMode = "auto";
  private activeProjectPath = "";
  private pendingCodeBaseline: CodeBaseline | null = null;
  private pendingCodeTraceState: CodeTraceState | null = null;
  private pendingEngineeringPlan: EngineeringCodePlan | null = null;
  private pendingEngineeringContext: EngineeringCodeContext | null = null;
  private pendingEngineeringRequest = "";
  private attachedImages: ReferenceImage[] = [];
  private attachmentList!: HTMLElement;
  private executableStages: ExecutableStage[] = [];
  private selectedStageIds = new Set<string>();
  private stageListContainer!: HTMLElement;
  private stageQueue: ExecutableStage[] = [];
  private activeStage: ExecutableStage | null = null;
  private activeStageAttempt = 0;
  private pendingStageCodePlan: StageCodePlan | null = null;
  private pendingStageCodeContext: EngineeringCodeContext | null = null;
  private pendingStageUpstreamContext = "";
  private pendingStageFeedback = "";
  private operationSequence = 0;
  private activeOperation: ActiveOperation | null = null;
  private activityEvents: AgentActivityEvent[] = [];
  private activityOpen = false;
  private activityAutoOpened = false;
  private activityButton!: HTMLButtonElement;
  private activityAbortButton!: HTMLButtonElement;
  private activityConsole!: HTMLElement;
  private activityLog!: HTMLElement;
  private activityTokenSummary!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: EngineeringWorkflowAIPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_WORKFLOW_AI;
  }

  getDisplayText(): string {
    return "Engineering Workflow AI";
  }

  getIcon(): string {
    return "engineering-workflow-ai";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.activeOperation?.controller.abort();
    this.activeOperation = null;
    this.resetStagePipeline();
    this.containerEl.empty();
  }

  private async render(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("workflow-ai-view");

    const header = root.createDiv({ cls: "workflow-ai-header" });
    const icon = header.createSpan({ cls: "workflow-ai-header-icon" });
    setIcon(icon, "engineering-workflow-ai");
    const title = header.createDiv({ cls: "workflow-ai-header-title" });
    title.createEl("h3", { text: "Engineering Workflow AI" });
    title.createEl("p", { text: "Build workflows, edit engineering code, run analyses, and preserve the evidence chain." });
    const headerActions = header.createDiv({ cls: "workflow-ai-header-actions" });
    this.activityButton = headerActions.createEl("button", {
      text: "Agent activity",
      attr: { type: "button", "aria-label": "Open agent activity console" }
    });
    this.activityButton.addEventListener("click", () => this.setActivityOpen(!this.activityOpen));
    this.renderActivityConsole(root);

    await this.renderProjectSection(root);
    this.renderKeySection(root);
    this.renderModeSection(root);
    await this.renderCodeSection(root);

    this.messageList = root.createDiv({ cls: "workflow-ai-messages" });
    const projectName = this.activeProjectPath.split("/").pop();
    this.appendMessage(
      "assistant",
      projectName
        ? `Project: ${projectName}. Tell me the engineering outcome you want, or ask me to evolve or audit this project.`
        : "Create or select a project, then tell me the engineering outcome you want."
    );

    this.planContainer = root.createDiv({ cls: "workflow-ai-plan" });

    const composer = root.createDiv({ cls: "workflow-ai-composer" });
    this.promptInput = composer.createEl("textarea", {
      attr: {
        placeholder: "What would you like to build or change?",
        rows: "5"
      }
    });
    this.promptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.send();
      }
    });
    const attachments = composer.createDiv({ cls: "workflow-ai-attachments" });
    const fileInput = attachments.createEl("input", {
      type: "file",
      attr: { accept: "image/png,image/jpeg,image/webp,image/gif", multiple: "true" }
    });
    fileInput.addClass("workflow-ai-file-input");
    const attachButton = attachments.createEl("button", { text: "Add reference images", attr: { type: "button" } });
    attachButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      void this.addReferenceImages(fileInput.files);
      fileInput.value = "";
    });
    this.attachmentList = attachments.createDiv({ cls: "workflow-ai-attachment-list" });
    this.renderAttachmentList();
    const actions = composer.createDiv({ cls: "workflow-ai-composer-actions" });
    actions.createEl("span", { text: "Ctrl/Cmd + Enter to send", cls: "workflow-ai-hint" });
    this.abortButton = actions.createEl("button", {
      text: "Abort",
      cls: "workflow-ai-abort",
      attr: { type: "button", "aria-label": "Abort the current AI or verification session" }
    });
    this.abortButton.hidden = true;
    this.abortButton.disabled = true;
    this.abortButton.addEventListener("click", () => this.abortCurrentSession());
    this.sendButton = actions.createEl("button", { text: "Send", cls: "mod-cta" });
    this.sendButton.addEventListener("click", () => void this.send());
  }

  private async renderProjectSection(root: HTMLElement): Promise<void> {
    const section = root.createDiv({ cls: "workflow-ai-project-section" });
    section.createEl("label", { text: "Project" });
    const projects = listProjectPaths(this.app);
    let selected = this.plugin.settings.activeProjectPath;
    if (!projects.includes(selected)) selected = projects[0] ?? "";
    if (selected !== this.plugin.settings.activeProjectPath) {
      this.plugin.settings.activeProjectPath = selected;
      await this.plugin.saveSettings();
    }
    this.activeProjectPath = selected;

    const select = section.createEl("select");
    if (projects.length === 0) {
      select.createEl("option", { text: "No projects yet", attr: { value: "" } });
      select.disabled = true;
    } else {
      for (const path of projects) {
        select.createEl("option", {
          text: path.slice(path.indexOf("/") + 1),
          attr: { value: path }
        });
      }
      select.value = selected;
      select.addEventListener("change", () => {
        void this.changeProject(select.value);
      });
    }

    const createRow = section.createDiv({ cls: "workflow-ai-project-create" });
    const input = createRow.createEl("input", {
      type: "text",
      attr: { placeholder: "New project name", maxlength: "80" }
    });
    const createButton = createRow.createEl("button", { text: "Create project" });
    const submit = (): void => {
      void this.createProjectFromInput(input, createButton);
    };
    createButton.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    section.createEl("small", {
      cls: "workflow-ai-project-status",
      text: selected
        ? `AI context, file changes and validation are limited to ${selected}.`
        : "Create a project before sending a request."
    });
  }

  private async changeProject(path: string): Promise<void> {
    if (!path || path === this.activeProjectPath) return;
    this.plugin.settings.activeProjectPath = path;
    await this.plugin.saveSettings();
    this.activeProjectPath = path;
    this.history = [];
    this.pendingPlan = null;
    this.pendingCodeBaseline = null;
    this.pendingCodeTraceState = null;
    this.pendingEngineeringPlan = null;
    this.pendingEngineeringContext = null;
    this.pendingEngineeringRequest = "";
    this.resetStagePipeline();
    this.attachedImages = [];
    await this.render();
    new Notice(`Active project: ${path.split("/").pop() ?? path}`);
  }

  private async createProjectFromInput(input: HTMLInputElement, button: HTMLButtonElement): Promise<void> {
    const name = input.value.trim();
    if (!name) {
      new Notice("Enter a project name first.");
      return;
    }
    button.disabled = true;
    button.setText("Creating…");
    try {
      const path = await createProject(this.app, name);
      this.plugin.settings.activeProjectPath = path;
      await this.plugin.saveSettings();
      this.activeProjectPath = path;
      this.history = [];
      this.pendingPlan = null;
      this.pendingCodeBaseline = null;
      this.pendingCodeTraceState = null;
      this.pendingEngineeringPlan = null;
      this.pendingEngineeringContext = null;
      this.pendingEngineeringRequest = "";
      this.resetStagePipeline();
      this.attachedImages = [];
      await this.render();
      new Notice(`Project created: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not create project: ${message}`);
      button.disabled = false;
      button.setText("Create project");
    }
  }

  private renderKeySection(root: HTMLElement): void {
    const section = root.createDiv({ cls: "workflow-ai-key-section" });
    section.createEl("label", { text: "OpenAI API key" });
    const row = section.createDiv({ cls: "workflow-ai-key-row" });
    const input = row.createEl("input", {
      type: "password",
      attr: { placeholder: "Paste API key" }
    });
    const save = row.createEl("button", { text: "Save key" });
    const clear = row.createEl("button", { text: "Clear" });
    const status = section.createEl("small", { cls: "workflow-ai-key-status" });
    const refresh = (): void => {
      const saved = Boolean(this.plugin.getApiKey());
      status.setText(saved ? "Key saved in Obsidian SecretStorage." : "A key is required before sending a request.");
      status.toggleClass("is-saved", saved);
    };
    refresh();
    save.addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) {
        new Notice("Paste an API key first.");
        return;
      }
      this.plugin.setApiKey(value);
      input.value = "";
      refresh();
      new Notice("API key saved with Obsidian SecretStorage.");
    });
    clear.addEventListener("click", () => {
      this.plugin.clearApiKey();
      input.value = "";
      refresh();
      new Notice("Saved API key cleared.");
    });
  }

  private renderModeSection(root: HTMLElement): void {
    const row = root.createDiv({ cls: "workflow-ai-mode-row" });
    row.createEl("label", { text: "Workflow mode" });
    const select = row.createEl("select");
    for (const [value, label] of [
      ["auto", "Auto"],
      ["build", "Build from scratch"],
      ["evolve", "Add or modify branches"],
      ["audit", "Audit only"],
      ["engineer", "Manual code + workflow"]
    ]) {
      select.createEl("option", { text: label, value });
    }
    select.value = this.mode;
    select.addEventListener("change", () => {
      this.mode = select.value as WorkflowMode;
    });
    row.createEl("span", { text: `Model: ${this.plugin.settings.model}`, cls: "workflow-ai-model" });
  }

  private async renderCodeSection(root: HTMLElement): Promise<void> {
    const configuredRoots = this.plugin.settings.codeRootsByProject[this.activeProjectPath] ?? [];
    const section = root.createDiv({ cls: "workflow-ai-code-section" });
    const text = section.createDiv();
    text.createEl("strong", { text: "Engineering code" });
    text.createEl("small", {
      text: configuredRoots.length > 0
        ? `${configuredRoots.length} external root(s). Stage code is reviewed before the independent Verifier prepares and runs cases.`
        : "Project code/ and src/ folders are detected automatically. Add external roots in plugin settings to edit an existing repository.",
      cls: "workflow-ai-project-status"
    });
    this.codeReviewButton = section.createEl("button", { text: "Build/update code links" });
    this.codeReviewButton.addEventListener("click", () => void this.reviewCodeChanges());
    const stageHeader = section.createDiv({ cls: "workflow-ai-stage-header" });
    stageHeader.createEl("strong", { text: "Executable workflow stages" });
    const attemptLabel = stageHeader.createEl("label", { text: "Max attempts" });
    const attempts = attemptLabel.createEl("input", {
      type: "number",
      attr: { min: "1", max: "8", step: "1", value: String(this.plugin.settings.maxStageAttempts) }
    });
    attempts.addEventListener("change", () => {
      const parsed = Number.parseInt(attempts.value, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 8) {
        attempts.value = String(this.plugin.settings.maxStageAttempts);
        return;
      }
      this.plugin.settings.maxStageAttempts = parsed;
      void this.plugin.saveSettings();
    });
    this.stageListContainer = section.createDiv({ cls: "workflow-ai-stage-list" });
    await this.refreshExecutableStages();
  }

  private async refreshExecutableStages(): Promise<void> {
    if (!this.stageListContainer || !this.activeProjectPath) return;
    this.stageListContainer.empty();
    try {
      const index = await buildProjectIndex(this.app, this.activeProjectPath, "executable model stages and their input/output handoffs");
      const records = this.plugin.settings.stageExecutionByProject[this.activeProjectPath] ?? {};
      const traceState = this.plugin.settings.codeTraceStateByProject[this.activeProjectPath];
      const adapter = this.app.vault.adapter;
      const codeRoots = adapter instanceof FileSystemAdapter
        ? await resolveCodeRoots(
          adapter.getBasePath(),
          this.activeProjectPath,
          this.plugin.settings.codeRootsByProject[this.activeProjectPath] ?? []
        )
        : [];
      this.executableStages = await discoverExecutableStages(this.app, index, records, traceState, codeRoots);
      const validIds = new Set(this.executableStages.map((stage) => stage.id));
      this.selectedStageIds = new Set([...this.selectedStageIds].filter((id) => validIds.has(id)));
      if (this.selectedStageIds.size === 0) {
        for (const stage of this.executableStages) {
          if (stage.status !== "verified") this.selectedStageIds.add(stage.id);
        }
      }
      if (this.executableStages.length === 0) {
        this.stageListContainer.createEl("small", {
          text: "No execution-ready model stages were found. Build or update the workflow so model-stage notes contain Inputs, Model or method, Outputs, and Acceptance and verification sections.",
          cls: "workflow-ai-project-status"
        });
        const refresh = this.stageListContainer.createEl("button", { text: "Refresh stages" });
        refresh.addEventListener("click", () => void this.refreshExecutableStages());
        return;
      }
      for (const stage of this.executableStages) {
        const row = this.stageListContainer.createEl("label", { cls: `workflow-ai-stage-row is-${stage.status}` });
        const checkbox = row.createEl("input", { type: "checkbox" });
        checkbox.checked = this.selectedStageIds.has(stage.id);
        checkbox.disabled = this.stageQueue.length > 0;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) this.selectedStageIds.add(stage.id);
          else this.selectedStageIds.delete(stage.id);
        });
        const text = row.createDiv();
        text.createEl("strong", { text: `${stage.id} — ${stage.title}` });
        text.createEl("small", {
          text: `${stageStatusLabel(stage.status)}${stage.dependencies.length > 0 ? ` · depends on ${stage.dependencies.join(", ")}` : ""}`,
          cls: "workflow-ai-project-status"
        });
      }
      const actions = this.stageListContainer.createDiv({ cls: "workflow-ai-stage-actions" });
      const selected = actions.createEl("button", { text: "Generate/modify selected", cls: "mod-cta" });
      selected.disabled = this.stageQueue.length > 0;
      selected.addEventListener("click", () => void this.startStageQueue(this.selectedStageIds));
      const all = actions.createEl("button", { text: "Generate/modify all unresolved" });
      all.disabled = this.stageQueue.length > 0;
      all.addEventListener("click", () => {
        const ids = new Set(this.executableStages
          .filter((stage) => stage.status !== "verified")
          .map((stage) => stage.id));
        void this.startStageQueue(ids);
      });
      const refresh = actions.createEl("button", { text: "Refresh" });
      refresh.disabled = this.stageQueue.length > 0;
      refresh.addEventListener("click", () => void this.refreshExecutableStages());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stageListContainer.createEl("small", { text: `Could not inspect executable stages: ${message}`, cls: "workflow-ai-warning" });
    }
  }

  private async startStageQueue(requestedIds: Set<string>): Promise<void> {
    if (requestedIds.size === 0) {
      new Notice("Select at least one executable stage.");
      return;
    }
    if (!this.plugin.getApiKey()) {
      new Notice("Save an OpenAI API key first.");
      return;
    }
    const included = new Set<string>();
    const includeWithDependencies = (stageId: string): void => {
      const stage = this.executableStages.find((candidate) => candidate.id === stageId);
      if (!stage || included.has(stageId)) return;
      for (const dependency of stage.dependencies) {
        const upstream = this.executableStages.find((candidate) => candidate.id === dependency);
        if (upstream && upstream.status !== "verified") includeWithDependencies(dependency);
      }
      included.add(stageId);
    };
    for (const stageId of requestedIds) includeWithDependencies(stageId);
    this.stageQueue = this.executableStages.filter((stage) => included.has(stage.id));
    if (this.stageQueue.length === 0) {
      new Notice("No executable stages require work.");
      return;
    }
    const cycleBlockers = findDependencyCycleBlockers(this.stageQueue);
    if (cycleBlockers.length > 0) {
      this.appendMessage("assistant", `The selected stage queue cannot start because its Canvas dependencies contain a cycle involving: ${cycleBlockers.join(", ")}. Resolve the data-flow cycle first.`, true);
      this.resetStagePipeline();
      await this.refreshExecutableStages();
      return;
    }
    this.activeStage = null;
    this.activeStageAttempt = 0;
    this.pendingStageFeedback = "";
    this.appendMessage("assistant", `Stage queue: ${this.stageQueue.map((stage) => stage.id).join(" → ")}. The Coder will prepare one stage at a time; code will not run until the independent Verifier has authored its cases.`);
    this.reportActivity(
      "System",
      "started",
      `Stage queue created: ${this.stageQueue.map((stage) => stage.id).join(" → ")}`,
      this.stageQueue[0]?.id,
      [`Maximum attempts per stage: ${this.plugin.settings.maxStageAttempts}`]
    );
    await this.refreshExecutableStages();
    await this.prepareNextStageCodePlan();
  }

  private async prepareNextStageCodePlan(): Promise<void> {
    const stage = this.stageQueue[0];
    const apiKey = this.plugin.getApiKey();
    if (!stage || !apiKey) {
      this.resetStagePipeline();
      await this.refreshExecutableStages();
      return;
    }
    if (this.activeStage?.id !== stage.id) {
      this.activeStage = stage;
      this.activeStageAttempt = 1;
      this.pendingStageFeedback = "";
    }
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      this.appendMessage("assistant", "Stage implementation requires an Obsidian desktop file-system vault.", true);
      this.resetStagePipeline();
      return;
    }
    const operation = this.beginOperation(`Coder preparing ${stage.id}, attempt ${this.activeStageAttempt}/${this.plugin.settings.maxStageAttempts}…`);
    this.planContainer.empty();
    try {
      let roots = await resolveCodeRoots(
        adapter.getBasePath(),
        this.activeProjectPath,
        this.plugin.settings.codeRootsByProject[this.activeProjectPath] ?? []
      );
      this.assertOperationActive(operation);
      if (roots.length === 0) roots = [await ensureProjectCodeRoot(adapter.getBasePath(), this.activeProjectPath)];
      this.assertOperationActive(operation);
      const manifest = await buildEngineeringFileManifest(roots);
      this.assertOperationActive(operation);
      const request = `${stage.id}: ${stage.title}\n\n${stage.contract}\n\n${this.pendingStageFeedback}`;
      let route = manifest.files.length === 0
        ? { focus: stage.id, rationale: "No existing engineering files are available; create the stage implementation.", selected_files: [], needs_more_context: false }
        : await requestEngineeringContextRoute(
          apiKey,
          this.plugin.settings,
          request,
          manifest,
          this.history,
          this.activityContext("Router", "Selecting implementation context", stage.id)
        );
      this.assertOperationActive(operation);
      route = this.augmentStageRoute(route, manifest, stage.id);
      const codeContext = await readEngineeringCodeContext(
        manifest,
        route,
        this.plugin.settings.maxCodeFiles,
        this.plugin.settings.maxCodeContextChars
      );
      this.assertOperationActive(operation);
      const upstreamContext = this.stageUpstreamContext(stage);
      const plan = await requestStageCodePlan(
        apiKey,
        this.plugin.settings,
        stage,
        this.activeProjectPath,
        codeContext,
        this.activeStageAttempt,
        this.pendingStageFeedback,
        upstreamContext,
        this.activityContext("Coder", `Preparing attempt ${this.activeStageAttempt}/${this.plugin.settings.maxStageAttempts}`, stage.id)
      );
      this.assertOperationActive(operation);
      this.pendingStageCodePlan = plan;
      this.pendingStageCodeContext = codeContext;
      this.pendingStageUpstreamContext = upstreamContext;
      this.reportActivity(
        "Coder",
        "progress",
        plan.summary,
        stage.id,
        plan.operations.map((item) => `${item.action.toUpperCase()} ${item.root_index}:${item.path}`)
      );
      this.appendMessage("assistant", plan.assistant_message);
      this.renderStageCodePlan(stage, plan, codeContext);
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.reportActivity("Coder", "error", message, stage.id);
      this.appendMessage("assistant", `The Coder could not prepare ${stage.id}: ${message}`, true);
      this.resetStagePipeline();
      await this.refreshExecutableStages();
    } finally {
      this.finishOperation(operation);
    }
  }

  private renderStageCodePlan(
    stage: ExecutableStage,
    plan: StageCodePlan,
    context: EngineeringCodeContext
  ): void {
    this.planContainer.empty();
    const card = this.planContainer.createDiv({ cls: "workflow-ai-plan-card" });
    this.renderPlanHeader(card, `Coder: ${stage.id} — attempt ${this.activeStageAttempt}/${this.plugin.settings.maxStageAttempts}`);
    card.createEl("p", { text: plan.summary });
    card.createEl("small", {
      text: `The Coder has not run this code. After approval, the Verifier will independently create the test inputs. Context: ${context.files.length} file(s).`,
      cls: "workflow-ai-project-status"
    });
    for (const warning of plan.warnings) card.createEl("p", { text: warning, cls: "workflow-ai-warning" });
    if (plan.operations.length === 0 || !plan.runner) {
      card.createEl("p", { text: "This stage is blocked until the missing contract information identified above is supplied." });
      const stop = card.createEl("button", { text: "Stop stage queue" });
      stop.addEventListener("click", () => {
        this.resetStagePipeline();
        this.planContainer.empty();
        void this.refreshExecutableStages();
      });
      return;
    }
    const list = card.createEl("ol", { cls: "workflow-ai-operation-list" });
    for (const operation of plan.operations) {
      const item = list.createEl("li");
      item.createEl("strong", { text: `${operation.action.toUpperCase()}: ${operation.root_index}:${operation.path}` });
      item.createEl("p", { text: operation.reason });
      const details = item.createEl("details");
      details.createEl("summary", { text: operation.action === "create" ? "Preview new file" : "Preview exact replacement" });
      if (operation.search) {
        details.createEl("small", { text: "Replace:" });
        details.createEl("pre", { text: operation.search });
        details.createEl("small", { text: "With:" });
      }
      details.createEl("pre", { text: operation.content });
    }
    card.createEl("p", { text: `Verifier interface: ${plan.runner.root_index}:${plan.runner.path} --input <json> --output <json>` });
    const actions = card.createDiv({ cls: "workflow-ai-plan-actions" });
    const cancel = actions.createEl("button", { text: "Stop stage queue" });
    cancel.addEventListener("click", () => {
      this.resetStagePipeline();
      this.planContainer.empty();
      void this.refreshExecutableStages();
    });
    const apply = actions.createEl("button", { text: "Apply code and let Verifier test", cls: "mod-cta" });
    apply.addEventListener("click", () => void this.applyPendingStageCodePlan(apply));
  }

  private async applyPendingStageCodePlan(button: HTMLButtonElement): Promise<void> {
    const stage = this.activeStage;
    const plan = this.pendingStageCodePlan;
    const context = this.pendingStageCodeContext;
    const apiKey = this.plugin.getApiKey();
    if (!stage || !plan || !plan.runner || !context || !apiKey) return;
    button.disabled = true;
    button.setText("Applying code…");
    const operation = this.beginOperation(`Applying ${stage.id}; no code will run until the Verifier prepares cases…`);
    try {
      const report = await applyEngineeringCodePlan(
        asEngineeringCodePlan(plan),
        context,
        this.plugin.settings.pythonExecutable,
        operation.controller.signal
      );
      this.assertOperationActive(operation);
      const changedFiles = [...report.created, ...report.modified];
      const codeFiles = Array.from(new Set([...changedFiles, `${plan.runner.root_index}:${plan.runner.path}`]));
      this.reportActivity(
        "Coder",
        "completed",
        `Applied ${changedFiles.length} reviewed code change${changedFiles.length === 1 ? "" : "s"}.`,
        stage.id,
        changedFiles.length > 0 ? changedFiles : ["No file content changed"]
      );
      await this.saveStageVerdict(stage, {
        stage_id: stage.id,
        verdict: "inconclusive",
        summary: "Coder changes were applied; independent verification has not completed.",
        key_numbers: [],
        checks: [],
        feedback: [],
        failure_modes: []
      }, codeFiles, context.roots);
      this.assertOperationActive(operation);
      this.appendMessage("assistant", `Coder changes applied for ${stage.id}: ${changedFiles.length} file(s). The Verifier is now preparing independent cases; the model has not run yet.`);
      const manifest = await buildEngineeringFileManifest(context.roots);
      this.assertOperationActive(operation);
      const selectedFiles = uniqueEngineeringSelections([
        ...plan.operations.map((operation) => ({ root_index: operation.root_index, path: operation.path })),
        { root_index: plan.runner.root_index, path: plan.runner.path },
        ...context.files.map((file) => ({ root_index: file.root_index, path: file.path }))
      ]).filter((selection) => manifest.files.some((file) =>
        file.root_index === selection.root_index && file.path === selection.path));
      const verificationContext = await readEngineeringCodeContext(
        manifest,
        { focus: stage.id, rationale: "Read the applied stage implementation for independent verification.", selected_files: selectedFiles, needs_more_context: false },
        this.plugin.settings.maxCodeFiles,
        this.plugin.settings.maxCodeContextChars
      );
      this.assertOperationActive(operation);
      const verificationPlan = await requestStageVerificationPlan(
        apiKey,
        this.plugin.settings,
        stage,
        plan.runner,
        verificationContext,
        this.pendingStageUpstreamContext,
        this.activityContext("Verifier", "Preparing independent verification cases", stage.id)
      );
      this.assertOperationActive(operation);
      if (verificationPlan.blocked_reason.trim()) {
        const blockedVerdict: StageVerificationVerdict = {
          stage_id: stage.id,
          verdict: "inconclusive",
          summary: verificationPlan.blocked_reason,
          key_numbers: [],
          checks: [],
          feedback: verificationPlan.warnings,
          failure_modes: [verificationPlan.blocked_reason]
        };
        await persistStageVerificationRecord(
          verificationPlan,
          [],
          blockedVerdict,
          plan.runner,
          context.roots,
          stage.id,
          this.activeStageAttempt
        );
        this.assertOperationActive(operation);
        await this.saveStageVerdict(stage, blockedVerdict, changedFiles, context.roots);
        this.assertOperationActive(operation);
        this.reportActivity("Verifier", "error", `Verification blocked: ${verificationPlan.blocked_reason}`, stage.id, verificationPlan.warnings);
        this.appendMessage("assistant", `Verifier blocked ${stage.id}: ${verificationPlan.blocked_reason}`, true);
        this.resetStagePipeline();
        await this.refreshExecutableStages();
        return;
      }
      this.reportActivity(
        "Verifier",
        "progress",
        verificationPlan.summary,
        stage.id,
        verificationPlan.cases.map((item) => `case ${item.case_id}: ${item.checks.length} check${item.checks.length === 1 ? "" : "s"}`)
      );
      this.appendMessage("assistant", `Verifier prepared ${verificationPlan.cases.length} case(s) for ${stage.id}. Controlled execution is starting now.`);
      this.setBusy(true, `Verifier running ${verificationPlan.cases.length} controlled case(s) for ${stage.id}…`);
      const results = await executeStageVerification(
        verificationPlan,
        plan.runner,
        context.roots,
        this.plugin.settings.pythonExecutable,
        stage.id,
        this.activeStageAttempt,
        operation.controller.signal,
        (progress) => {
          const completed = progress.phase === "completed";
          this.reportActivity(
            "Runner",
            completed ? (progress.success ? "completed" : "error") : "progress",
            completed
              ? `Case ${progress.index}/${progress.total} ${progress.caseId} ${progress.success ? "completed successfully" : "failed"}.`
              : `Running case ${progress.index}/${progress.total}: ${progress.caseId}`,
            stage.id,
            completed ? [`exit code: ${progress.exitCode ?? "unknown"}`] : undefined
          );
        }
      );
      this.assertOperationActive(operation);
      this.reportActivity(
        "Runner",
        results.every((result) => result.success) ? "completed" : "error",
        `${results.filter((result) => result.success).length}/${results.length} verification runs completed successfully.`,
        stage.id,
        results.map((result) => {
          const evidence = result.success ? result.output_text : result.stderr;
          return `${result.success ? "PASS" : "FAIL"} ${result.case_id} · ${compactActivityText(evidence || "no textual output", 260)}`;
        })
      );
      const evidence = serializeStageVerificationEvidence(verificationPlan, results);
      const verdict = await requestStageVerificationVerdict(
        apiKey,
        this.plugin.settings,
        stage,
        evidence,
        this.activityContext("Verifier", "Judging execution evidence", stage.id)
      );
      this.assertOperationActive(operation);
      await persistStageVerificationRecord(
        verificationPlan,
        results,
        verdict,
        plan.runner,
        context.roots,
        stage.id,
        this.activeStageAttempt
      );
      this.assertOperationActive(operation);
      await this.saveStageVerdict(stage, verdict, codeFiles, context.roots);
      this.assertOperationActive(operation);
      this.reportActivity(
        "Verifier",
        verdict.verdict === "pass" ? "completed" : verdict.verdict === "fail" ? "error" : "progress",
        `${verdict.verdict.toUpperCase()}: ${verdict.summary}`,
        stage.id,
        [
          ...verdict.key_numbers.map((value) => `key number: ${value}`),
          ...verdict.checks.map((check) => `${check.status.toUpperCase()}: ${check.check}`)
        ]
      );
      this.appendMessage(
        "assistant",
        `Verifier verdict for ${stage.id}: ${verdict.verdict.toUpperCase()}. ${verdict.summary}`,
        verdict.verdict !== "pass"
      );
      if (verdict.verdict === "pass") {
        this.stageQueue.shift();
        this.activeStage = null;
        this.activeStageAttempt = 0;
        this.pendingStageFeedback = "";
        this.pendingStageCodePlan = null;
        this.pendingStageCodeContext = null;
        await this.refreshExecutableStages();
        this.assertOperationActive(operation);
        if (this.stageQueue.length > 0) await this.prepareNextStageCodePlan();
        else {
          this.planContainer.empty();
          this.appendMessage("assistant", "All selected executable stages passed their independent verification cases. Physical validation and engineering approval remain separate workflow decisions.");
          this.reportActivity("System", "completed", "All selected executable stages passed independent verification.");
          this.resetStagePipeline();
        }
        return;
      }
      if (this.activeStageAttempt >= this.plugin.settings.maxStageAttempts) {
        this.reportActivity("System", "error", `${stage.id} exhausted ${this.plugin.settings.maxStageAttempts} attempt(s); downstream stages were not started.`, stage.id);
        this.appendMessage("assistant", `${stage.id} exhausted ${this.plugin.settings.maxStageAttempts} attempt(s). Downstream stages were not started.`, true);
        this.resetStagePipeline();
        await this.refreshExecutableStages();
        return;
      }
      this.activeStageAttempt += 1;
      this.reportActivity("System", "progress", `Returning Verifier feedback to the Coder for attempt ${this.activeStageAttempt}/${this.plugin.settings.maxStageAttempts}.`, stage.id);
      this.pendingStageFeedback = JSON.stringify(verdict, null, 2);
      this.pendingStageCodePlan = null;
      this.pendingStageCodeContext = null;
      await this.refreshExecutableStages();
      this.assertOperationActive(operation);
      await this.prepareNextStageCodePlan();
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.reportActivity("System", "error", message, stage.id);
      this.appendMessage("assistant", `Stage execution stopped for ${stage.id}: ${message}`, true);
      this.resetStagePipeline();
      await this.refreshExecutableStages();
    } finally {
      this.finishOperation(operation);
    }
  }

  private async saveStageVerdict(
    stage: ExecutableStage,
    verdict: StageVerificationVerdict,
    codeFiles: string[],
    codeRoots: string[]
  ): Promise<void> {
    const current = this.plugin.settings.stageExecutionByProject[this.activeProjectPath] ?? {};
    const allCodeFiles = Array.from(new Set([...(current[stage.id]?.codeFiles ?? []), ...codeFiles]));
    const codeHashes = await hashStageCodeFiles(allCodeFiles, codeRoots);
    const dependencySignatures = Object.fromEntries(stage.dependencies.map((dependency) => {
      const record = current[dependency];
      return [dependency, record ? `${record.contractHash}:${record.verdict}:${record.updatedAt}` : ""];
    }));
    this.plugin.settings.stageExecutionByProject = {
      ...this.plugin.settings.stageExecutionByProject,
      [this.activeProjectPath]: {
        ...current,
        [stage.id]: {
          stageId: stage.id,
          contractHash: stage.contractHash,
          verdict: verdict.verdict,
          attempts: this.activeStageAttempt,
          codeFiles: allCodeFiles,
          codeHashes,
          dependencySignatures,
          summary: verdict.summary,
          updatedAt: new Date().toISOString()
        }
      }
    };
    await this.plugin.saveSettings();
  }

  private stageUpstreamContext(stage: ExecutableStage): string {
    const records = this.plugin.settings.stageExecutionByProject[this.activeProjectPath] ?? {};
    return stage.dependencies.map((dependency) => {
      const record = records[dependency];
      return record
        ? `${dependency} | verdict=${record.verdict} | contract_sha256=${record.contractHash} | files=${record.codeFiles.join(", ")} | ${record.summary}`
        : `${dependency} | no accepted execution record`;
    }).join("\n");
  }

  private augmentStageRoute(
    route: { focus: string; rationale: string; selected_files: Array<{ root_index: number; path: string }>; needs_more_context: boolean },
    manifest: { files: Array<{ root_index: number; path: string }> },
    stageId: string
  ): typeof route {
    const record = this.plugin.settings.stageExecutionByProject[this.activeProjectPath]?.[stageId];
    const additional = (record?.codeFiles ?? []).map((value) => {
      const match = value.match(/^(\d+):(.*)$/);
      return match ? { root_index: Number.parseInt(match[1], 10), path: match[2] } : null;
    }).filter((selection): selection is { root_index: number; path: string } => Boolean(selection));
    const available = new Set(manifest.files.map((file) => `${file.root_index}:${file.path}`));
    return {
      ...route,
      selected_files: uniqueEngineeringSelections([...route.selected_files, ...additional])
        .filter((selection) => available.has(`${selection.root_index}:${selection.path}`))
        .slice(0, this.plugin.settings.maxCodeFiles)
    };
  }

  private resetStagePipeline(): void {
    this.stageQueue = [];
    this.activeStage = null;
    this.activeStageAttempt = 0;
    this.pendingStageCodePlan = null;
    this.pendingStageCodeContext = null;
    this.pendingStageUpstreamContext = "";
    this.pendingStageFeedback = "";
  }

  private async addReferenceImages(files: FileList | null): Promise<void> {
    if (!files) return;
    const supported = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    for (const file of Array.from(files)) {
      if (this.attachedImages.length >= 4) {
        new Notice("A request may include at most four reference images.");
        break;
      }
      if (!supported.has(file.type)) {
        new Notice(`Unsupported image type: ${file.name}`);
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        new Notice(`Reference image is larger than 10 MB: ${file.name}`);
        continue;
      }
      this.attachedImages.push({
        name: file.name,
        mimeType: file.type,
        dataUrl: await readFileDataUrl(file),
        projectRelativePath: ""
      });
    }
    this.renderAttachmentList();
  }

  private renderAttachmentList(): void {
    if (!this.attachmentList) return;
    this.attachmentList.empty();
    for (const image of this.attachedImages) {
      const chip = this.attachmentList.createDiv({ cls: "workflow-ai-attachment" });
      chip.createSpan({ text: image.name });
      const remove = chip.createEl("button", { text: "×", attr: { type: "button", "aria-label": `Remove ${image.name}` } });
      remove.addEventListener("click", () => {
        this.attachedImages = this.attachedImages.filter((candidate) => candidate !== image);
        this.renderAttachmentList();
      });
    }
  }

  private async persistReferenceImages(images: ReferenceImage[]): Promise<ReferenceImage[]> {
    if (images.length === 0) return [];
    const folderPath = normalizePath(`${this.activeProjectPath}/${REFERENCE_IMAGES_DIRECTORY}`);
    const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!existingFolder) await this.app.vault.createFolder(folderPath);
    else if (!(existingFolder instanceof TFolder)) {
      throw new Error(`${REFERENCE_IMAGES_DIRECTORY} exists but is not a folder.`);
    }

    const persisted: ReferenceImage[] = [];
    for (const source of images) {
      const prepared = prepareReferenceImage(source);
      const vaultPath = normalizePath(`${this.activeProjectPath}/${prepared.image.projectRelativePath}`);
      const existing = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!existing) await this.app.vault.createBinary(vaultPath, prepared.data);
      else if (!(existing instanceof TFile)) throw new Error(`Reference image path is not a file: ${vaultPath}`);
      persisted.push(prepared.image);
    }
    return persisted;
  }

  private async send(): Promise<void> {
    const request = this.promptInput.value.trim();
    if (!request) return;
    if (!this.activeProjectPath) {
      new Notice("Create or select a project first.");
      return;
    }
    const apiKey = this.plugin.getApiKey();
    if (!apiKey) {
      new Notice("Save an OpenAI API key first.");
      return;
    }
    const priorHistory = [...this.history];
    let images = [...this.attachedImages];
    if (images.length > 0) {
      try {
        images = await this.persistReferenceImages(images);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Could not save reference images: ${message}`);
        return;
      }
    }
    this.pendingCodeBaseline = null;
    this.pendingCodeTraceState = null;
    this.pendingEngineeringPlan = null;
    this.pendingEngineeringContext = null;
    this.pendingEngineeringRequest = "";
    const displayedRequest = images.length > 0
      ? `${request}\n\n[${images.length} reference image(s) saved: ${images.map((image) => image.projectRelativePath).join(", ")}]`
      : request;
    this.appendMessage("user", displayedRequest);
    this.history.push({ role: "user", text: displayedRequest });
    this.promptInput.value = "";
    this.attachedImages = [];
    this.renderAttachmentList();
    if (this.mode === "engineer" || (this.mode === "auto" && isEngineeringCodeRequest(request))) {
      await this.sendEngineeringRequest(request, apiKey, priorHistory, images);
      return;
    }
    const operation = this.beginOperation("Reading the project map and locating the relevant branch…");
    this.planContainer.empty();
    try {
      const index = await buildProjectIndex(this.app, this.activeProjectPath, request);
      this.assertOperationActive(operation);
      let route: ContextRoute;
      if (index.entries.length === 0) {
        route = {
          focus: "Empty project",
          rationale: "No existing branch needs to be loaded; the workflow can be built from the stated outcome.",
          selected_paths: [],
          needs_broader_context: false
        };
      } else {
        try {
          route = await requestContextRoute(
            apiKey,
            this.plugin.settings,
            this.mode,
            request,
            index,
            priorHistory,
            this.activityContext("Router", "Selecting the relevant workflow branch")
          );
        } catch (error) {
          if (isAbortError(error)) throw error;
          this.assertOperationActive(operation);
          route = createFallbackRoute(index, request);
        }
      }
      const context = await buildVaultContext(
        this.app,
        index,
        route,
        request,
        this.plugin.settings.maxFiles,
        this.plugin.settings.maxContextChars
      );
      this.assertOperationActive(operation);
      this.appendMessage(
        "assistant",
        context.selectedPaths.length > 0
          ? `Context route: ${route.focus}. Reading ${context.selectedPaths.length} relevant file(s): ${context.selectedPaths.join(" → ")}`
          : "Context route: empty project. No existing files need to be read."
      );
      const plan = await requestChangePlan(
        apiKey,
        this.plugin.settings,
        this.mode,
        request,
        context,
        priorHistory,
        images,
        this.activityContext("Planner", "Building the engineering workflow plan")
      );
      this.assertOperationActive(operation);
      this.pendingPlan = plan;
      this.reportActivity(
        "Planner",
        "progress",
        plan.summary,
        undefined,
        plan.operations.map((item) => `${item.action.toUpperCase()} ${item.path}`)
      );
      this.appendMessage("assistant", plan.assistant_message);
      this.history.push({ role: "assistant", text: plan.assistant_message });
      this.renderPlan(plan, context);
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.reportActivity("Planner", "error", message);
      this.appendMessage("assistant", `I could not prepare the plan: ${message}`, true);
      new Notice(`Engineering Workflow AI: ${message}`);
    } finally {
      this.finishOperation(operation);
    }
  }

  private async sendEngineeringRequest(
    request: string,
    apiKey: string,
    priorHistory: ChatMessage[],
    images: ReferenceImage[] = []
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      this.appendMessage("assistant", "Manual code + workflow mode requires an Obsidian desktop file-system vault.", true);
      return;
    }
    const operation = this.beginOperation("Locating the smallest relevant source, data, and workflow context…");
    this.planContainer.empty();
    try {
      const roots = await resolveCodeRoots(
        adapter.getBasePath(),
        this.activeProjectPath,
        this.plugin.settings.codeRootsByProject[this.activeProjectPath] ?? []
      );
      this.assertOperationActive(operation);
      if (roots.length === 0) {
        throw new Error("No engineering code root was found. Add an external root in Settings → Engineering Workflow AI, or create code/ or src/ inside the selected project.");
      }
      const manifest = await buildEngineeringFileManifest(roots);
      this.assertOperationActive(operation);
      const codeRoute = await requestEngineeringContextRoute(
        apiKey,
        this.plugin.settings,
        request,
        manifest,
        priorHistory,
        this.activityContext("Router", "Selecting engineering source context")
      );
      this.assertOperationActive(operation);
      const codeContext = await readEngineeringCodeContext(
        manifest,
        codeRoute,
        this.plugin.settings.maxCodeFiles,
        this.plugin.settings.maxCodeContextChars
      );
      this.assertOperationActive(operation);
      const index = await buildProjectIndex(this.app, this.activeProjectPath, request);
      this.assertOperationActive(operation);
      let workflowRoute: ContextRoute;
      if (index.entries.length === 0) {
        workflowRoute = {
          focus: "Empty workflow project",
          rationale: "No existing workflow record is available; result synchronization may create the minimum required record.",
          selected_paths: [],
          needs_broader_context: false
        };
      } else {
        try {
          workflowRoute = await requestContextRoute(
            apiKey,
            this.plugin.settings,
            "evolve",
            request,
            index,
            priorHistory,
            this.activityContext("Router", "Selecting workflow context for code generation")
          );
        } catch (error) {
          if (isAbortError(error)) throw error;
          this.assertOperationActive(operation);
          workflowRoute = createFallbackRoute(index, request);
        }
      }
      const workflowContext = await buildVaultContext(
        this.app,
        index,
        workflowRoute,
        request,
        this.plugin.settings.maxFiles,
        this.plugin.settings.maxContextChars
      );
      this.assertOperationActive(operation);
      this.appendMessage(
        "assistant",
        `Code route: ${codeRoute.focus}. Reading ${codeContext.files.length} engineering file(s): ${codeContext.files.map((file) => `${file.root_index}:${file.path}`).join(" → ")}. Workflow route: ${workflowRoute.focus}.`
      );
      const plan = await requestEngineeringCodePlan(
        apiKey,
        this.plugin.settings,
        request,
        this.activeProjectPath,
        workflowContext,
        codeContext,
        priorHistory,
        images,
        this.activityContext("Coder", "Preparing the engineering code change")
      );
      this.assertOperationActive(operation);
      this.pendingEngineeringPlan = plan;
      this.pendingEngineeringContext = codeContext;
      this.pendingEngineeringRequest = request;
      this.reportActivity(
        "Coder",
        "progress",
        plan.summary,
        undefined,
        plan.operations.map((item) => `${item.action.toUpperCase()} ${item.root_index}:${item.path}`)
      );
      this.appendMessage("assistant", plan.assistant_message);
      this.history.push({ role: "assistant", text: plan.assistant_message });
      this.renderEngineeringPlan(plan, codeContext, codeRoute.rationale);
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.reportActivity("Coder", "error", message);
      this.appendMessage("assistant", `I could not prepare the engineering code change: ${message}`, true);
      new Notice(`Engineering code request failed: ${message}`);
    } finally {
      this.finishOperation(operation);
    }
  }

  private renderEngineeringPlan(
    plan: EngineeringCodePlan,
    context: EngineeringCodeContext,
    routeRationale: string
  ): void {
    this.planContainer.empty();
    const card = this.planContainer.createDiv({ cls: "workflow-ai-plan-card" });
    this.renderPlanHeader(card, "Proposed code, data, and analysis changes");
    card.createEl("p", { text: plan.summary });
    const contextDetails = card.createEl("details");
    contextDetails.createEl("summary", { text: `Engineering context used: ${context.files.length} file(s)` });
    contextDetails.createEl("p", { text: routeRationale });
    const contextList = contextDetails.createEl("ul");
    for (const file of context.files) {
      contextList.createEl("li", { text: `${file.root_index}:${file.path}${file.truncated ? " (truncated; not writable)" : ""}` });
    }
    if (context.truncated) {
      card.createEl("p", {
        text: "Some repository context was omitted or truncated. The plan may edit only fully loaded files.",
        cls: "workflow-ai-warning"
      });
    }
    for (const warning of plan.warnings) card.createEl("p", { text: warning, cls: "workflow-ai-warning" });

    if (plan.operations.length === 0 && plan.runs.length === 0) {
      card.createEl("p", { text: "No executable changes were proposed. Supply the missing equations, units, conditions, data, or target file identified above." });
      return;
    }
    if (plan.operations.length > 0) {
      const list = card.createEl("ol", { cls: "workflow-ai-operation-list" });
      for (const operation of plan.operations) {
        const item = list.createEl("li");
        item.createEl("strong", { text: `${operation.action.toUpperCase()}: ${operation.root_index}:${operation.path}` });
        item.createEl("p", { text: operation.reason });
        const details = item.createEl("details");
        details.createEl("summary", { text: operation.action === "create" ? "Preview new file" : "Preview exact replacement" });
        if (operation.search) {
          details.createEl("small", { text: "Replace:" });
          details.createEl("pre", { text: operation.search });
          details.createEl("small", { text: "With:" });
        }
        details.createEl("pre", { text: operation.content });
      }
    }
    if (plan.runs.length > 0) {
      const runDetails = card.createEl("details", { cls: "workflow-ai-run-plan" });
      runDetails.createEl("summary", { text: `Python runs after applying: ${plan.runs.length}` });
      const runList = runDetails.createEl("ol");
      for (const run of plan.runs) {
        const item = runList.createEl("li");
        item.createEl("code", { text: `${this.plugin.settings.pythonExecutable} ${run.args.join(" ")}` });
        item.createEl("p", { text: run.reason });
        if (run.expected_outputs.length > 0) {
          item.createEl("small", { text: `Expected outputs: ${run.expected_outputs.join(", ")}` });
        }
      }
    }
    if (plan.verification_checks.length > 0) {
      const checks = card.createEl("details");
      checks.createEl("summary", { text: `Planned verification checks: ${plan.verification_checks.length}` });
      const list = checks.createEl("ul");
      for (const check of plan.verification_checks) list.createEl("li", { text: check });
    }
    const buttons = card.createDiv({ cls: "workflow-ai-plan-actions" });
    const discard = buttons.createEl("button", { text: "Discard" });
    discard.addEventListener("click", () => {
      this.pendingEngineeringPlan = null;
      this.pendingEngineeringContext = null;
      this.pendingEngineeringRequest = "";
      this.planContainer.empty();
    });
    const apply = buttons.createEl("button", { text: "Apply code, run, and sync workflow", cls: "mod-cta" });
    apply.addEventListener("click", () => void this.applyPendingEngineeringPlan(apply));
  }

  private async applyPendingEngineeringPlan(button: HTMLButtonElement): Promise<void> {
    const plan = this.pendingEngineeringPlan;
    const codeContext = this.pendingEngineeringContext;
    const request = this.pendingEngineeringRequest;
    const apiKey = this.plugin.getApiKey();
    if (!plan || !codeContext || !apiKey) return;
    button.disabled = true;
    button.setText("Applying and running…");
    const operation = this.beginOperation("Applying the reviewed source/data edits and running the declared Python analyses…");
    let codeApplied = false;
    try {
      const report = await applyEngineeringCodePlan(
        plan,
        codeContext,
        this.plugin.settings.pythonExecutable,
        operation.controller.signal
      );
      this.assertOperationActive(operation);
      codeApplied = true;
      const successfulRuns = report.runs.filter((run) => run.success).length;
      this.reportActivity(
        "Runner",
        report.runs.some((run) => !run.success) ? "error" : "completed",
        `Applied ${report.created.length + report.modified.length} code change${report.created.length + report.modified.length === 1 ? "" : "s"}; ${successfulRuns}/${report.runs.length} Python run${report.runs.length === 1 ? "" : "s"} succeeded.`,
        undefined,
        report.runs.map((run) => `${run.success ? "PASS" : "FAIL"} ${run.run_id} · exit ${run.exit_code ?? "unknown"}`)
      );
      this.appendMessage(
        "assistant",
        `Code applied: ${report.created.length} file(s) created and ${report.modified.length} file(s) modified. Python runs: ${successfulRuns}/${report.runs.length} succeeded. Synchronizing the observed results into the workflow now.`,
        report.runs.some((run) => !run.success)
      );

      const catalog = await scanCodeInventory(codeContext.roots);
      this.assertOperationActive(operation);
      const changed = new Set([...report.created, ...report.modified]);
      const affectedArtifacts = catalog.artifacts.filter((artifact) => {
        const rootIndex = codeContext.roots.findIndex((root) => root === artifact.root);
        return changed.has(`${rootIndex}:${artifact.path}`);
      });
      const exactArtifacts = affectedArtifacts.length > 0
        ? serializeCodeTraceCatalog(affectedArtifacts, catalog.filesScanned)
        : [...report.created, ...report.modified].join("\n");

      const index = await buildProjectIndex(this.app, this.activeProjectPath, request);
      this.assertOperationActive(operation);
      let route: ContextRoute;
      if (index.entries.length === 0) {
        route = {
          focus: "Create implementation evidence",
          rationale: "The project has no existing workflow record for the completed engineering change.",
          selected_paths: [],
          needs_broader_context: false
        };
      } else {
        try {
          route = await requestContextRoute(
            apiKey,
            this.plugin.settings,
            "evolve",
            request,
            index,
            this.history,
            this.activityContext("Router", "Selecting the result-synchronization branch")
          );
        } catch (error) {
          if (isAbortError(error)) throw error;
          this.assertOperationActive(operation);
          route = createFallbackRoute(index, request);
        }
      }
      const workflowContext = await buildVaultContext(
        this.app,
        index,
        route,
        request,
        this.plugin.settings.maxFiles,
        this.plugin.settings.maxContextChars
      );
      this.assertOperationActive(operation);
      const workflowPlan = await requestEngineeringResultPlan(
        apiKey,
        this.plugin.settings,
        request,
        workflowContext,
        serializeEngineeringResult(plan, report),
        exactArtifacts,
        this.activityContext("Planner", "Synchronizing execution evidence into the workflow")
      );
      this.assertOperationActive(operation);
      this.pendingEngineeringPlan = null;
      this.pendingEngineeringContext = null;
      this.pendingEngineeringRequest = "";
      this.pendingPlan = workflowPlan;
      this.pendingCodeBaseline = catalog.snapshot;
      this.appendMessage("assistant", workflowPlan.assistant_message);
      this.history.push({ role: "assistant", text: workflowPlan.assistant_message });
      this.renderPlan(workflowPlan, workflowContext);
      new Notice("Engineering code and analysis completed; review the workflow synchronization.");
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.reportActivity("System", "error", message);
      if (codeApplied) {
        this.pendingEngineeringPlan = null;
        this.pendingEngineeringContext = null;
        this.pendingEngineeringRequest = "";
        this.appendMessage(
          "assistant",
          `The reviewed code/data changes and declared runs completed, but the Obsidian synchronization could not be prepared: ${message}. The code changes remain applied; use Build/update code links after resolving the API or context problem.`,
          true
        );
        new Notice("Code changes remain applied, but workflow synchronization failed.");
      } else {
        this.appendMessage("assistant", `Engineering execution stopped before completing the code change: ${message}`, true);
        new Notice(`Engineering execution failed: ${message}`);
        button.disabled = false;
        button.setText("Apply code, run, and sync workflow");
      }
    } finally {
      this.finishOperation(operation);
    }
  }

  private async reviewCodeChanges(): Promise<void> {
    if (!this.activeProjectPath) {
      new Notice("Create or select a project first.");
      return;
    }
    const apiKey = this.plugin.getApiKey();
    if (!apiKey) {
      new Notice("Save an OpenAI API key first.");
      return;
    }
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("Code traceability requires an Obsidian desktop file-system vault.");
      return;
    }
    const operation = this.beginOperation("Scanning exact code artifacts and mapping them to workflow records…");
    this.planContainer.empty();
    this.pendingPlan = null;
    this.pendingCodeBaseline = null;
    this.pendingCodeTraceState = null;
    try {
      const roots = await resolveCodeRoots(
        adapter.getBasePath(),
        this.activeProjectPath,
        this.plugin.settings.codeRootsByProject[this.activeProjectPath] ?? []
      );
      this.assertOperationActive(operation);
      if (roots.length === 0) {
        throw new Error("No code root was found. Add an external code root in plugin settings, or create a code/ or src/ folder inside the selected project.");
      }
      const catalog = await scanCodeInventory(roots);
      this.assertOperationActive(operation);
      if (catalog.truncated || catalog.omittedArtifacts > 0) {
        throw new Error(
          `The trace catalog exceeded the safe review limit and omitted ${catalog.omittedArtifacts} artifact(s). Narrow this project's code roots or add explicit workflow annotations; no baseline was changed.`
        );
      }
      const index = await buildProjectIndex(this.app, this.activeProjectPath, "Map exact code artifacts to their engineering workflow records");
      this.assertOperationActive(operation);
      this.appendMessage(
        "assistant",
        `Code scan: ${catalog.filesScanned} file(s), ${catalog.artifacts.length} exact artifact(s), ${catalog.annotatedArtifacts} explicitly annotated artifact(s). Classifying relationships without changing engineering status.`
      );
      const signature = codeWorkflowSignature(index);
      const prior = this.plugin.settings.codeTraceStateByProject[this.activeProjectPath];
      const workflowIds = new Set(index.entries.filter((entry) => entry.id).map((entry) => entry.id.toLowerCase()));
      const artifactIds = new Set(catalog.artifacts.map((artifact) => artifact.artifactId));
      const canReuse = prior?.schemaVersion === CODE_TRACE_SCHEMA_VERSION
        && prior.workflowSignature === signature
        && typeof prior.artifactHashes === "object"
        && Array.isArray(prior.mappings);
      const reusableMappings = canReuse
        ? prior.mappings.filter((mapping) => artifactIds.has(mapping.artifact_id) && workflowIds.has(mapping.workflow_id.toLowerCase()))
        : [];
      const artifactsToClassify = canReuse
        ? catalog.artifacts.filter((artifact) => prior.artifactHashes[artifact.artifactId] !== artifact.hash)
        : catalog.artifacts;
      let classified: CodeTraceResponse;
      if (artifactsToClassify.length > 0) {
        const classificationCatalog: CodeTraceCatalog = {
          ...catalog,
          artifacts: artifactsToClassify,
          annotatedArtifacts: artifactsToClassify.filter((artifact) => artifact.workflowIds.length > 0).length,
          omittedArtifacts: 0,
          serialized: serializeCodeTraceCatalog(artifactsToClassify, catalog.filesScanned),
          truncated: false
        };
        classified = await requestCodeTraceMappings(
          apiKey,
          this.plugin.settings,
          index,
          classificationCatalog,
          this.activityContext("Planner", "Mapping code artifacts to workflow records")
        );
        this.assertOperationActive(operation);
      } else {
        classified = {
          summary: "No artifact semantics changed; reused the previously reviewed mappings and refreshed exact line/revision links locally.",
          mappings: [],
          warnings: []
        };
      }
      const reclassifiedIds = new Set(artifactsToClassify.map((artifact) => artifact.artifactId));
      const mappings: CodeTraceResponse = {
        summary: classified.summary,
        mappings: [
          ...reusableMappings.filter((mapping) => !reclassifiedIds.has(mapping.artifact_id)),
          ...classified.mappings
        ],
        warnings: classified.warnings
      };
      const result = await buildCodeTracePlan(this.app, this.activeProjectPath, index, catalog, mappings);
      this.assertOperationActive(operation);
      const targetIds = new Set(mappings.mappings.map((mapping) => mapping.workflow_id.toLowerCase()));
      const targetPaths = index.entries
        .filter((entry) => entry.id && targetIds.has(entry.id.toLowerCase()))
        .map((entry) => entry.path);
      const context: VaultContext = {
        projectPath: this.activeProjectPath,
        files: [],
        serialized: "",
        truncated: false,
        indexTruncated: index.truncated,
        selectedPaths: Array.from(new Set(targetPaths)),
        selectionSummary: `Exact trace build: ${result.mappingCount} artifact mapping(s) across ${result.targetCount} workflow record(s).`
      };
      this.pendingPlan = result.plan;
      this.pendingCodeBaseline = catalog.snapshot;
      this.pendingCodeTraceState = {
        schemaVersion: CODE_TRACE_SCHEMA_VERSION,
        workflowSignature: signature,
        artifactHashes: Object.fromEntries(catalog.artifacts.map((artifact) => [artifact.artifactId, artifact.hash])),
        mappings: mappings.mappings
      };
      this.appendMessage("assistant", result.plan.assistant_message);
      this.renderPlan(result.plan, context, { catalog, mappings });
    } catch (error) {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.reportActivity("Planner", "error", message);
      this.appendMessage("assistant", `I could not build the code links: ${message}`, true);
      new Notice(`Code-link build failed: ${message}`);
    } finally {
      this.finishOperation(operation);
    }
  }

  private renderPlan(
    plan: VaultChangePlan,
    context: VaultContext,
    traceReview?: { catalog: CodeTraceCatalog; mappings: CodeTraceResponse }
  ): void {
    this.planContainer.empty();
    const card = this.planContainer.createDiv({ cls: "workflow-ai-plan-card" });
    this.renderPlanHeader(card, "Proposed local changes");
    card.createEl("small", { text: `Project: ${this.activeProjectPath}`, cls: "workflow-ai-project-status" });
    card.createEl("p", { text: plan.summary });
    const contextDetails = card.createEl("details");
    contextDetails.createEl("summary", {
      text: traceReview
        ? `Workflow records targeted: ${context.selectedPaths.length}`
        : `Context used: ${context.files.length} file(s)`
    });
    contextDetails.createEl("p", { text: context.selectionSummary });
    const contextList = contextDetails.createEl("ul");
    for (const path of context.selectedPaths) contextList.createEl("li", { text: path });
    if (traceReview) {
      const codeDetails = card.createEl("details");
      codeDetails.createEl("summary", { text: `Exact code mappings: ${traceReview.mappings.mappings.length}` });
      const codeList = codeDetails.createEl("ul", { cls: "workflow-ai-code-list" });
      const artifactById = new Map(traceReview.catalog.artifacts.map((artifact) => [artifact.artifactId, artifact]));
      for (const mapping of traceReview.mappings.mappings) {
        const artifact = artifactById.get(mapping.artifact_id);
        if (!artifact) continue;
        const item = codeList.createEl("li");
        item.createSpan({ text: `${mapping.label}: ${artifact.path} :: ${artifact.symbol} → ${mapping.workflow_id}` });
        item.createEl("small", { text: ` ${mapping.relationship}; lines ${artifact.lineStart}-${artifact.lineEnd}` });
        item.createEl("a", { text: "Open exact code", href: artifact.localUrl });
        if (artifact.githubUrl) item.createEl("a", { text: "GitHub", href: artifact.githubUrl });
      }
    }
    if (context.truncated) card.createEl("p", { text: "One or more selected files were truncated to the configured context limit.", cls: "workflow-ai-warning" });
    if (context.indexTruncated) card.createEl("p", { text: "The compact project map was truncated; the most relevant metadata was retained.", cls: "workflow-ai-warning" });
    for (const warning of plan.warnings) card.createEl("p", { text: warning, cls: "workflow-ai-warning" });

    if (plan.operations.length === 0) {
      card.createEl("p", { text: "No file changes were proposed." });
      if (this.pendingCodeBaseline) this.renderBaselineActions(card);
      return;
    }
    const list = card.createEl("ol", { cls: "workflow-ai-operation-list" });
    for (const operation of plan.operations) {
      const item = list.createEl("li");
      item.createEl("strong", { text: `${operation.action.toUpperCase()}: ${operation.path}` });
      item.createEl("p", { text: operation.reason });
      const details = item.createEl("details");
      details.createEl("summary", { text: "Preview content" });
      details.createEl("pre", { text: operation.content });
    }
    const buttons = card.createDiv({ cls: "workflow-ai-plan-actions" });
    const discard = buttons.createEl("button", { text: "Discard" });
    discard.addEventListener("click", () => {
      this.pendingPlan = null;
      this.pendingCodeBaseline = null;
      this.pendingCodeTraceState = null;
      this.planContainer.empty();
    });
    const apply = buttons.createEl("button", { text: "Apply approved changes", cls: "mod-cta" });
    apply.addEventListener("click", () => void this.applyPendingPlan(apply));
  }

  private async applyPendingPlan(button: HTMLButtonElement): Promise<void> {
    if (!this.pendingPlan) return;
    button.disabled = true;
    button.setText("Applying…");
    try {
      const report = await applyChangePlan(this.app, this.activeProjectPath, this.pendingPlan);
      await this.savePendingCodeBaseline();
      this.pendingPlan = null;
      this.planContainer.empty();
      await this.refreshExecutableStages();
      const issues = report.validation.brokenLinks.length + report.validation.ambiguousLinks.length + report.validation.duplicateIds.length + report.validation.invalidCanvases.length;
      this.reportActivity(
        "Planner",
        issues > 0 ? "error" : "completed",
        `Applied ${report.created.length} creation${report.created.length === 1 ? "" : "s"} and ${report.replaced.length} replacement${report.replaced.length === 1 ? "" : "s"}; structural validation found ${issues} issue${issues === 1 ? "" : "s"}.`,
        undefined,
        [`journal: ${report.journalPath}`]
      );
      this.appendMessage(
        "assistant",
        `Applied ${report.created.length} creation(s) and ${report.replaced.length} replacement(s). Structural validation found ${issues} issue(s). Change journal: ${report.journalPath}`,
        issues > 0
      );
      new Notice("Engineering workflow changes applied.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportActivity("Planner", "error", `Applying approved workflow changes failed: ${message}`);
      this.appendMessage("assistant", `No further changes were applied: ${message}`, true);
      new Notice(`Apply failed: ${message}`);
      button.disabled = false;
      button.setText("Apply approved changes");
    }
  }

  private renderBaselineActions(card: HTMLElement): void {
    const buttons = card.createDiv({ cls: "workflow-ai-plan-actions" });
    const discard = buttons.createEl("button", { text: "Discard" });
    discard.addEventListener("click", () => {
      this.pendingPlan = null;
      this.pendingCodeBaseline = null;
      this.pendingCodeTraceState = null;
      this.planContainer.empty();
    });
    const save = buttons.createEl("button", { text: "Accept current trace state", cls: "mod-cta" });
    save.addEventListener("click", () => void this.acceptCodeBaseline());
  }

  private async acceptCodeBaseline(): Promise<void> {
    if (!this.pendingCodeBaseline) return;
    await this.savePendingCodeBaseline();
    this.pendingPlan = null;
    this.planContainer.empty();
    this.appendMessage("assistant", "Saved the current code trace state. Future builds will reuse unchanged mappings and classify only changed artifacts or a changed workflow graph.");
    new Notice("Code trace state saved.");
  }

  private async savePendingCodeBaseline(): Promise<void> {
    if (!this.pendingCodeBaseline) return;
    this.plugin.settings.codeBaselines = {
      ...this.plugin.settings.codeBaselines,
      [this.activeProjectPath]: this.pendingCodeBaseline
    };
    if (this.pendingCodeTraceState) {
      this.plugin.settings.codeTraceStateByProject = {
        ...this.plugin.settings.codeTraceStateByProject,
        [this.activeProjectPath]: this.pendingCodeTraceState
      };
    }
    await this.plugin.saveSettings();
    this.pendingCodeBaseline = null;
    this.pendingCodeTraceState = null;
  }

  private renderPlanHeader(card: HTMLElement, title: string): void {
    const header = card.createDiv({ cls: "workflow-ai-plan-header" });
    header.createEl("h4", { text: title });
    header.createEl("small", {
      text: "Drag the lower edge of this review area to resize it.",
      cls: "workflow-ai-resize-hint"
    });
  }

  private renderActivityConsole(root: HTMLElement): void {
    this.activityConsole = root.createDiv({ cls: "workflow-ai-activity-console" });
    this.activityConsole.hidden = !this.activityOpen;
    const header = this.activityConsole.createDiv({ cls: "workflow-ai-activity-header" });
    header.setAttribute("title", "Drag this header to move the console. Drag the lower-right edge to resize it.");
    const title = header.createDiv({ cls: "workflow-ai-activity-title" });
    title.createEl("strong", { text: "Agent Activity" });
    this.activityTokenSummary = title.createEl("small", { cls: "workflow-ai-activity-summary" });
    const actions = header.createDiv({ cls: "workflow-ai-activity-actions" });
    this.activityAbortButton = actions.createEl("button", {
      text: "Abort",
      cls: "workflow-ai-abort",
      attr: { type: "button", "aria-label": "Abort the active AI or verification session" }
    });
    this.activityAbortButton.disabled = !this.activeOperation;
    this.activityAbortButton.addEventListener("click", () => this.abortCurrentSession());
    const copy = actions.createEl("button", { text: "Copy log", attr: { type: "button" } });
    copy.addEventListener("click", () => {
      const log = this.activityEvents.map(formatAgentActivityEvent).join("\n\n");
      void this.copyMessage(copy, log || "No agent activity has been recorded in this session.");
    });
    const clear = actions.createEl("button", { text: "Clear", attr: { type: "button" } });
    clear.addEventListener("click", () => {
      this.activityEvents = [];
      this.activityAutoOpened = false;
      this.renderActivityEvents();
    });
    const close = actions.createEl("button", {
      text: "Close",
      attr: { type: "button", "aria-label": "Close agent activity console" }
    });
    close.addEventListener("click", () => this.setActivityOpen(false));
    this.activityLog = this.activityConsole.createDiv({ cls: "workflow-ai-activity-log" });
    this.activityConsole.createEl("small", {
      text: "Token counts are exact after each API response. The console shows agent summaries and execution evidence, not hidden model reasoning or full prompts.",
      cls: "workflow-ai-activity-footnote"
    });
    this.makeActivityConsoleDraggable(header);
    this.renderActivityEvents();
  }

  private makeActivityConsoleDraggable(handle: HTMLElement): void {
    let dragging = false;
    let pointerId = -1;
    let offsetX = 0;
    let offsetY = 0;
    const end = (): void => {
      if (!dragging) return;
      dragging = false;
      handle.removeClass("is-dragging");
      if (pointerId >= 0 && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      pointerId = -1;
    };
    handle.addEventListener("pointerdown", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      const rect = this.activityConsole.getBoundingClientRect();
      dragging = true;
      pointerId = event.pointerId;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      this.activityConsole.style.left = `${rect.left}px`;
      this.activityConsole.style.top = `${rect.top}px`;
      this.activityConsole.style.right = "auto";
      this.activityConsole.style.bottom = "auto";
      handle.addClass("is-dragging");
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      const rect = this.activityConsole.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      this.activityConsole.style.left = `${Math.min(maxLeft, Math.max(0, event.clientX - offsetX))}px`;
      this.activityConsole.style.top = `${Math.min(maxTop, Math.max(0, event.clientY - offsetY))}px`;
    });
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  private setActivityOpen(open: boolean): void {
    this.activityOpen = open;
    if (this.activityConsole) this.activityConsole.hidden = !open;
    if (this.activityButton) {
      this.activityButton.toggleClass("is-active", open);
      this.activityButton.setAttribute("aria-label", open ? "Close agent activity console" : "Open agent activity console");
    }
  }

  private activityContext(agent: AgentActivityAgent, label: string, stageId?: string): AgentActivityContext {
    return {
      agent,
      label,
      stageId,
      report: (event) => this.recordActivity(event)
    };
  }

  private reportActivity(
    agent: AgentActivityAgent,
    status: AgentActivityStatus,
    message: string,
    stageId?: string,
    details?: string[],
    durationMs?: number
  ): void {
    this.recordActivity({
      timestamp: new Date().toISOString(),
      agent,
      status,
      message,
      stageId,
      details,
      durationMs
    });
  }

  private recordActivity(event: AgentActivityEvent): void {
    this.activityEvents.push(event);
    if (this.activityEvents.length > 500) this.activityEvents.splice(0, this.activityEvents.length - 500);
    if (!this.activityAutoOpened) {
      this.activityAutoOpened = true;
      this.setActivityOpen(true);
    }
    this.renderActivityEvents();
  }

  private renderActivityEvents(): void {
    if (!this.activityLog || !this.activityTokenSummary) return;
    this.activityLog.empty();
    if (this.activityEvents.length === 0) {
      this.activityLog.createDiv({
        text: "No activity yet. Start a workflow or code-generation session to see progress here.",
        cls: "workflow-ai-activity-empty"
      });
    } else {
      for (const event of this.activityEvents) {
        this.activityLog.createEl("pre", {
          text: formatAgentActivityEvent(event),
          cls: `workflow-ai-activity-event is-${event.status}`
        });
      }
      this.activityLog.scrollTop = this.activityLog.scrollHeight;
    }
    const usage = totalAgentTokenUsage(this.activityEvents);
    const apiCalls = this.activityEvents.filter((event) => event.usage).length;
    this.activityTokenSummary.setText(
      apiCalls > 0
        ? `${apiCalls} API call${apiCalls === 1 ? "" : "s"} · ${formatNumber(usage.inputTokens)} in · ${formatNumber(usage.outputTokens)} out · ${formatNumber(usage.totalTokens)} total`
        : "Waiting for API usage"
    );
    if (this.activityButton) {
      this.activityButton.setText(usage.totalTokens > 0
        ? `Agent activity · ${formatNumber(usage.totalTokens)}`
        : "Agent activity");
    }
  }

  private appendMessage(role: "user" | "assistant", text: string, error = false): void {
    if (!this.messageList) return;
    const message = this.messageList.createDiv({ cls: `workflow-ai-message is-${role}${error ? " is-error" : ""}` });
    const header = message.createDiv({ cls: "workflow-ai-message-header" });
    header.createDiv({ text: role === "user" ? "You" : "Workflow AI", cls: "workflow-ai-message-role" });
    const copy = header.createEl("button", {
      text: "Copy",
      cls: "workflow-ai-message-copy",
      attr: { type: "button", "aria-label": `Copy ${role === "user" ? "your prompt" : "Workflow AI response"}` }
    });
    copy.addEventListener("click", () => void this.copyMessage(copy, text));
    message.createDiv({ text, cls: "workflow-ai-message-text" });
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  private async copyMessage(button: HTMLButtonElement, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      button.setText("Copied");
      button.setAttribute("aria-label", "Copied to clipboard");
      window.setTimeout(() => {
        if (!button.isConnected) return;
        button.setText("Copy");
        button.setAttribute("aria-label", "Copy message");
      }, 1_500);
    } catch {
      new Notice("Clipboard access failed. Select the message text and use Ctrl/Cmd+C.");
    }
  }

  private beginOperation(label: string): ActiveOperation {
    this.activeOperation?.controller.abort();
    const operation = {
      id: ++this.operationSequence,
      controller: new AbortController()
    };
    this.activeOperation = operation;
    this.setBusy(true, label);
    return operation;
  }

  private assertOperationActive(operation: ActiveOperation): void {
    if (operation.controller.signal.aborted || this.activeOperation?.id !== operation.id) {
      throw new SessionAbortedError();
    }
  }

  private finishOperation(operation: ActiveOperation): void {
    if (this.activeOperation?.id !== operation.id) return;
    this.activeOperation = null;
    this.setBusy(false);
  }

  private abortCurrentSession(): void {
    const operation = this.activeOperation;
    if (!operation) return;
    const stageId = this.activeStage?.id;
    this.activeOperation = null;
    operation.controller.abort();
    this.resetStagePipeline();
    this.pendingPlan = null;
    this.pendingCodeBaseline = null;
    this.pendingCodeTraceState = null;
    this.pendingEngineeringPlan = null;
    this.pendingEngineeringContext = null;
    this.pendingEngineeringRequest = "";
    this.planContainer.empty();
    this.setBusy(false);
    this.reportActivity("System", "aborted", "The active AI or verification session was aborted. Completed file changes may remain.", stageId);
    this.appendMessage(
      "assistant",
      "Session aborted. No further AI response or verification result will be applied. Any file changes completed before cancellation may remain; review the workspace before retrying."
    );
    new Notice("Engineering Workflow AI session aborted.");
    void this.refreshExecutableStages();
  }

  private setBusy(busy: boolean, label?: string): void {
    this.sendButton.disabled = busy;
    if (this.codeReviewButton) this.codeReviewButton.disabled = busy;
    this.promptInput.disabled = busy;
    if (this.abortButton) {
      this.abortButton.hidden = !busy;
      this.abortButton.disabled = !busy;
    }
    if (this.activityAbortButton) this.activityAbortButton.disabled = !busy;
    this.sendButton.setText(busy ? "Working…" : "Send");
    if (busy && label) this.appendMessage("assistant", label);
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function compactActivityText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function codeWorkflowSignature(index: ProjectIndex): string {
  return index.entries
    .filter((entry) => entry.extension === "md" && entry.id)
    .map((entry) => [entry.id, entry.path, entry.type, entry.status, ...entry.headings].join("|"))
    .sort()
    .join("\n");
}

function stageStatusLabel(status: ExecutableStage["status"]): string {
  switch (status) {
    case "verified":
      return "Verified";
    case "failed":
      return "Verification failed";
    case "inconclusive":
      return "Verification incomplete or inconclusive";
    case "stale":
      return "Stale — contract or dependency changed";
    case "unverified":
      return "Code linked but not verified";
    case "missing-code":
      return "Code required";
  }
}

function uniqueEngineeringSelections(
  selections: Array<{ root_index: number; path: string }>
): Array<{ root_index: number; path: string }> {
  const unique = new Map<string, { root_index: number; path: string }>();
  for (const selection of selections) {
    unique.set(`${selection.root_index}:${selection.path}`, selection);
  }
  return [...unique.values()];
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error(`Could not read ${file.name} as an image.`));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error(`Could not read ${file.name}.`)));
    reader.readAsDataURL(file);
  });
}
