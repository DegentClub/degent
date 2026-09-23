import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog, CATALOG_JSON, CATALOG_MD, runCatalog, type Catalog } from "../src/catalog.js";
import { loadWorkspace } from "../src/workspace.js";
import { fixture, rules, workspace } from "./helpers.js";

const NOW = "2026-09-23T00:00:00.000Z";

describe("catalog", () => {
  it("indexes components, products, contracts and edges deterministically", () => {
    const c = buildCatalog(workspace("valid"), NOW);
    expect(c.generatedAt).toBe(NOW);
    expect(c.components.map((x) => x.name)).toEqual(["core", "degent-api", "degent-sdk", "scribbit-console"]);
    const api = c.components.find((x) => x.name === "degent-api")!;
    expect(api).toMatchObject({
      package: "@bsh/degent-api",
      path: "products/degent/services/api",
      version: "1.2.3",
      scripts: { test: "vitest run", typecheck: "tsc --noEmit -p ." },
      files: { env_schema: "products/degent/services/api/env.schema.json", runbook: "products/degent/services/api/RUNBOOK.md", docs: "products/degent/services/api/README.md" },
      dependents: [],
    });
    expect(Object.keys(api).slice(0, 7)).toEqual(["name", "package", "kind", "product", "owner", "summary", "lifecycle"]);
    expect(c.components.find((x) => x.name === "core")!.dependents).toEqual(["degent-api", "degent-sdk", "scribbit-console"]);
    expect(Object.keys(c.products)).toEqual(["blockspace", "degent", "platform", "scribbit", "tooling"]);
    expect(c.products.degent).toEqual({ path: "products/degent", components: ["degent-api", "degent-sdk"], owners: ["team-degent"], kinds: { library: 1, service: 1 } });
    expect(c.products.blockspace!.components).toEqual([]);
    expect(c.contracts).toEqual([
      { path: "contracts/openapi/api.yaml", kind: "openapi", exists: true, providers: ["degent-api", "degent-sdk"], consumers: ["scribbit-console"] },
      { path: "contracts/schemas/unused.json", kind: "json-schema", exists: true, providers: [], consumers: [] },
      { path: "events:block.indexed.{network}", kind: "event", exists: true, providers: [], consumers: ["degent-api"] },
    ]);
    expect(c.edges).toContainEqual({ from: "degent-api", to: "core", type: "depends_on" });
    expect(c.edges).toContainEqual({ from: "scribbit-console", to: "contracts/openapi/api.yaml", type: "consumes" });
    expect(JSON.stringify(buildCatalog(workspace("valid"), NOW))).toBe(JSON.stringify(c));
  });

  it("writes json + markdown, then --check passes and regenerating keeps generatedAt", () => {
    const root = fixture("valid");
    runCatalog(loadWorkspace(root), { now: NOW });
    const json = JSON.parse(readFileSync(path.join(root, CATALOG_JSON), "utf8")) as Catalog;
    expect(json.generatedAt).toBe(NOW);
    expect(readFileSync(path.join(root, CATALOG_MD), "utf8")).toContain("| degent-api | `@bsh/degent-api` | service |");
    expect(runCatalog(loadWorkspace(root), { check: true, now: "2030-01-01T00:00:00.000Z" }).diagnostics).toEqual([]);
    runCatalog(loadWorkspace(root), { now: "2030-01-01T00:00:00.000Z" });
    expect((JSON.parse(readFileSync(path.join(root, CATALOG_JSON), "utf8")) as Catalog).generatedAt).toBe(NOW);
  });

  it("--check fails when a manifest changes after generation", () => {
    const root = fixture("valid");
    runCatalog(loadWorkspace(root), { now: NOW });
    const m = path.join(root, "platform/core/component.yaml");
    writeFileSync(m, readFileSync(m, "utf8").replace("lifecycle: beta", "lifecycle: production"));
    const res = runCatalog(loadWorkspace(root), { check: true });
    expect(res.diagnostics.map((d) => `${d.rule}:${d.file}`)).toEqual(["catalog-stale:catalog/catalog.json", "catalog-stale:catalog/CATALOG.md"]);
  });

  it("--check fails on a stale committed catalog and does not write", () => {
    const root = fixture("stale-catalog");
    const before = readFileSync(path.join(root, CATALOG_JSON), "utf8");
    const res = runCatalog(loadWorkspace(root), { check: true });
    expect(rules(res.diagnostics)).toEqual(["catalog-stale"]);
    expect(readFileSync(path.join(root, CATALOG_JSON), "utf8")).toBe(before);
  });

  it("--check fails when the catalog is missing", () => {
    const res = runCatalog(workspace("missing-manifest"), { check: true });
    expect(res.diagnostics[0]!.message).toContain("does not exist");
  });
});
