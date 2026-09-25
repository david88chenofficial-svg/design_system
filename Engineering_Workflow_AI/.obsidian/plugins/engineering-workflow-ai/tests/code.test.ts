import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCodeSymbols, resolveCodeRoots, scanCodeChanges } from "../src/code";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-ai-code-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("code traceability", () => {
  it("associates a workflow marker with the following Python symbol", () => {
    const symbols = parseCodeSymbols("seal_models.py", [
      "# workflow: SEAL-ANA-01, SEAL-DEC-01",
      "def calculate_leakage(pressure):",
      "    return pressure * 2",
      "",
      "def helper(value):",
      "    return value"
    ].join("\n"));

    expect(symbols).toHaveLength(2);
    expect(symbols[0].name).toBe("calculate_leakage");
    expect(symbols[0].workflowIds).toEqual(["SEAL-ANA-01", "SEAL-DEC-01"]);
    expect(symbols[0].lineStart).toBe(2);
    expect(symbols[0].lineEnd).toBe(4);
  });

  it("detects symbol changes relative to a saved baseline", async () => {
    const root = await temporaryDirectory();
    const codePath = path.join(root, "model.py");
    await fs.writeFile(codePath, [
      "# workflow: ANA-01",
      "def model(x):",
      "    return x + 1"
    ].join("\n"));

    const first = await scanCodeChanges([root]);
    expect(first.filesScanned).toBe(1);
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]).toMatchObject({ status: "added", symbol: "(file-level)", workflowIds: ["ANA-01"] });
    expect(first.changes[0].excerpt).toContain("function model");

    await fs.writeFile(codePath, [
      "# workflow: ANA-01",
      "def model(x):",
      "    return x + 2"
    ].join("\n"));
    const second = await scanCodeChanges([root], first.snapshot);
    expect(second.changes).toHaveLength(1);
    expect(second.changes[0]).toMatchObject({ status: "modified", symbol: "model" });
    expect(second.changes[0].localUrl).toContain("vscode://file/");

    const unchanged = await scanCodeChanges([root], second.snapshot);
    expect(unchanged.changes).toEqual([]);
  });

  it("auto-detects project code folders and ignores dependency folders", async () => {
    const vault = await temporaryDirectory();
    const projectCode = path.join(vault, "Projects", "Example", "code");
    const dependency = path.join(projectCode, "node_modules", "package");
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(path.join(projectCode, "solver.ts"), "export function solve() { return 1; }");
    await fs.writeFile(path.join(dependency, "ignored.js"), "function ignored() { return 1; }");

    const roots = await resolveCodeRoots(vault, "Projects/Example", []);
    const report = await scanCodeChanges(roots);
    expect(roots).toEqual([await fs.realpath(projectCode)]);
    expect(report.filesScanned).toBe(1);
    expect(report.changes[0].path).toBe("solver.ts");
    expect(report.changes[0].symbol).toBe("(file-level)");
  });
});
