import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatHuman, parseArgs } from "../src/cli.js";
import { fixture } from "./helpers.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(pkgDir, "node_modules/.bin/tsx");
const cli = (args: string[]) => spawnSync(tsx, [path.join(pkgDir, "src/cli.ts"), ...args], { encoding: "utf8" });

describe("cli", () => {
  it("parses arguments", () => {
    expect(parseArgs(["validate", "--json", "--root", "/x"])).toEqual({ command: "validate", json: true, check: false, root: "/x" });
    expect(parseArgs(["catalog", "--", "--check"])).toMatchObject({ command: "catalog", check: true });
    expect(parseArgs(["nope"])).toContain("unknown command");
    expect(parseArgs(["validate", "--bogus"])).toContain("unknown option");
  });

  it("formats human output as severity[rule] file:line: message", () => {
    const out = formatHuman({ command: "boundaries", stats: { files: 1 }, diagnostics: [{ severity: "error", rule: "relative-escape", file: "a.ts", line: 3, message: "m" }] });
    expect(out).toBe("error[relative-escape] a.ts:3: m\nboundaries: FAILED - 1 error(s), 0 warning(s) [1 files]");
  });

  it("exits 0 with --json on a clean repo", () => {
    const r = cli(["validate", "--json", "--root", fixture("valid")]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ command: "validate", ok: true, counts: { errors: 0, warnings: 0 }, diagnostics: [] });
  });

  it("exits 1 with machine-readable diagnostics on findings", () => {
    const r = cli(["boundaries", "--json", "--root", fixture("cross-product-import")]);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; diagnostics: { rule: string }[] };
    expect(out.ok).toBe(false);
    expect(out.diagnostics.map((d) => d.rule)).toContain("cross-product-import");
  });

  it("exits 2 on usage errors", () => {
    expect(cli(["frobnicate"]).status).toBe(2);
  });
}, 30_000);
