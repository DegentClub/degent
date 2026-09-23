import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkBoundaries, extractImports } from "../src/boundaries.js";
import { loadWorkspace } from "../src/workspace.js";
import { errorsOf, fixture, rules, workspace } from "./helpers.js";

describe("extractImports", () => {
  it("finds static, type, dynamic, re-export, require and import-type forms but not comments or strings", () => {
    const src = [
      'import a from "a";',
      'import type { B } from "b";',
      'export * from "c";',
      'export { d } from "d";',
      'const e = await import("e");',
      'const f = require("f");',
      'import g = require("g");',
      'type H = import("h").H;',
      '// import "comment"',
      'const s = "import \\"string\\"";',
      'import "side-effect";',
    ].join("\n");
    expect(extractImports(src).map((r) => `${r.line}:${r.kind}:${r.specifier}`)).toEqual([
      "1:import:a",
      "2:import:b",
      "3:re-export:c",
      "4:re-export:d",
      "5:dynamic:e",
      "6:require:f",
      "7:require:g",
      "8:type-import:h",
      "11:import:side-effect",
    ]);
  });

  it("parses JSX text containing quotes", () => {
    const refs = extractImports('import x from "x";\nexport const C = () => <p>Don\'t "import" me</p>;\n', "c.tsx");
    expect(refs.map((r) => r.specifier)).toEqual(["x"]);
  });
});

describe("boundaries", () => {
  it("passes a valid repo (subpath imports, self-imports, in-package relative imports)", () => {
    const res = checkBoundaries(workspace("valid"));
    expect(res.diagnostics).toEqual([]);
    expect(res.stats.files).toBe(7);
  });

  it("ignores build output and node_modules", () => {
    const root = fixture("valid");
    for (const d of ["dist", "node_modules/x"]) {
      mkdirSync(path.join(root, "platform/core", d), { recursive: true });
      writeFileSync(path.join(root, "platform/core", d, "index.js"), 'import "@bsh/degent-sdk";\n');
    }
    expect(checkBoundaries(loadWorkspace(root)).diagnostics).toEqual([]);
  });

  it("skips nested package / workspace roots such as test fixtures", () => {
    const root = fixture("valid");
    const nested = path.join(root, "platform/core/test/fixtures/mini");
    mkdirSync(path.join(nested, "pkg/src"), { recursive: true });
    writeFileSync(path.join(nested, "pnpm-workspace.yaml"), "packages: [pkg]\n");
    writeFileSync(path.join(nested, "pkg/package.json"), "{}\n");
    writeFileSync(path.join(nested, "pkg/src/index.ts"), 'import "@bsh/degent-sdk";\n');
    writeFileSync(path.join(nested, "stray.ts"), 'import "@bsh/degent-sdk";\n');
    expect(checkBoundaries(loadWorkspace(root)).diagnostics).toEqual([]);
  });

  it("rejects @bsh imports missing from depends_on, in every form, with file:line", () => {
    const res = checkBoundaries(workspace("undeclared-import"));
    expect(rules(res.diagnostics)).toEqual(["undeclared-import", "unknown-workspace-import"]);
    expect(errorsOf(res.diagnostics, "undeclared-import").map((d) => `${d.file}:${d.line}`)).toEqual([
      "products/degent/services/api/src/main.ts:1",
      "products/degent/services/api/src/main.ts:2",
      "products/degent/services/api/src/main.ts:3",
      "products/degent/services/api/src/main.ts:4",
      "products/degent/services/api/src/main.ts:5",
    ]);
    expect(errorsOf(res.diagnostics, "unknown-workspace-import")[0]).toMatchObject({ line: 6, message: expect.stringContaining("@bsh/ghost") });
  });

  it("rejects cross-product imports even when declared", () => {
    const res = checkBoundaries(workspace("cross-product-import"));
    expect(rules(res.diagnostics)).toEqual(["cross-product-import", "depends-on-cross-product"]);
    expect(errorsOf(res.diagnostics, "cross-product-import")[0]).toMatchObject({
      file: "products/scribbit/apps/console/src/index.ts",
      line: 1,
      component: "scribbit-console",
    });
  });

  it("rejects platform importing a product", () => {
    const res = checkBoundaries(workspace("platform-imports-product"));
    expect(rules(res.diagnostics)).toEqual(["platform-imports-product"]);
    expect(res.diagnostics[0]).toMatchObject({ file: "platform/core/src/index.ts", line: 1 });
  });

  it("rejects relative imports that escape the package root", () => {
    const res = checkBoundaries(workspace("relative-escape"));
    expect(rules(res.diagnostics)).toEqual(["relative-escape"]);
    expect(res.diagnostics.map((d) => d.line)).toEqual([1, 2]);
    expect(res.diagnostics[0]!.message).toContain("into @bsh/core");
  });
});
