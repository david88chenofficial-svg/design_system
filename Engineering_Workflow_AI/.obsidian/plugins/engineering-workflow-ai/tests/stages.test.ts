import { describe, expect, it } from "vitest";
import {
  deriveStageDependencies,
  findDependencyCycleBlockers,
  isExecutableStageEntry,
  topologicallyOrderStages
} from "../src/stage-graph";
import type { ExecutableStage, ProjectIndexEntry } from "../src/types";

function entry(id: string, path: string, headings: string[]): ProjectIndexEntry {
  return {
    id,
    path,
    headings,
    extension: "md",
    type: "stage",
    status: "draft",
    outbound: []
  };
}

function stage(id: string, path: string, dependencies: string[]): ExecutableStage {
  return {
    id,
    title: id,
    path,
    contract: "contract",
    contractHash: id.repeat(64).slice(0, 64),
    dependencies,
    status: "missing-code",
    codeLinked: false
  };
}

describe("executable workflow stages", () => {
  it("requires the complete input/model/output/acceptance contract", () => {
    expect(isExecutableStageEntry(entry("STG-AERO", "models/aero.md", [
      "Aerodynamic model",
      "Physical/theoretical model",
      "Purpose",
      "Assumptions and applicability",
      "Governing equations",
      "Inputs",
      "Numerical method",
      "Runtime interface",
      "Model or method",
      "Outputs",
      "Acceptance and verification"
    ]))).toBe(true);
    expect(isExecutableStageEntry(entry("STG-INCOMPLETE", "models/incomplete.md", [
      "Inputs",
      "Model or method",
      "Outputs"
    ]))).toBe(false);
  });

  it("derives output-to-input dependencies from Canvas interface cards", () => {
    const aero = entry("STG-AERO", "models/aero.md", []);
    const structural = entry("STG-STRUCT", "models/structural.md", []);
    const primaryCanvasContent = JSON.stringify({
      nodes: [
        { id: "aero-out", type: "text", text: "[[models/aero#Outputs|Aerodynamic outputs]]" },
        { id: "struct-in", type: "text", text: "[[models/structural#Inputs|Structural inputs]]" }
      ],
      edges: [{ id: "handoff", fromNode: "aero-out", toNode: "struct-in" }]
    });

    const dependencies = deriveStageDependencies({ primaryCanvasContent }, [aero, structural]);

    expect(dependencies.get("STG-AERO")).toEqual([]);
    expect(dependencies.get("STG-STRUCT")).toEqual(["STG-AERO"]);
  });

  it("orders upstream stages before their downstream consumers", () => {
    const structural = stage("STG-STRUCT", "models/structural.md", ["STG-AERO"]);
    const report = stage("STG-REPORT", "models/report.md", ["STG-STRUCT"]);
    const aero = stage("STG-AERO", "models/aero.md", []);

    expect(topologicallyOrderStages([report, structural, aero]).map((item) => item.id))
      .toEqual(["STG-AERO", "STG-STRUCT", "STG-REPORT"]);
  });

  it("detects a dependency cycle instead of silently choosing an execution order", () => {
    const aero = stage("STG-AERO", "models/aero.md", ["STG-STRUCT"]);
    const structural = stage("STG-STRUCT", "models/structural.md", ["STG-AERO"]);

    expect(findDependencyCycleBlockers([aero, structural])).toEqual(["STG-AERO", "STG-STRUCT"]);
  });
});
