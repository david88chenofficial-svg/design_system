import { requestUrl } from "obsidian";
import {
  CHANGE_PLAN_SCHEMA,
  CODE_IMPACT_POLICY,
  CONTEXT_ROUTE_SCHEMA,
  CONTEXT_ROUTER_POLICY,
  ENGINEERING_WORKFLOW_POLICY,
  modeInstruction
} from "./prompts";
import { validateChangePlan } from "./safety";
import type {
  ChatMessage,
  CodeScanReport,
  ContextRoute,
  PluginSettings,
  ProjectIndex,
  VaultChangePlan,
  VaultContext,
  WorkflowMode
} from "./types";

interface ResponsesPayload {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  error?: { message?: string };
  status?: string;
}

export async function requestContextRoute(
  apiKey: string,
  settings: PluginSettings,
  mode: WorkflowMode,
  userRequest: string,
  index: ProjectIndex,
  history: ChatMessage[]
): Promise<ContextRoute> {
  const recentHistory = history
    .slice(-4)
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");
  const input = [
    `Workflow mode: ${mode}`,
    recentHistory ? `RECENT CHAT\n${recentHistory}` : "",
    `CURRENT USER REQUEST\n${userRequest}`,
    `SELECTED PROJECT\n${index.projectPath}`,
    `PROJECT MAP\n${index.serialized}`
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  const response = await requestUrl({
    url: "https://api.openai.com/v1/responses",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      store: false,
      instructions: CONTEXT_ROUTER_POLICY,
      input,
      max_output_tokens: 1_500,
      text: {
        format: {
          type: "json_schema",
          name: "engineering_context_route",
          strict: true,
          schema: CONTEXT_ROUTE_SCHEMA
        }
      }
    }),
    throw: false
  });

  const payload = response.json as ResponsesPayload;
  if (response.status >= 400) {
    throw new Error(payload.error?.message ?? `OpenAI routing request failed with status ${response.status}.`);
  }
  let route: ContextRoute;
  try {
    route = JSON.parse(extractResponseText(payload)) as ContextRoute;
  } catch {
    throw new Error("The model returned a response that could not be parsed as a context route.");
  }
  if (!route || typeof route.focus !== "string" || typeof route.rationale !== "string"
    || !Array.isArray(route.selected_paths) || typeof route.needs_broader_context !== "boolean") {
    throw new Error("The model returned an invalid context route.");
  }
  return route;
}

export async function requestChangePlan(
  apiKey: string,
  settings: PluginSettings,
  mode: WorkflowMode,
  userRequest: string,
  context: VaultContext,
  history: ChatMessage[]
): Promise<VaultChangePlan> {
  const recentHistory = history
    .slice(-6)
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");
  const input = [
    modeInstruction(mode),
    recentHistory ? `RECENT CHAT\n${recentHistory}` : "",
    `CURRENT USER REQUEST\n${userRequest}`,
    `SELECTED PROJECT\n${context.projectPath}\nAll file-operation paths and Canvas file-node paths must be relative to this project root.`,
    `GRAPH-GUIDED PROJECT CONTEXT\n${context.serialized}`
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  const response = await requestUrl({
    url: "https://api.openai.com/v1/responses",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      store: false,
      instructions: ENGINEERING_WORKFLOW_POLICY,
      input,
      max_output_tokens: 12_000,
      text: {
        format: {
          type: "json_schema",
          name: "engineering_vault_change_plan",
          strict: true,
          schema: CHANGE_PLAN_SCHEMA
        }
      }
    }),
    throw: false
  });

  const payload = response.json as ResponsesPayload;
  if (response.status >= 400) {
    throw new Error(payload.error?.message ?? `OpenAI request failed with status ${response.status}.`);
  }
  const outputText = extractResponseText(payload);
  let plan: VaultChangePlan;
  try {
    plan = JSON.parse(outputText) as VaultChangePlan;
  } catch {
    throw new Error("The model returned a response that could not be parsed as a change plan.");
  }
  validateChangePlan(plan);
  return plan;
}

export async function requestCodeImpactPlan(
  apiKey: string,
  settings: PluginSettings,
  context: VaultContext,
  codeReport: CodeScanReport
): Promise<VaultChangePlan> {
  const input = [
    "Mode: code impact review. Propose the smallest workflow update needed to preserve implementation traceability.",
    `SELECTED PROJECT\n${context.projectPath}\nAll file-operation paths must be relative to this project root.`,
    `FOCUSED WORKFLOW CONTEXT\n${context.serialized}`,
    codeReport.serialized
  ].join("\n\n---\n\n");

  const response = await requestUrl({
    url: "https://api.openai.com/v1/responses",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      store: false,
      instructions: `${ENGINEERING_WORKFLOW_POLICY}\n\n${CODE_IMPACT_POLICY}`,
      input,
      max_output_tokens: 12_000,
      text: {
        format: {
          type: "json_schema",
          name: "engineering_code_impact_plan",
          strict: true,
          schema: CHANGE_PLAN_SCHEMA
        }
      }
    }),
    throw: false
  });

  const payload = response.json as ResponsesPayload;
  if (response.status >= 400) {
    throw new Error(payload.error?.message ?? `OpenAI code-review request failed with status ${response.status}.`);
  }
  let plan: VaultChangePlan;
  try {
    plan = JSON.parse(extractResponseText(payload)) as VaultChangePlan;
  } catch {
    throw new Error("The model returned a response that could not be parsed as a code-impact plan.");
  }
  validateChangePlan(plan);
  return plan;
}

export function extractResponseText(payload: ResponsesPayload): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "refusal" && content.refusal) {
        throw new Error(`The model refused the request: ${content.refusal}`);
      }
      if (content.type === "output_text" && content.text) {
        return content.text;
      }
    }
  }
  throw new Error("The OpenAI response did not contain output text.");
}
