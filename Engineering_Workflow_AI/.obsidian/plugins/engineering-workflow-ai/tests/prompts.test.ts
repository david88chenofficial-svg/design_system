import { describe, expect, it } from "vitest";
import {
  ENGINEERING_CODE_POLICY,
  ENGINEERING_RESULT_POLICY,
  ENGINEERING_WORKFLOW_POLICY,
  MODEL_STAGE_CONTRACT_POLICY,
  modeInstruction
} from "../src/prompts";

describe("model-stage planning policy", () => {
  it("requires explicit interface cards and verification-ready stage contracts", () => {
    expect(ENGINEERING_WORKFLOW_POLICY).toContain(MODEL_STAGE_CONTRACT_POLICY);
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("inputs → stage → outputs");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("one consolidated input card above the stage");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("one consolidated output card below it");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("[[Stage Note#Inputs|Stage inputs]]");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("Acceptance and verification");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("connect the upstream output card to the downstream input card");
    expect(MODEL_STAGE_CONTRACT_POLICY).toContain("Do not create one Canvas node or Markdown note per scalar parameter");
  });

  it("keeps stage contracts actionable for code planning and result synchronization", () => {
    expect(ENGINEERING_CODE_POLICY).toContain("treat its Inputs, Model or method, Outputs, and Acceptance and verification sections as the implementation boundary");
    expect(ENGINEERING_RESULT_POLICY).toContain("which declared inputs and upstream artifacts were actually consumed");
    expect(ENGINEERING_RESULT_POLICY).toContain("Do not mark a stage verified merely because execution succeeded");
    expect(modeInstruction("build")).toContain("input/output Canvas cards");
  });
});
