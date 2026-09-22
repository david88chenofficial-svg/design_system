import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { requestChangePlan, requestContextRoute } from "./openai";
import { createFallbackRoute } from "./retrieval";
import { applyChangePlan, buildProjectIndex, buildVaultContext, createProject, listProjectPaths } from "./vault";
import type EngineeringWorkflowAIPlugin from "./main";
import type { ChatMessage, ContextRoute, VaultChangePlan, VaultContext, WorkflowMode } from "./types";

export const VIEW_TYPE_WORKFLOW_AI = "engineering-workflow-ai-chat";

export class WorkflowAIView extends ItemView {
  private plugin: EngineeringWorkflowAIPlugin;
  private history: ChatMessage[] = [];
  private pendingPlan: VaultChangePlan | null = null;
  private messageList!: HTMLElement;
  private planContainer!: HTMLElement;
  private promptInput!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private mode: WorkflowMode = "auto";
  private activeProjectPath = "";

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

  private renderPlan(plan: VaultChangePlan, context: VaultContext): void {
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
    if (context.truncated) card.createEl("p", { text: "One or more selected files were truncated to the configured context limit.", cls: "workflow-ai-warning" });
    if (context.indexTruncated) card.createEl("p", { text: "The compact project map was truncated; the most relevant metadata was retained.", cls: "workflow-ai-warning" });
    for (const warning of plan.warnings) card.createEl("p", { text: warning, cls: "workflow-ai-warning" });

    if (plan.operations.length === 0) {
      card.createEl("p", { text: "No file changes were proposed." });
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

  private appendMessage(role: "user" | "assistant", text: string, error = false): void {
    if (!this.messageList) return;
    const message = this.messageList.createDiv({ cls: `workflow-ai-message is-${role}${error ? " is-error" : ""}` });
    message.createDiv({ text: role === "user" ? "You" : "Workflow AI", cls: "workflow-ai-message-role" });
    message.createDiv({ text, cls: "workflow-ai-message-text" });
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  private setBusy(busy: boolean, label?: string): void {
    this.sendButton.disabled = busy;
    this.promptInput.disabled = busy;
    this.sendButton.setText(busy ? "Working…" : "Send");
    if (busy && label) this.appendMessage("assistant", label);
  }
}
