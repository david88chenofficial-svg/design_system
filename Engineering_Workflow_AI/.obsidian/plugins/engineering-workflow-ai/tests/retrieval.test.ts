import { describe, expect, it } from "vitest";
import { createFallbackRoute, selectContextPaths } from "../src/retrieval";
import type { ContextRoute, ProjectIndex, ProjectIndexEntry } from "../src/types";

function entry(path: string, outbound: string[] = [], headings: string[] = []): ProjectIndexEntry {
  return {
    path,
    extension: path.endsWith(".canvas") ? "canvas" : "md",
    id: "",
    type: "",
    status: "",
    headings,
    outbound
  };
}

function index(entries: ProjectIndexEntry[]): ProjectIndex {
  return {
    projectPath: "Projects/Seal Design System",
    entries,
    primaryCanvasPath: "00 Start Here/Engineering Workflow.canvas",
    primaryCanvasContent: "{}",
    activePath: null,
    serialized: "map",
    truncated: false
  };
}

function route(selected_paths: string[]): ContextRoute {
  return {
    focus: "Baseline qualification",
    rationale: "The request names this branch.",
    selected_paths,
    needs_broader_context: false
  };
}

describe("graph-guided context selection", () => {
  const project = index([
    entry("00 Start Here/Engineering Workflow.canvas", [
      "01 Analysis Tool/Baseline Qualification.md",
      "02 Design Tool/Requirements.md"
    ]),
    entry("00 Start Here/Home.md"),
    entry("01 Analysis Tool/Baseline Qualification.md", ["01 Analysis Tool/Assumptions.md"]),
    entry("01 Analysis Tool/Assumptions.md", ["03 Evidence/Baseline Evidence.md"]),
    entry("03 Evidence/Baseline Evidence.md"),
    entry("02 Design Tool/Requirements.md", ["02 Design Tool/Candidate A.md"]),
    entry("02 Design Tool/Candidate A.md")
  ]);

  it("follows the routed branch without expanding every primary-Canvas branch", () => {
    const selected = selectContextPaths(
      project,
      route(["01 Analysis Tool/Baseline Qualification.md"]),
      "Add another assumption under baseline qualification",
      12
    );
    expect(selected).toContain("00 Start Here/Engineering Workflow.canvas");
    expect(selected).toContain("01 Analysis Tool/Baseline Qualification.md");
    expect(selected).toContain("01 Analysis Tool/Assumptions.md");
    expect(selected).toContain("03 Evidence/Baseline Evidence.md");
    expect(selected).not.toContain("02 Design Tool/Requirements.md");
    expect(selected).not.toContain("02 Design Tool/Candidate A.md");
  });

  it("does not force an unrelated active file into the routed branch", () => {
    const withUnrelatedActive = {
      ...project,
      activePath: "02 Design Tool/Requirements.md"
    };
    const selected = selectContextPaths(
      withUnrelatedActive,
      route(["01 Analysis Tool/Baseline Qualification.md"]),
      "add an assumption under baseline qualification",
      12
    );
    expect(selected).not.toContain("02 Design Tool/Requirements.md");
  });

  it("honours the focused file cap", () => {
    const selected = selectContextPaths(
      project,
      route(["01 Analysis Tool/Baseline Qualification.md"]),
      "baseline",
      3
    );
    expect(selected).toHaveLength(3);
  });

  it("uses local metadata matching when the AI route is unavailable", () => {
    const withHeadings = index([
      entry("00 Start Here/Engineering Workflow.canvas"),
      entry("01 Analysis Tool/Qualification.md", [], ["Baseline model qualification"]),
      entry("02 Design Tool/Geometry.md", [], ["Envelope"])
    ]);
    const fallback = createFallbackRoute(withHeadings, "extend baseline qualification");
    expect(fallback.selected_paths[0]).toBe("01 Analysis Tool/Qualification.md");
  });
});
