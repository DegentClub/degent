import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "../src/types.js";
import { loadWorkspace, type Workspace } from "../src/workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, "fixtures");
export const REPO_ROOT = path.resolve(here, "../../..");

/** Copy a fixture mini-repo to a temp dir (tests may write into it) with the real manifest schema. */
export function fixture(name: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `catalog-${name}-`));
  cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  mkdirSync(path.join(dir, "schemas"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "schemas/component.schema.json"), path.join(dir, "schemas/component.schema.json"));
  return dir;
}

export function workspace(name: string): Workspace {
  return loadWorkspace(fixture(name));
}

export const rules = (ds: Diagnostic[]): string[] => [...new Set(ds.map((d) => d.rule))].sort();
export const errorsOf = (ds: Diagnostic[], rule: string): Diagnostic[] => ds.filter((d) => d.rule === rule);
