import { FileSystemAdapter, ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { resolveCodeRoots, scanCodeChanges } from "./code";
import { requestChangePlan, requestCodeImpactPlan, requestContextRoute } from "./openai";
import { createFallbackRoute } from "./retrieval";
import { applyChangePlan, buildProjectIndex, buildVaultContext, createProject, listProjectPaths } from "./vault";
import type EngineeringWorkflowAIPlugin from "./main";
import type {
  ChatMessage,
  CodeBaseline,
  CodeScanReport,
  ContextRoute,
  VaultChangePlan,
  VaultContext,
  WorkflowMode
} from "./types";

export const VIEW_TYPE_WORKFLOW_AI = "engineering-workflow-ai-chat";

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
        ? `${configuredRoots.length} external code root(s), plus project code/src auto-detection.`
        : "Project code/ and src/ folders are detected automatically. Add external roots in plugin settings.",
      cls: "workflow-ai-project-status"
    });
    this.codeReviewButton = section.createEl("button", { text: "Review code changes" });
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
    this.setBusy(true, "Scanning code locally and locating affected workflow blocks…");
    this.planContainer.empty();
    this.pendingPlan = null;
    this.pendingCodeBaseline = null;
    try {
      const roots = await resolveCodeRoots(
        adapter.getBasePath(),
        this.activeProjectPath,
        this.plugin.settings.codeRootsByProject[this.activeProjectPath] ?? []
      );
      if (roots.length === 0) {
        throw new Error("No code root was found. Add an external code root in plugin settings, or create a code/ or src/ folder inside the selected project.");
      }
      const previous = this.plugin.settings.codeBaselines[this.activeProjectPath] ?? {};
      const scan = await scanCodeChanges(roots, previous);
      if (scan.changes.length === 0) {
        this.appendMessage("assistant", `Code scan complete: ${scan.filesScanned} file(s), with no changes since the saved baseline.`);
        return;
      }
      if (scan.truncated || scan.omittedChanges > 0) {
        throw new Error(
          `The scan exceeded the safe review limit and omitted ${scan.omittedChanges} change(s). Narrow this project's code roots before reviewing; the saved baseline was not changed.`
        );
      }

      const request = codeRoutingRequest(scan);
      const index = await buildProjectIndex(this.app, this.activeProjectPath, request);
      const affectedIds = new Set(scan.changes.flatMap((change) => change.workflowIds.map((id) => id.toLowerCase())));
      const mappedPaths = index.entries
        .filter((entry) => entry.id && affectedIds.has(entry.id.toLowerCase()))
        .map((entry) => entry.path)
        .slice(0, 8);
      let route: ContextRoute;
      if (mappedPaths.length > 0) {
        route = {
          focus: "Workflow blocks explicitly linked from code",
          rationale: `Code annotations matched ${mappedPaths.length} existing workflow note(s).`,
          selected_paths: mappedPaths,
          needs_broader_context: false
        };
      } else {
        try {
          route = await requestContextRoute(apiKey, this.plugin.settings, "evolve", request, index, []);
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
        `Code scan: ${scan.filesScanned} file(s), ${scan.changes.length} change(s), ${scan.annotatedSymbols} workflow-linked symbol(s). Reviewing ${context.selectedPaths.length} workflow file(s).`
      );
      const plan = await requestCodeImpactPlan(apiKey, this.plugin.settings, context, scan);
      this.pendingPlan = plan;
      this.pendingCodeBaseline = scan.snapshot;
      this.appendMessage("assistant", plan.assistant_message);
      this.renderPlan(plan, context, scan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendMessage("assistant", `I could not review the code changes: ${message}`, true);
      new Notice(`Code review failed: ${message}`);
    } finally {
      this.setBusy(false);
    }
  }

  private renderPlan(plan: VaultChangePlan, context: VaultContext, codeReport?: CodeScanReport): void {
    this.planContainer.empty();
    const card = this.planContainer.createDiv({ cls: "workflow-ai-plan-card" });
    card.createEl("h4", { text: "Proposed local changes" });
    card.createEl("small", { text: `Project: ${this.activeProjectPath}`, cls: "workflow-ai-project-status" });
    card.createEl("p", { text: plan.summary });
    const contextDetails = card.createEl("details");
    contextDetails.createEl("summary", { text: `Context used: ${context.files.length} file(s)` });
    contextDetails.createEl("p", { text: context.selectionSummary });
    const contextList = contextDetails.createEl("ul");
    for (const path of context.selectedPaths) contextList.createEl("li", { text: path });
    if (codeReport) {
      const codeDetails = card.createEl("details");
      codeDetails.createEl("summary", { text: `Code changes reviewed: ${codeReport.changes.length}` });
      const codeList = codeDetails.createEl("ul", { cls: "workflow-ai-code-list" });
      for (const change of codeReport.changes) {
        const item = codeList.createEl("li");
        item.createSpan({ text: `${change.status.toUpperCase()}: ${change.path} :: ${change.symbol}` });
        if (change.workflowIds.length > 0) item.createEl("small", { text: ` → ${change.workflowIds.join(", ")}` });
        if (change.localUrl) item.createEl("a", { text: "Open code", href: change.localUrl });
        if (change.githubUrl) item.createEl("a", { text: "GitHub", href: change.githubUrl });
      }
      if (codeReport.truncated) card.createEl("p", { text: "The code-change report was capped; review the omitted changes in a later scan.", cls: "workflow-ai-warning" });
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
      this.planContainer.empty();
    });
    const save = buttons.createEl("button", { text: "Accept current code baseline", cls: "mod-cta" });
    save.addEventListener("click", () => void this.acceptCodeBaseline());
  }

  private async acceptCodeBaseline(): Promise<void> {
    if (!this.pendingCodeBaseline) return;
    await this.savePendingCodeBaseline();
    this.pendingPlan = null;
    this.planContainer.empty();
    this.appendMessage("assistant", "Saved the current code state as the reviewed baseline. Future scans will report changes from this point.");
    new Notice("Code review baseline saved.");
  }

  private async savePendingCodeBaseline(): Promise<void> {
    if (!this.pendingCodeBaseline) return;
    this.plugin.settings.codeBaselines = {
      ...this.plugin.settings.codeBaselines,
      [this.activeProjectPath]: this.pendingCodeBaseline
    };
    await this.plugin.saveSettings();
    this.pendingCodeBaseline = null;
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

function codeRoutingRequest(report: CodeScanReport): string {
  const lines = report.changes.slice(0, 20).map((change) => {
    const ids = change.workflowIds.length > 0 ? ` [${change.workflowIds.join(", ")}]` : "";
    return `${change.status} ${change.path} :: ${change.symbol}${ids}`;
  });
  return `Review these implementation changes and locate the affected workflow branch:\n${lines.join("\n")}`;
}
