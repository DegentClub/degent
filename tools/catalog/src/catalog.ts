/**
 * `catalog`: generate catalog/catalog.json (machine index) and catalog/CATALOG.md (human summary).
 *
 * Output is deterministic: arrays are sorted, object keys have a fixed order, and `generatedAt` is the
 * only volatile field. `--check` compares everything except `generatedAt`. When nothing but the
 * timestamp would change, the existing timestamp is kept so regenerating never produces a diff.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CheckResult, Diagnostic } from "./types.js";
import { contractFile, loadSchema } from "./validate.js";
import { isRecord, stringArray, type Workspace, type WorkspacePackage } from "./workspace.js";

export const CATALOG_JSON = "catalog/catalog.json";
export const CATALOG_MD = "catalog/CATALOG.md";
export const CATALOG_VERSION = 1;

/** Manifest keys in schema order; unknown keys follow alphabetically. */
const MANIFEST_KEY_ORDER = [
  "name",
  "package",
  "kind",
  "product",
  "owner",
  "summary",
  "lifecycle",
  "depends_on",
  "provides",
  "consumes",
  "stores",
  "secrets",
  "env_schema",
  "slo",
  "runbook",
  "docs",
  "commands",
];

export type ContractKind = "openapi" | "asyncapi" | "json-schema" | "event" | "unknown";

export interface CatalogComponent {
  name: string;
  package: string;
  kind: string;
  product: string;
  owner: string;
  [key: string]: unknown;
  path: string;
  version: string | null;
  scripts: Record<string, string>;
  /** Repo-relative paths for env_schema / runbook / docs. */
  files: Record<string, string>;
  /** Names of components whose depends_on lists this one. */
  dependents: string[];
}

export interface CatalogContract {
  path: string;
  kind: ContractKind;
  exists: boolean;
  providers: string[];
  consumers: string[];
}

export interface CatalogEdge {
  from: string;
  to: string;
  type: "depends_on" | "provides" | "consumes";
}

export interface Catalog {
  version: number;
  generatedAt: string;
  schema: string;
  components: CatalogComponent[];
  products: Record<string, { path: string | null; components: string[]; owners: string[]; kinds: Record<string, number> }>;
  contracts: CatalogContract[];
  edges: CatalogEdge[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const uniqSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(byString);

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => byString(a, b)));
}

export function contractKind(ref: string): ContractKind {
  if (ref.startsWith("events:")) return "event";
  const seg = ref.split("/")[1];
  if (seg === "openapi") return "openapi";
  if (seg === "asyncapi") return "asyncapi";
  if (seg === "schemas") return "json-schema";
  return "unknown";
}

function productPath(slug: string): string | null {
  if (slug === "platform") return "platform";
  if (slug === "tooling") return "tools";
  return `products/${slug}`;
}

function listContractFiles(root: string): string[] {
  const out: string[] = [];
  for (const sub of ["openapi", "asyncapi", "schemas"]) {
    const dir = path.join(root, "contracts", sub);
    if (!existsSync(dir)) continue;
    const rec = (abs: string, rel: string): void => {
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory()) rec(path.join(abs, e.name), `${rel}/${e.name}`);
        else if (/\.(ya?ml|json)$/.test(e.name)) out.push(`${rel}/${e.name}`);
      }
    };
    rec(dir, `contracts/${sub}`);
  }
  return out;
}

type Usable = { pkg: WorkspacePackage; m: Record<string, unknown> & { name: string } };

