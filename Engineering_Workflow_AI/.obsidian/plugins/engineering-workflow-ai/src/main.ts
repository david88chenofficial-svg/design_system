import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  addIcon
} from "obsidian";
import iconSvg from "../assets/icon.svg";
import { VIEW_TYPE_WORKFLOW_AI, WorkflowAIView } from "./view";
import type { PluginSettings } from "./types";

const API_KEY_SECRET_ID = "engineering-workflow-ai-openai-api-key";

const DEFAULT_SETTINGS: PluginSettings = {
  model: "gpt-5.6-terra",
  maxFiles: 12,
  maxContextChars: 40_000,
  contextStrategyVersion: 1,
  openOnStartup: true,
  activeProjectPath: ""
};

export default class EngineeringWorkflowAIPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    addIcon("engineering-workflow-ai", svgBody(iconSvg));
    this.registerView(
      VIEW_TYPE_WORKFLOW_AI,
      (leaf: WorkspaceLeaf) => new WorkflowAIView(leaf, this)
    );
    this.addRibbonIcon("engineering-workflow-ai", "Open Engineering Workflow AI", () => {
      void this.activateView();
    });
    this.addCommand({
      id: "open-engineering-workflow-ai",
      name: "Open chat panel",
      callback: () => void this.activateView()
    });
    this.addSettingTab(new EngineeringWorkflowAISettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openOnStartup) void this.activateView();
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_WORKFLOW_AI);
  }

  async activateView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKFLOW_AI)[0];
    if (existingLeaf) {
      await this.app.workspace.revealLeaf(existingLeaf);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) throw new Error("Obsidian could not create a right sidebar leaf.");
    await leaf.setViewState({ type: VIEW_TYPE_WORKFLOW_AI, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  getApiKey(): string | null {
    return this.app.secretStorage.getSecret(API_KEY_SECRET_ID);
  }

  setApiKey(value: string): void {
    this.app.secretStorage.setSecret(API_KEY_SECRET_ID, value);
  }

  clearApiKey(): void {
    this.app.secretStorage.setSecret(API_KEY_SECRET_ID, "");
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData() as Partial<PluginSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
    if (loaded?.contextStrategyVersion !== DEFAULT_SETTINGS.contextStrategyVersion) {
      this.settings.maxFiles = DEFAULT_SETTINGS.maxFiles;
      this.settings.maxContextChars = DEFAULT_SETTINGS.maxContextChars;
      this.settings.contextStrategyVersion = DEFAULT_SETTINGS.contextStrategyVersion;
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class EngineeringWorkflowAISettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: EngineeringWorkflowAIPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Engineering Workflow AI" });
    new Setting(this.containerEl)
      .setName("Open chat on startup")
      .setDesc("Open the Engineering Workflow AI view in the right sidebar when this vault loads.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.openOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.openOnStartup = value;
          await this.plugin.saveSettings();
        }));
    new Setting(this.containerEl)
      .setName("OpenAI model")
      .setDesc("Model ID used for Responses API requests.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.model)
        .setValue(this.plugin.settings.model)
        .onChange(async (value) => {
          this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
          await this.plugin.saveSettings();
        }));
    new Setting(this.containerEl)
      .setName("Maximum focused files")
      .setDesc("Maximum Markdown and Canvas files followed from the graph-guided branch into the planning request.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.maxFiles))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 40) {
            this.plugin.settings.maxFiles = parsed;
            await this.plugin.saveSettings();
          }
        }));
    new Setting(this.containerEl)
      .setName("Maximum focused characters")
      .setDesc("Maximum total characters read from the selected branch. The compact routing map has its own smaller limit.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.maxContextChars))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 200_000) {
            this.plugin.settings.maxContextChars = parsed;
            await this.plugin.saveSettings();
          }
        }));
  }
}

function svgBody(svg: string): string {
  return svg.replace(/^<svg[^>]*>/i, "").replace(/<\/svg>\s*$/i, "");
}
