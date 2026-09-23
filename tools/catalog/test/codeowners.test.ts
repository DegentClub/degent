import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODEOWNERS_FILE, renderCodeowners, runCodeowners } from "../src/codeowners.js";
import { loadWorkspace } from "../src/workspace.js";
import { fixture, workspace } from "./helpers.js";

describe("codeowners", () => {
  it("maps component paths and provided contracts to owner teams, fallbacks first", () => {
    const text = renderCodeowners(workspace("valid"), "acme");
    const rules = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    expect(rules[0]).toEqual(["*", "@acme/team-platform"]);
    expect(rules).toContainEqual(["/contracts/openapi/api.yaml", "@acme/team-degent"]);
    expect(rules).toContainEqual(["/products/degent/services/api/", "@acme/team-degent"]);
    expect(rules).toContainEqual(["/products/scribbit/apps/console/", "@acme/team-scribbit"]);
    expect(rules.at(-1)).toEqual(["/products/scribbit/apps/console/", "@acme/team-scribbit"]);
  });

  it("writes the file and --check detects drift", () => {
    const root = fixture("valid");
    expect(runCodeowners(loadWorkspace(root), { check: true }).diagnostics[0]?.rule).toBe("codeowners-stale");
    runCodeowners(loadWorkspace(root));
    expect(readFileSync(path.join(root, CODEOWNERS_FILE), "utf8")).toContain("/platform/core/");
    expect(runCodeowners(loadWorkspace(root), { check: true }).diagnostics).toEqual([]);
  });
});
