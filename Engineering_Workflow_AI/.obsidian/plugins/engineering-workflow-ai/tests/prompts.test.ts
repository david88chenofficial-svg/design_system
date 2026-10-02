import { describe, expect, it } from "vitest";
import {
  ENGINEERING_CODE_POLICY,
  ENGINEERING_RESULT_POLICY,
  ENGINEERING_WORKFLOW_POLICY,
  MAIN_WORKFLOW_CANVAS_POLICY,
  MODEL_STAGE_CONTRACT_POLICY,
  STAGE_CODER_POLICY,
  STAGE_VERIFIER_JUDGE_POLICY,
  STAGE_VERIFIER_PREPARE_POLICY,
  modeInstruction
} from "../src/prompts";

describe("model-stage planning policy", () => {
  it("keeps a small horizontal main workflow visually distinct from supporting records", () => {
    expect(ENGINEERING_WORKFLOW_POLICY).toContain(MAIN_WORKFLOW_CANVAS_POLICY);
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("Target about three backbone boxes");
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("use two to four by default");
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("same y coordinate");
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("at least 500 Canvas pixels");
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("requirements register");
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("qualification");
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("Every visible content box on the primary Canvas must be backed by a real Markdown file");
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain('type: "file"');
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("Do not use Canvas text nodes");
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("code-input file node directly above");
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("code-output file node directly below");
    expect(MAIN_WORKFLOW_CANVAS_POLICY).toContain("do not duplicate it with a long diagonal output-to-input edge");
  });

  it("creates physical stage briefs with linked code-interface contracts", () => {
    expect(ENGINEERING_WORKFLOW_POLICY).toContain(MODEL_STAGE_CONTRACT_POLICY);
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("macro planner, not the detailed implementation planner");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("unique stable ID, type: stage, and status: proposed");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("id: STG-<UNIQUE-NAME>");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("Physical/theoretical model");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("Code implementation contract");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("### Numerical method\n### Inputs\n### Outputs\n### Acceptance and verification");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("exactly one dedicated code-input contract note");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("one dedicated code-output contract note");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("type: interface");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("direction: input or output");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("compact file node above the stage");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("compact file node below the stage");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("compact table with field, symbol, type/shape, units");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("Distinguish missing runtime values from missing model definitions");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("Acceptance and verification");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("connect the two main model boxes directly in the horizontal backbone");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("do not turn the interface into another main box");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("normally need no more than three implementation steps");
  });

  it("keeps stage contracts actionable for code planning and result synchronization", () => {
    expect(ENGINEERING_CODE_POLICY).toContain("treat its Inputs, Model or method, Outputs, and Acceptance and verification sections as the implementation boundary");
    expect(ENGINEERING_RESULT_POLICY).toContain("which declared inputs and upstream artifacts were actually consumed");
    expect(ENGINEERING_RESULT_POLICY).toContain("Do not mark a stage verified merely because execution succeeded");
    expect(modeInstruction("build")).toContain("linked code-input contract");
    expect(modeInstruction("build")).toContain("linked code-output contract");
    expect(modeInstruction("build")).toContain("about three high-level boxes");
    expect(ENGINEERING_WORKFLOW_POLICY).toContain("PROJECT-RELATIVE ASSET PATH");
    expect(ENGINEERING_WORKFLOW_POLICY).toContain("Link every supplied image from at least one relevant Markdown note");
    expect(ENGINEERING_WORKFLOW_POLICY).toContain("![[PROJECT-RELATIVE ASSET PATH]]");
  });

  it("separates Coder implementation from Verifier-owned execution and judgment", () => {
    expect(STAGE_CODER_POLICY).toContain("Do not run code");
    expect(STAGE_CODER_POLICY).toContain("--input <json-path> and --output <json-path>");
    expect(STAGE_VERIFIER_PREPARE_POLICY).toContain("The Coder has produced code but has not run it");
    expect(STAGE_VERIFIER_PREPARE_POLICY).toContain("You control which example inputs will be executed");
    expect(STAGE_VERIFIER_JUDGE_POLICY).toContain("Do not infer a pass from successful execution alone");
  });
});
