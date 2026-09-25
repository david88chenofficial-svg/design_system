import { FileSystemAdapter, ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { resolveCodeRoots, scanCodeInventory, serializeCodeTraceCatalog } from "./code";
import { requestChangePlan, requestCodeTraceMappings, requestContextRoute } from "./openai";
import { createFallbackRoute } from "./retrieval";
import { buildCodeTracePlan } from "./trace";
import { applyChangePlan, buildProjectIndex, buildVaultContext, createProject, listProjectPaths } from "./vault";
import type EngineeringWorkflowAIPlugin from "./main";
import type {
  ChatMessage,
  CodeBaseline,
  CodeTraceCatalog,
  CodeTraceResponse,
  CodeTraceState,
  ContextRoute,
  ProjectIndex,
  VaultChangePlan,
  VaultContext,
  WorkflowMode
} from "./types";

export const VIEW_TYPE_WORKFLOW_AI = "engineering-workflow-ai-chat";
const CODE_TRACE_SCHEMA_VERSION = 1;

export class WorkflowAIView extends ItemView {
  private plugin: EngineeringWorkflowAIPlugin;
  private history: ChatMessage[] = [];
  private pendingPlan: VaultChangePlan | null = null;
  private messageList!: HTMLElement;
  private planContainer!: HTMLElement;
  private promptInput!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private codeReviewButton!: HTMLButtonElement;
  private mode: WorkflowMode = "auto";
  private activeProjectPath = "";
  private pendingCodeBaseline: CodeBaseline | null = null;
  private pendingCodeTraceState: CodeTraceState | null = null;

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
    this.containerEl.empty();
  }

  private async render(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("workflow-ai-view");

    const header = root.createDiv({ cls: "workflow-ai-header" });
    const icon = header.createSpan({ cls: "workflow-ai-header-icon" });
    setIcon(icon, "engineering-workflow-ai");
    const title = header.createDiv();
    title.createEl("h3", { text: "Engineering Workflow AI" });
    title.createEl("p", { text: "Plan first. Review. Then apply locally." });

    await this.renderProjectSection(root);
    this.renderKeySection(root);
    this.renderModeSection(root);
    this.renderCodeSection(root);

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
    const actions = composer.createDiv({ cls: "workflow-ai-composer-actions" });
    actions.createEl("span", { text: "Ctrl/Cmd + Enter to send", cls: "workflow-ai-hint" });
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
    row.createEl("label", { text: "Mode" });
    const select = row.createEl("select");
    for (const [value, label] of [
      ["auto", "Auto"],
      ["build", "Build from scratch"],
      ["evolve", "Add or modify branches"],
      ["audit", "Audit only"]
    ]) {
      select.createEl("option", { text: label, value });
    }
    select.value = this.mode;
    select.addEventListener("change", () => {
      this.mode = select.value as WorkflowMode;
    });
    row.createEl("span", { text: `Model: ${this.plugin.settings.model}`, cls: "workflow-ai-model" });
  }

  private renderCodeSection(root: HTMLElement): void {
    const configuredRoots = this.plugin.settings.codeRootsByProject[this.activeProjectPath] ?? [];
    const section = root.createDiv({ cls: "workflow-ai-code-section" });
    const text = section.createDiv();
    text.createEl("strong", { text: "Code traceability" });
    text.createEl("small", {
      text: configuredRoots.length > 0
        ? `${configuredRoots.length} external code root(s). Build exact symbol/region links into workflow records.`
        : "Project code/ and src/ folders are detected automatically. Add external roots in plugin settings.",
      cls: "workflow-ai-project-status"
    });
    this.codeReviewButton = section.createEl("button", { text: "Build/update code links" });
    this.codeReviewButton.addEventListener("click", () => void this.reviewCodeChanges());
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
    this.pendingCodeBaseline = null;
    this.pendingCodeTraceState = null;
    this.appendMessage("user", request);
    this.history.push({ role: "user", text: request });
    this.promptInput.value = "";
    this.setBusy(true, "Reading the project map and locating the relevant branch…");
    this.planContainer.empty();
    try {
      const index = await buildProjectIndex(this.app, this.activeProjectPath, request);
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
            priorHistory
          );
        } catch {
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
        priorHistory
      );
      this.pendingPlan = plan;
      this.appendMessage("assistant", plan.assistant_message);
      this.history.push({ role: "assistant", text: plan.assistant_message });
      this.renderPlan(plan, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendMessage("assistant", `I could not prepare the plan: ${message}`, true);
      new Notice(`Engineering Workflow AI: ${message}`);
    } finally {
      this.setBusy(false);
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
    this.setBusy(true, "Scanning exact code artifacts and mapping them to workflow records…");
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
      if (roots.length === 0) {
        throw new Error("No code root was found. Add an external code root in plugin settings, or create a code/ or src/ folder inside the selected project.");
      }
      const catalog = await scanCodeInventory(roots);
      if (catalog.truncated || catalog.omittedArtifacts > 0) {
        throw new Error(
          `The trace catalog exceeded the safe review limit and omitted ${catalog.omittedArtifacts} artifact(s). Narrow this project's code roots or add explicit workflow annotations; no baseline was changed.`
        );
      }
      const index = await buildProjectIndex(this.app, this.activeProjectPath, "Map exact code artifacts to their engineering workflow records");
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
        classified = await requestCodeTraceMappings(apiKey, this.plugin.settings, index, classificationCatalog);
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
      const message = error instanceof Error ? error.message : String(error);
      this.appendMessage("assistant", `I could not build the code links: ${message}`, true);
      new Notice(`Code-link build failed: ${message}`);
    } finally {
      this.setBusy(false);
    }
  }

  private renderPlan(
    plan: VaultChangePlan,
    context: VaultContext,
    traceReview?: { catalog: CodeTraceCatalog; mappings: CodeTraceResponse }
  ): void {
    this.planContainer.empty();
    const card = this.planContainer.createDiv({ cls: "workflow-ai-plan-card" });
    card.createEl("h4", { text: "Proposed local changes" });
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
      const issues = report.validation.brokenLinks.length + report.validation.ambiguousLinks.length + report.validation.duplicateIds.length + report.validation.invalidCanvases.length;
      this.appendMessage(
        "assistant",
        `Applied ${report.created.length} creation(s) and ${report.replaced.length} replacement(s). Structural validation found ${issues} issue(s). Change journal: ${report.journalPath}`,
        issues > 0
      );
      new Notice("Engineering workflow changes applied.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

  private appendMessage(role: "user" | "assistant", text: string, error = false): void {
    if (!this.messageList) return;
    const message = this.messageList.createDiv({ cls: `workflow-ai-message is-${role}${error ? " is-error" : ""}` });
    message.createDiv({ text: role === "user" ? "You" : "Workflow AI", cls: "workflow-ai-message-role" });
    message.createDiv({ text, cls: "workflow-ai-message-text" });
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  private setBusy(busy: boolean, label?: string): void {
    this.sendButton.disabled = busy;
    if (this.codeReviewButton) this.codeReviewButton.disabled = busy;
    this.promptInput.disabled = busy;
    this.sendButton.setText(busy ? "Working…" : "Send");
    if (busy && label) this.appendMessage("assistant", label);
  }
}

function codeWorkflowSignature(index: ProjectIndex): string {
  return index.entries
    .filter((entry) => entry.extension === "md" && entry.id)
    .map((entry) => [entry.id, entry.path, entry.type, entry.status, ...entry.headings].join("|"))
    .sort()
    .join("\n");
}