export function buildCatalog(ws: Workspace, generatedAt: string = new Date().toISOString()): Catalog {
  const usable: Usable[] = ws.packages
    .filter((p) => isRecord(p.manifest) && typeof p.manifest.name === "string")
    .map((p) => ({ pkg: p, m: p.manifest as Usable["m"] }))
    .sort((a, b) => byString(a.m.name, b.m.name));

  const nameByPackage = new Map<string, string>();
  for (const { pkg, m } of usable) nameByPackage.set(typeof m.package === "string" ? m.package : pkg.packageJson.name ?? "", m.name);

  const dependents = new Map<string, string[]>();
  const edges: CatalogEdge[] = [];
  const contracts = new Map<string, { providers: Set<string>; consumers: Set<string> }>();
  const touch = (p: string) => {
    let c = contracts.get(p);
    if (!c) contracts.set(p, (c = { providers: new Set(), consumers: new Set() }));
    return c;
  };

  for (const { m } of usable) {
    for (const dep of stringArray(m.depends_on)) {
      const target = nameByPackage.get(dep) ?? dep;
      dependents.set(target, [...(dependents.get(target) ?? []), m.name]);
      edges.push({ from: m.name, to: target, type: "depends_on" });
    }
    for (const ref of stringArray(m.provides)) {
      const p = contractFile(ref);
      touch(p).providers.add(m.name);
      edges.push({ from: m.name, to: p, type: "provides" });
    }
    for (const ref of stringArray(m.consumes)) {
      const p = contractFile(ref);
      touch(p).consumers.add(m.name);
      edges.push({ from: m.name, to: p, type: "consumes" });
    }
  }
  for (const f of listContractFiles(ws.root)) touch(f);

  const components: CatalogComponent[] = usable.map(({ pkg, m }) => {
    const ordered: Record<string, unknown> = {};
    for (const k of MANIFEST_KEY_ORDER) if (k in m) ordered[k] = m[k];
    for (const k of Object.keys(m).sort(byString)) if (!(k in ordered)) ordered[k] = m[k];
    if (isRecord(ordered.commands)) ordered.commands = sortKeys(ordered.commands);
    const files: Record<string, string> = {};
    for (const k of ["env_schema", "runbook", "docs"]) {
      const v = m[k];
      if (typeof v === "string") files[k] = path.posix.normalize(`${pkg.dir}/${v}`);
    }
    return {
      ...(ordered as CatalogComponent),
      path: pkg.dir,
      version: pkg.packageJson.version ?? null,
      scripts: sortKeys(pkg.packageJson.scripts ?? {}),
      files,
      dependents: uniqSorted(dependents.get(m.name) ?? []),
    };
  });

  let slugs: string[] = ["platform", "blockspace", "scribbit", "degent", "tooling"];
  try {
    const schema = loadSchema(ws.root) as { properties?: { product?: { enum?: string[] } } };
    slugs = schema.properties?.product?.enum ?? slugs;
  } catch {
    /* schema missing: validate reports it */
  }
  const products: Catalog["products"] = {};
  for (const slug of uniqSorted([...slugs, ...components.map((c) => String(c.product))])) {
    const cs = components.filter((c) => c.product === slug);
    const kinds: Record<string, number> = {};
    for (const c of cs) kinds[String(c.kind)] = (kinds[String(c.kind)] ?? 0) + 1;
    products[slug] = {
      path: productPath(slug),
      components: cs.map((c) => c.name),
      owners: uniqSorted(cs.map((c) => String(c.owner))),
      kinds: sortKeys(kinds),
    };
  }

  return {
    version: CATALOG_VERSION,
    generatedAt,
    schema: "schemas/component.schema.json",
    components,
    products,
    contracts: [...contracts.entries()]
      .sort(([a], [b]) => byString(a, b))
      .map(([p, c]) => ({
        path: p,
        kind: contractKind(p),
        exists: p.startsWith("events:") ? true : existsSync(path.join(ws.root, p)),
        providers: uniqSorted(c.providers),
        consumers: uniqSorted(c.consumers),
      })),
    edges: edges.sort((a, b) => byString(a.type, b.type) || byString(a.from, b.from) || byString(a.to, b.to)),
  };
}

export function renderJson(c: Catalog): string {
  return `${JSON.stringify(c, null, 2)}\n`;
}

