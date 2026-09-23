import { describe, expect, it } from "vitest";
import { declaredWorkspaceDeps, expandWorkspaceGlobs, findRepoRoot, matchGlob } from "../src/workspace.js";
import { fixture, REPO_ROOT } from "./helpers.js";
import path from "node:path";

describe("workspace discovery", () => {
  it("expands pnpm globs to directories with a package.json, sorted", () => {
    const root = fixture("valid");
    expect(
      expandWorkspaceGlobs(root, ["platform/*", "products/*/apps/*", "products/*/services/*", "products/*/packages/*", "tools/*"]),
    ).toEqual(["platform/core", "products/degent/packages/sdk", "products/degent/services/api", "products/scribbit/apps/console"]);
  });

  it("supports ** and ! exclusions", () => {
    const root = fixture("valid");
    expect(expandWorkspaceGlobs(root, ["products/**", "!products/scribbit/**"])).toEqual([
      "products/degent/packages/sdk",
      "products/degent/services/api",
    ]);
  });

  it("matches globs segment-wise", () => {
    expect(matchGlob("products/*/apps/*", "products/degent/apps/web")).toBe(true);
    expect(matchGlob("products/*/apps/*", "products/degent/apps/web/src")).toBe(false);
    expect(matchGlob("tools/**", "tools/a/b")).toBe(true);
    expect(matchGlob("templates/*", "platform/x")).toBe(false);
  });

  it("finds the repo root by walking up", () => {
    expect(findRepoRoot(path.join(REPO_ROOT, "tools/catalog/src"))).toBe(REPO_ROOT);
  });

  it("collects @bsh deps from every dependency field", () => {
    expect(
      declaredWorkspaceDeps({ dependencies: { "@bsh/a": "workspace:*", react: "19" }, devDependencies: { "@bsh/b": "workspace:*" }, peerDependencies: { "@bsh/a": "*" } }),
    ).toEqual(["@bsh/a", "@bsh/b"]);
  });

  it("does not pick up templates/ in the real repo", () => {
    const dirs = expandWorkspaceGlobs(REPO_ROOT, ["platform/*", "products/*/apps/*", "products/*/services/*", "products/*/packages/*", "tools/*"]);
    expect(dirs.some((d) => d.startsWith("templates/"))).toBe(false);
    expect(dirs.some((d) => d.includes("fixtures"))).toBe(false);
  });
});