const cell = (s: unknown): string => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(c: Catalog): string {
  const lines: string[] = [
    "# Component catalog",
    "",
    "<!-- GENERATED by `pnpm catalog` from every component.yaml. Do not edit; CI runs `pnpm catalog --check`. -->",
    "",
    `Machine-readable source: [\`catalog.json\`](./catalog.json). ${c.components.length} components, ${c.contracts.length} contracts.`,
    "",
    "## Products",
    "",
    "| Product | Path | Components | Owners |",
    "|---|---|---|---|",
  ];
  for (const [slug, p] of Object.entries(c.products)) {
    lines.push(`| ${slug} | ${p.path ? `\`${p.path}/\`` : ""} | ${p.components.length ? p.components.join(", ") : "_none yet_"} | ${p.owners.join(", ")} |`);
  }
  lines.push("", "## Components", "", "| Name | Package | Kind | Product | Owner | Lifecycle | Path | Depends on | Summary |", "|---|---|---|---|---|---|---|---|---|");
  for (const x of c.components) {
    const deps = stringArray(x.depends_on).map((d) => `\`${d}\``).join(", ");
    lines.push(
      `| ${cell(x.name)} | \`${cell(x.package)}\` | ${cell(x.kind)} | ${cell(x.product)} | ${cell(x.owner)} | ${cell(x.lifecycle)} | \`${cell(x.path)}\` | ${deps} | ${cell(x.summary)} |`,
    );
  }
  lines.push("", "## Contracts", "", "| Contract | Kind | Exists | Providers | Consumers |", "|---|---|---|---|---|");
  for (const k of c.contracts) {
    lines.push(`| \`${cell(k.path)}\` | ${k.kind} | ${k.exists ? "yes" : "**no**"} | ${k.providers.join(", ")} | ${k.consumers.join(", ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function stripVolatile(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    delete parsed.generatedAt;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

export interface CatalogRunOptions {
  check?: boolean;
  now?: string;
}

/** Write (or with `check`, verify) the catalog files. */
export function runCatalog(ws: Workspace, opts: CatalogRunOptions = {}): CheckResult & { catalog: Catalog } {
  const jsonPath = path.join(ws.root, CATALOG_JSON);
  const mdPath = path.join(ws.root, CATALOG_MD);
  const existingJson = existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : null;
  const existingMd = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : null;

  let catalog = buildCatalog(ws, opts.now ?? process.env.CATALOG_NOW ?? new Date().toISOString());
  const unchanged = existingJson !== null && stripVolatile(existingJson) === stripVolatile(renderJson(catalog));
  if (unchanged) {
    const prev = (JSON.parse(existingJson) as { generatedAt?: string }).generatedAt;
    if (prev) catalog = { ...catalog, generatedAt: prev };
  }
  const json = renderJson(catalog);
  const md = renderMarkdown(catalog);
  const diagnostics: Diagnostic[] = [];
  const stats = { components: catalog.components.length, contracts: catalog.contracts.length, edges: catalog.edges.length };

  if (opts.check) {
    if (!unchanged) {
      diagnostics.push({
        severity: "error",
        rule: "catalog-stale",
        file: CATALOG_JSON,
        message: existingJson === null ? "catalog.json does not exist; run `pnpm catalog`" : "catalog.json is out of date with the manifests; run `pnpm catalog` and commit the result",
      });
    }
    if (existingMd !== md) {
      diagnostics.push({
        severity: "error",
        rule: "catalog-stale",
        file: CATALOG_MD,
        message: existingMd === null ? "CATALOG.md does not exist; run `pnpm catalog`" : "CATALOG.md is out of date; run `pnpm catalog` and commit the result",
      });
    }
    return { command: "catalog", diagnostics, stats, catalog };
  }

  mkdirSync(path.dirname(jsonPath), { recursive: true });
  if (existingJson !== json) writeFileSync(jsonPath, json);
  if (existingMd !== md) writeFileSync(mdPath, md);
  return { command: "catalog", diagnostics, stats: { ...stats, written: Number(existingJson !== json) + Number(existingMd !== md) }, catalog };
}
