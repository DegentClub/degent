/**
 * Static checks for products/degent/deploy (docs/DEPLOY.md). This container build has neither nix nor a
 * docker daemon, so these tests are what keeps the deployment artefacts honest:
 *   - .env.{signet,mainnet}.example are the generator's output (env.schema.json is the source of truth);
 *   - every variable mainnet requires is settable through the env example / compose and the NixOS module;
 *   - every secret is a file: a `*File` NixOS option, a compose secret and a `<NAME>_FILE` variable;
 *   - compose files parse and interpolate only known variables; the example env + compose produce a
 *     configuration the service's own loadConfig accepts (signet) or refuses only for the missing KMS (mainnet);
 *   - runtime Dockerfile stages run as a non-root USER with a HEALTHCHECK;
 *   - the NixOS web module and the container serve the same Caddy site body.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
// @ts-expect-error plain ESM script without type declarations
import { ENVIRONMENTS, passthroughVars, renderEnvExample, requiredOffRegtest, secretVars } from '../products/degent/deploy/gen-env.mjs';
import { ConfigError, loadConfig } from '../products/degent/services/mint/src/config.js';

const root = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const deploy = (p: string) => read(`products/degent/deploy/${p}`);

interface SchemaProp { 'x-secret'?: string; 'x-secret-file-for'?: string; 'x-required-unless-regtest'?: boolean }
const schema = JSON.parse(read('products/degent/services/mint/env.schema.json')) as { required: string[]; properties: Record<string, SchemaProp> };
const composeVars = JSON.parse(deploy('compose-vars.json')) as { fixed: Record<string, string>; deploy: Record<string, unknown> };
const schemaVars = new Set(Object.keys(schema.properties));
const deployVars = new Set(Object.keys(composeVars.deploy));
const secrets = secretVars() as Array<{ name: string; file: string; sops: string }>;
const mintNix = deploy('nix/mint.nix');
const webNix = deploy('nix/web.nix');
const siteCaddy = deploy('web-site.caddy');

type Env = 'signet' | 'mainnet';
interface ComposeService { environment?: Record<string, string>; secrets?: string[]; build?: { args?: Record<string, string> }; command?: string[] }
interface Compose { services: Record<string, ComposeService>; secrets: Record<string, { file: string }> }
const composeText = (env: Env) => deploy(`compose.${env}.yaml`);
const compose = (env: Env) => load(composeText(env)) as Compose;

/** `NAME=value` lines of an env file (comments ignored). */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Docker Compose interpolation subset used by our files: ${V}, ${V:-d}, ${V-d}, ${V:?msg}, ${V?msg}. */
function interpolate(text: string, env: Record<string, string>): string {
  return text.replace(/\$\{([A-Z_][A-Z0-9_]*)(?:(:?)([-?])([^}]*))?\}/g, (_m, name: string, colon: string, op: string, arg: string) => {
    const v = env[name];
    const unset = v === undefined || (colon === ':' && v === '');
    if (op === '-') return unset ? arg : v!;
    if (op === '?') {
      if (unset) throw new Error(`required variable ${name} is missing: ${arg}`);
      return v!;
    }
    return v ?? '';
  });
}

/** Compose parses YAML first, then interpolates string values (so `${X:-}` becomes "", not null). */
function interpolateTree<T>(node: T, env: Record<string, string>): T {
  if (typeof node === 'string') return interpolate(node, env) as T;
  if (Array.isArray(node)) return node.map((n) => interpolateTree(n, env)) as T;
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, interpolateTree(v, env)])) as T;
  return node;
}

const interpolations = (text: string) => [...text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!);
const camelFile = (name: string) =>
  `${name
    .replace(/_FILE$/, '')
    .toLowerCase()
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}File`;

describe('env examples (generated from env.schema.json)', () => {
  it.each(ENVIRONMENTS as Env[])('.env.%s.example is up to date (node products/degent/deploy/gen-env.mjs)', (env) => {
    expect(deploy(`.env.${env}.example`)).toBe(renderEnvExample(env));
  });

  it('every variable mainnet requires is in .env.mainnet.example, fixed by compose, or a listed secret file', () => {
    const example = deploy('.env.mainnet.example');
    const settable = new Set(Object.keys(parseEnvFile(example)));
    const mainnetEnv = compose('mainnet').services['mint-api']!.environment!;
    const missing: string[] = [];
    for (const name of requiredOffRegtest() as string[]) {
      if (schema.properties[name]!['x-secret']) {
        if (!new RegExp(`^#\\s+${name}\\s+<- \\$SECRETS_DIR/`, 'm').test(example)) missing.push(`${name} (secret not listed)`);
      } else if (name in composeVars.fixed) {
        if (!(name in mainnetEnv)) missing.push(`${name} (fixed but not set by compose.mainnet.yaml)`);
      } else if (!settable.has(name)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it('every variable mainnet requires is wired in the NixOS module (env mapping or credential)', () => {
    const missing = (requiredOffRegtest() as string[]).filter((name) => {
      const secret = schema.properties[name]!['x-secret'];
      if (secret) return !new RegExp(`\\b${name.replace(/_FILE$/, '')} = \\{ name = "[a-z-]+"; file = cfg\\.${camelFile(name)}; \\}`).test(mintNix);
      return !new RegExp(`^\\s+${name} = `, 'm').test(mintNix);
    });
    expect(missing).toEqual([]);
  });
});

describe('secrets are files everywhere', () => {
  it('every x-secret variable has a *File option in the NixOS module, delivered as a systemd credential', () => {
    for (const s of secrets) {
      const opt = camelFile(s.name);
      expect(mintNix, `${s.name} -> ${opt}`).toMatch(new RegExp(`^\\s+${opt} = secretFile `, 'm'));
      expect(mintNix, `${s.name} credential`).toContain(`${s.name.replace(/_FILE$/, '')} = { name = "${s.file}"; file = cfg.${opt}; }`);
    }
    // No secret option may be a plain string (would end up in the Nix store).
    expect(mintNix).not.toMatch(/(Key|Pass|Password|Token)\s*=\s*mkOption\s*\{\s*type = types\.(nullOr types\.)?str/);
  });

  it('every *_FILE variable in the schema names the secret it carries', () => {
    const twins = Object.entries(schema.properties).filter(([, p]) => p['x-secret-file-for']);
    for (const [name, p] of twins) {
      expect(name).toBe(`${p['x-secret-file-for']}_FILE`);
      expect(schema.properties[p['x-secret-file-for']!]?.['x-secret'], name).toBeTruthy();
    }
    expect(twins.length).toBe(secrets.filter((s) => s.name !== 'PARENT_KEY_FILE').length);
  });

  it.each(ENVIRONMENTS as Env[])('compose.%s.yaml passes each secret as a file, never as a value', (env) => {
    const c = compose(env);
    for (const svc of ['mint-api', 'mint-worker']) {
      const e = c.services[svc]!.environment!;
      for (const s of secrets) {
        expect(e, `${svc}: ${s.name} must not be set as a value`).not.toHaveProperty(s.name === 'PARENT_KEY_FILE' ? '__never__' : s.name);
        if (s.name === 'PARENT_KEY_FILE') {
          if (env === 'mainnet') expect(e).not.toHaveProperty('PARENT_KEY_FILE');
          else expect(e.PARENT_KEY_FILE).toBe(`/run/secrets/${s.file}`);
          continue;
        }
        expect(e[`${s.name}_FILE`], `${svc}: ${s.name}_FILE`).toBe(`/run/secrets/${s.file}`);
        expect(c.services[svc]!.secrets).toContain(s.file);
        expect(c.secrets[s.file]?.file).toMatch(new RegExp(`^\\$\\{SECRETS_DIR[^}]*\\}/${s.file}$`));
      }
    }
  });

  it('mainnet has no default for SECRETS_DIR, no parent key file, and the KMS signer', () => {
    const text = composeText('mainnet');
    expect(text).not.toMatch(/\$\{SECRETS_DIR:-/);
    expect(text).toMatch(/\$\{SECRETS_DIR:\?/);
    const e = compose('mainnet').services['mint-api']!.environment!;
    expect(e.SIGNER).toBe('kms');
    expect(e.NETWORK).toBe('mainnet');
    // Standard lane only unless a block-lane broadcaster is configured.
    expect(e.LIBRE_RPC_URL).toBe('${LIBRE_RPC_URL:-}');
    expect(e.SLIPSTREAM_URL).toBe('${SLIPSTREAM_URL:-}');
  });
});

describe('compose files', () => {
  it.each(ENVIRONMENTS as Env[])('compose.%s.yaml parses and interpolates only known variables', (env) => {
    const c = compose(env);
    expect(Object.keys(c.services).sort()).toEqual(['mint-api', 'mint-backup', 'mint-worker', 'web']);
    const unknown = interpolations(composeText(env)).filter((v) => !schemaVars.has(v) && !deployVars.has(v));
    expect(unknown).toEqual([]);
  });

  it.each(ENVIRONMENTS as Env[])('compose.%s.yaml: mint services set only env.schema.json variables, all pass-through ones included', (env) => {
    const c = compose(env);
    for (const svc of ['mint-api', 'mint-worker']) {
      const keys = Object.keys(c.services[svc]!.environment!);
      expect(keys.filter((k) => !schemaVars.has(k)), svc).toEqual([]);
      expect((passthroughVars() as string[]).filter((k) => !keys.includes(k)), svc).toEqual([]);
    }
    expect(c.services['mint-api']!.environment!.MINT_ROLE).toBe('api');
    expect(c.services['mint-worker']!.environment!.MINT_ROLE).toBe('worker');
    expect(c.services['mint-worker']!.command).toEqual(['worker']);
  });

  it.each(ENVIRONMENTS as Env[])('compose.%s.yaml: web environment keys are exactly Caddy placeholders', (env) => {
    const placeholders = new Set([...(deploy('Caddyfile') + siteCaddy).matchAll(/\{\$([A-Z_]+)/g)].map((m) => m[1]!));
    const keys = Object.keys(compose(env).services.web!.environment!);
    expect(keys.filter((k) => !placeholders.has(k))).toEqual([]);
  });

  it('the signet example env + compose.signet.yaml yield a configuration the service accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'degent-deploy-'));
    const vars = parseEnvFile(deploy('.env.signet.example'));
    // What an operator fills in: the parent identity and the collection address of the signet dev key.
    vars.PARENT_INSCRIPTION_ID = `${'b'.repeat(64)}i0`;
    vars.PARENT_OUTPOINT = `${'b'.repeat(64)}:0`;
    vars.COLLECTION_ADDRESS = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';
    const c = interpolateTree(compose('signet'), vars);
    // Compose passes every environment value as a string.
    const env: Record<string, string> = Object.fromEntries(Object.entries(c.services['mint-worker']!.environment!).map(([k, v]) => [k, String(v)]));
    const files: Record<string, string> = {
      'parent-key': '0000000000000000000000000000000000000000000000000000000000000001',
      'reveal-encryption-key': '44'.repeat(32),
      'session-key': '55'.repeat(32),
      'libre-rpc-pass': 'signet-rpc',
      'slipstream-api-key': '',
      'art-review-api-key': '',
      'telegram-bot-token': '',
    };
    for (const [k, v] of Object.entries(env)) {
      const m = /^\/run\/secrets\/(.+)$/.exec(v);
      if (m) {
        const p = join(dir, m[1]!);
        writeFileSync(p, `${files[m[1]!]}\n`);
        env[k] = p;
      }
    }
    env.ROSTER_FILE = 'data/roster.json';
    env.DATABASE_PATH = join(dir, 'mint.db');
    env.CONTENT_DIR = join(dir, 'content');
    const cfg = loadConfig(env);
    expect(cfg.role).toBe('worker');
    expect(cfg.settings.network).toBe('signet');
    expect(cfg.libre?.password).toBe('signet-rpc');
    expect(cfg.slipstream).toBeNull();
    expect(cfg.artReviewApiKey).toBeNull();
    expect(cfg.notify.telegramBotToken).toBeNull();
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.corsOrigins).toEqual(['https://signet.degent.club']);
    expect(cfg.settings.collection.tiers.map((t) => t.tier)).toEqual(['standard', 'block']);
  });

  it('the mainnet example env + compose.mainnet.yaml are refused only for the missing KMS signer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'degent-deploy-'));
    const vars = parseEnvFile(deploy('.env.mainnet.example'));
    Object.assign(vars, {
      ESPLORA_URL: 'http://10.40.0.103:8999/api',
      ORD_URL: 'http://10.40.0.217:8080',
      PARENT_INSCRIPTION_ID: `${'c'.repeat(64)}i0`,
      PARENT_OUTPOINT: `${'c'.repeat(64)}:0`,
      COLLECTION_ADDRESS: 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
      SECRETS_DIR: dir,
      DEGENT_IMAGE_TAG: 'v1',
      BACKUP_DIR: '/srv/backups',
      BACKUP_AGE_RECIPIENT: 'age1operatorrecipient',
    });
    expect(() => interpolateTree(compose('mainnet'), { ...vars, SECRETS_DIR: '' })).toThrow(/SECRETS_DIR/);
    expect(() => interpolateTree(compose('mainnet'), { ...vars, BACKUP_AGE_RECIPIENT: '' })).toThrow(/BACKUP_AGE_RECIPIENT/);
    const c = interpolateTree(compose('mainnet'), vars);
    const env: Record<string, string> = Object.fromEntries(Object.entries(c.services['mint-api']!.environment!).map(([k, v]) => [k, String(v)]));
    for (const [k, v] of Object.entries(env)) {
      const m = /^\/run\/secrets\/(.+)$/.exec(v);
      if (m) {
        const p = join(dir, m[1]!);
        writeFileSync(p, m[1] === 'reveal-encryption-key' || m[1] === 'session-key' ? '66'.repeat(32) : '');
        env[k] = p;
      }
    }
    env.ROSTER_FILE = 'data/roster.json';
    let problems: string[] = [];
    try {
      loadConfig(env);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      problems = e.problems;
    }
    expect(problems).toEqual(['SIGNER=kms is not implemented yet (see adapters/kms-policy-signer.ts)']);
  });
});

describe('Dockerfiles', () => {
  /** Stages of a Dockerfile: name -> instructions (continuation lines joined). */
  function stages(text: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    let current: string[] | null = null;
    const joined = text.replace(/\\\n/g, ' ');
    for (const raw of joined.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
      if (from) {
        current = [];
        out.set(from[1] ?? `stage${out.size}`, current);
        continue;
      }
      current?.push(line);
    }
    return out;
  }

  it.each([
    ['mint.Dockerfile', ['runtime', 'backup']],
    ['web.Dockerfile', ['runtime']],
  ])('%s: shipped stages run as a non-root USER with a HEALTHCHECK', (file, shipped) => {
    const s = stages(deploy(file));
    for (const name of shipped) {
      const ins = s.get(name as string);
      expect(ins, `${file} has stage ${name}`).toBeDefined();
      const users = ins!.filter((l) => /^USER\s/i.test(l)).map((l) => l.split(/\s+/)[1]!);
      expect(users.length, `${file}:${name} USER`).toBeGreaterThan(0);
      expect(['root', '0', '0:0', 'root:root']).not.toContain(users.at(-1));
      expect(ins!.some((l) => /^HEALTHCHECK\s+(?!NONE)/i.test(l)), `${file}:${name} HEALTHCHECK`).toBe(true);
    }
  });

  it('the mint image probes /v1/health and has api / worker commands', () => {
    const text = deploy('mint.Dockerfile');
    expect(text).toMatch(/HEALTHCHECK[\s\S]*\/v1\/health/);
    expect(text).toMatch(/pnpm --filter @bsh\/degent-mint deploy/);
    expect(text).toMatch(/ENTRYPOINT \["node", "dist\/main\.mjs"\]/);
    expect(text).toMatch(/docker run degent\/mint worker/);
  });

  it('the web image ships the shared Caddy site body', () => {
    expect(deploy('web.Dockerfile')).toContain('products/degent/deploy/web-site.caddy');
    expect(deploy('Caddyfile')).toMatch(/import web-site\.caddy/);
  });

  it("the mint image's manifest layer copies every @bsh workspace dependency's package.json", () => {
    // The build runs `pnpm install --frozen-lockfile --filter "@bsh/degent-mint..."` against only the
    // package.json files copied first. Missing one (e.g. @bsh/notify) fails the install, so this keeps
    // the Dockerfile's COPY list in step with the service's dependency closure.
    const repoRoot = root;
    const nameToDir = new Map<string, string>();
    for (const g of ['deps/scribbit/platform/*', 'products/degent/{packages,services}/*']) {
      for (const dir of globSync(g, { cwd: repoRoot })) {
        const pj = join(repoRoot, dir, 'package.json');
        if (existsSync(pj)) nameToDir.set(JSON.parse(readFileSync(pj, 'utf8')).name, dir);
      }
    }
    const mintPkg = JSON.parse(readFileSync(join(repoRoot, 'products/degent/services/mint/package.json'), 'utf8'));
    const bshDeps = Object.keys({ ...mintPkg.dependencies, ...mintPkg.devDependencies }).filter((d) => d.startsWith('@bsh/'));
    const dockerfile = deploy('mint.Dockerfile');
    for (const dep of bshDeps) {
      const dir = nameToDir.get(dep);
      expect(dir, `no workspace dir for ${dep}`).toBeDefined();
      expect(dockerfile, `mint.Dockerfile must COPY ${dir}/package.json`).toContain(`${dir}/package.json`);
    }
  });
});

describe('NixOS web module', () => {
  it('substitutes every placeholder of the shared Caddy site body', () => {
    const placeholders = [...new Set([...siteCaddy.matchAll(/\{\$[A-Z_]+:[^}]*\}/g)].map((m) => m[0]))];
    expect(placeholders.length).toBeGreaterThan(3);
    for (const p of placeholders) expect(webNix, p).toContain(`"${p}"`);
    expect(webNix).toContain('builtins.readFile ../web-site.caddy');
  });

  it('the site body carries the security headers, SPA fallback and immutable asset caching', () => {
    for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy', "frame-ancestors 'none'"])
      expect(siteCaddy).toContain(h);
    expect(siteCaddy).toContain('try_files {path} /index.html');
    expect(siteCaddy).toMatch(/@assets path \/assets\/\*\n\s*header @assets Cache-Control "public, max-age=31536000, immutable"/);
    expect(siteCaddy).toMatch(/handle_path \/api\/\*/);
  });

  it('the proxy hands the services a client IP the client cannot choose (DGT-SEC-007)', () => {
    expect(siteCaddy).toMatch(/reverse_proxy \{\$MINT_API_UPSTREAM[^\n]*\{\n(?:[^\n]*\n)*?\s*header_up X-Client-IP \{client_ip\}\n/);
    expect(deploy('Caddyfile')).toMatch(/trusted_proxies static private_ranges\s*\n(?:\s*#.*\n)*\s*trusted_proxies_strict/);
  });
});

describe('NixOS mint module', () => {
  it('declares hardened api and worker units sharing one state directory', () => {
    expect(mintNix).toContain('systemd.services.degent-mint-api = unit "api"');
    expect(mintNix).toContain('systemd.services.degent-mint-worker = unit "worker"');
    for (const k of ['NoNewPrivileges = true', 'ProtectSystem = "strict"', 'StateDirectory = "degent-mint"', 'PrivateTmp = true', 'CapabilityBoundingSet = ""', 'LoadCredential'])
      expect(mintNix).toContain(k);
    expect(mintNix).toContain('assertion = cfg.network != "mainnet" || (cfg.parentKeyFile == null && cfg.signer == "kms")');
  });

  it('the root flake exposes the packages and both modules', () => {
    const flake = read('flake.nix');
    for (const s of ['degent-mint = import ./products/degent/deploy/nix/mint.nix', 'degent-web = import ./products/degent/deploy/nix/web.nix', 'products/degent/deploy/nix/packages.nix', 'self.submodules = true'])
      expect(flake).toContain(s);
    const pkgs = deploy('nix/packages.nix');
    expect(pkgs).toMatch(/degent-mint = lib\.makeOverridable/);
    expect(pkgs).toMatch(/degent-web = lib\.makeOverridable/);
    expect(pkgs).toContain('pnpm.fetchDeps');
  });
});

describe('single-host server (compose.server.yaml, server/*.sh, deploy workflow; docs/SERVER.md)', () => {
  interface ServerService { image: string; user?: string; environment?: Record<string, string>; secrets?: string[]; ports?: string[]; read_only?: boolean; cap_drop?: string[]; security_opt?: string[] }
  const serverText = deploy('compose.server.yaml');
  const server = load(serverText) as { services: Record<string, ServerService>; secrets: Record<string, { file: string }> };
  const serverVars = new Set(Object.keys((composeVars as unknown as { server: Record<string, string> }).server).filter((k) => !k.startsWith('$')));

  it('parses, runs only the official Caddy image and our GHCR images, and interpolates only documented variables', () => {
    expect(Object.keys(server.services).sort()).toEqual(['caddy', 'mint-mainnet-api', 'mint-mainnet-worker', 'mint-signet-api', 'mint-signet-worker', 'web-mainnet', 'web-signet']);
    for (const [name, s] of Object.entries(server.services))
      expect(s.image, name).toMatch(/^(\$\{CADDY_IMAGE:-caddy:[0-9.]+-alpine\}|ghcr\.io\/degentclub\/degent-(mint|web-mainnet|web-signet):\$\{(MAINNET|SIGNET)_TAG:\?[^}]+\})$/);
    expect(interpolations(serverText).filter((v) => !serverVars.has(v))).toEqual([]);
  });

  it('hardens every container; only caddy publishes ports (80, 443/tcp, 443/udp)', () => {
    for (const [name, s] of Object.entries(server.services)) {
      expect(s.read_only, name).toBe(true);
      expect(s.cap_drop, name).toEqual(['ALL']);
      expect(s.security_opt, name).toContain('no-new-privileges:true');
      if (name !== 'caddy') expect(s.ports, name).toBeUndefined();
    }
    expect(server.services.caddy!.ports).toEqual(['80:80/tcp', '443:443/tcp', '443:443/udp']);
  });

  it('mint services: schema variables only, secrets only as files, no parent key or signer, read-only by default', () => {
    const secretNames = secrets.map((s) => s.name);
    for (const name of ['mint-mainnet-api', 'mint-mainnet-worker', 'mint-signet-api', 'mint-signet-worker']) {
      const s = server.services[name]!;
      const env = s.environment!;
      expect(Object.keys(env).filter((k) => !schemaVars.has(k)), name).toEqual([]);
      for (const k of Object.keys(env)) expect(secretNames, `${name}: ${k} must be a *_FILE`).not.toContain(k);
      for (const k of ['PARENT_KEY_FILE', 'SIGNER', 'PARENT_INSCRIPTION_ID', 'PARENT_OUTPOINT', 'COLLECTION_ADDRESS']) expect(env, name).not.toHaveProperty(k);
      expect(env.REVEAL_ENCRYPTION_KEY_FILE).toMatch(/^\/run\/secrets\/(mainnet|signet)-reveal-encryption-key$/);
      expect(env.SESSION_KEY_FILE).toMatch(/^\/run\/secrets\/(mainnet|signet)-session-key$/);
      expect(env.MINT_MODE).toMatch(/^\$\{(MAINNET|SIGNET)_MINT_MODE:-readonly\}$/);
      expect(s.user).toContain('DEPLOY_UID');
    }
    for (const [name, sec] of Object.entries(server.secrets)) expect(sec.file, name).toMatch(/^\$\{DEGENT_HOME:-\/opt\/degent\}\/secrets\/(mainnet|signet)\/[a-z-]+$/);
    expect(server.services['mint-mainnet-api']!.environment!.NETWORK).toBe('mainnet');
    expect(server.services['mint-signet-api']!.environment!.NETWORK).toBe('signet');
  });

  it('the mainnet read-only API env is accepted by the service (no signer, no parent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'degent-server-'));
    const c = interpolateTree(load(serverText) as typeof server, { MAINNET_TAG: 'abc1234', SIGNET_TAG: 'abc1234', DEPLOY_UID: '1001', DEPLOY_GID: '1001' });
    const env: Record<string, string> = Object.fromEntries(Object.entries(c.services['mint-mainnet-api']!.environment!).map(([k, v]) => [k, String(v)]));
    for (const [k, v] of Object.entries(env)) {
      const m = /^\/run\/secrets\/(.+)$/.exec(v);
      if (m) {
        writeFileSync(join(dir, m[1]!), '77'.repeat(32));
        env[k] = join(dir, m[1]!);
      }
    }
    env.DATABASE_PATH = join(dir, 'mint.db');
    env.CONTENT_DIR = join(dir, 'content');
    const cfg = loadConfig(env);
    expect(cfg.mode).toBe('readonly');
    expect(cfg.settings.network).toBe('mainnet');
    expect(cfg.corsOrigins).toEqual(['https://mint.degent.club']);
  });

  it('caddy: apex 301 to the app, www opt-in, mint and signet sites', () => {
    const dir = 'server/caddy/';
    const main = deploy(`${dir}Caddyfile`);
    expect(main).toMatch(/\{\$MINT_DOMAIN:mint\.degent\.club\} \{[\s\S]*?reverse_proxy web-mainnet:8080/);
    expect(main).toMatch(/\{\$SIGNET_DOMAIN:signet\.degent\.club\} \{[\s\S]*?reverse_proxy web-signet:8080/);
    expect(main).toContain('import apex-redirect-{$APEX_REDIRECT:true}.caddy');
    expect(main).toContain('import www-{$WWW_REDIRECT:false}.caddy');
    expect(main).not.toMatch(/^www\./m);
    expect(deploy(`${dir}apex-redirect-true.caddy`)).toContain('redir https://{$MINT_DOMAIN:mint.degent.club}{uri} 301');
    expect(deploy(`${dir}www-false.caddy`)).not.toMatch(/\{\s*$/m);
    const keys = Object.keys(server.services.caddy!.environment!);
    const placeholders = new Set([...['Caddyfile', 'apex-redirect-true.caddy', 'www-true.caddy'].map((f) => deploy(`${dir}${f}`)).join('\n').matchAll(/\{\$([A-Z_]+)/g)].map((m) => m[1]!));
    expect(keys.sort()).toEqual([...placeholders].sort());
  });

  it('the mint image carries the release bundle deploy.sh unpacks', () => {
    const text = deploy('mint.Dockerfile');
    expect(text).toContain('COPY --chown=root:root products/degent/deploy/compose.server.yaml /app/deploy/compose.server.yaml');
    expect(text).toContain('COPY --chown=root:root products/degent/deploy/server/caddy /app/deploy/caddy');
    expect(deploy('server/deploy.sh')).toContain('docker cp "$cid:/app/deploy/." "$dir.tmp/"');
  });

  it('scripts: strict mode, no password literal, no parent key; bash -n passes', () => {
    for (const f of ['server/bootstrap.sh', 'server/deploy.sh']) {
      const text = deploy(f);
      expect(text, f).toMatch(/^set -euo pipefail$/m);
      expect(text, f).not.toMatch(/(password|passwd|SSHPASS)\s*=\s*\S/i);
      expect(text, f).not.toMatch(/chpasswd|parent-key/);
      execFileSync('bash', ['-n', join(root, 'products/degent/deploy', f)]);
    }
    const boot = deploy('server/bootstrap.sh');
    expect(boot).not.toMatch(/^\s*PasswordAuthentication/m);
    for (const s of ['PermitRootLogin no', 'MaxAuthTries 3', 'ufw allow 22/tcp', 'ufw allow 80/tcp', 'ufw allow 443/tcp', 'ufw allow 443/udp', 'ufw default deny incoming', 'maxretry = 5', 'findtime = 10m', 'bantime  = 1h', 'env_default MAINNET_MINT_MODE readonly'])
      expect(boot).toContain(s);
  });

  it('deploy.sh refuses anything outside its grammar before touching docker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'degent-deploysh-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const trace = join(dir, 'docker.log');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${trace}\n`, { mode: 0o755 });
    const run = (cmd: string) => {
      const r = spawnSync('bash', [join(root, 'products/degent/deploy/server/deploy.sh')], {
        env: { PATH: `${bin}:${process.env.PATH}`, DEGENT_HOME: dir, SSH_ORIGINAL_COMMAND: cmd },
        encoding: 'utf8',
      });
      return { code: r.status, out: r.stdout.trim() };
    };
    for (const bad of ['', 'deploy', 'deploy $(id)', 'deploy abc;rm', 'deploy ABCDEF1', 'deploy abc1234 prod', 'deploy abc1234 both x', 'logs /etc/passwd', 'logs caddy 99999', 'rm -rf /', 'status now', 'deploy  abc1234']) {
      const r = run(bad);
      expect(r.code, bad).toBe(2);
      expect(JSON.parse(r.out)).toMatchObject({ ok: false, action: 'usage' });
    }
    expect(run('status')).toMatchObject({ code: 1 });
    expect(JSON.parse(run('status').out).error).toMatch(/nothing deployed yet/);
    expect(existsSync(trace)).toBe(false);
  });

  it('the deploy workflow parses, pins actions to SHAs, gates on SERVER_PASSWORD and smoke-tests the URLs', () => {
    const text = read('.github/workflows/deploy.yml');
    const wf = load(text) as { on: { push: { branches: string[] } }; jobs: Record<string, { permissions?: Record<string, string>; env?: Record<string, string> }> };
    expect(wf.on.push.branches).toEqual(['claude/magical-einstein-ugdy2r']);
    for (const m of text.matchAll(/uses: (\S+)/g)) expect(m[1], m[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(text).toContain("HAS_PW: ${{ secrets.SERVER_PASSWORD != '' }}");
    expect(wf.jobs.images!.permissions).toMatchObject({ packages: 'write' });
    expect(wf.jobs.server!.env!.SSHPASS).toBe('${{ secrets.SERVER_PASSWORD }}');
    expect(text).toContain('sshpass -e ssh');
    expect(text).not.toMatch(/sshpass -p/);
    expect(text).toContain('/opt/degent/bin/deploy.sh deploy $SHA both');
    for (const s of ['https://$MINT_DOMAIN/api/v1/health', 'https://$SIGNET_DOMAIN/api/v1/health', '301 https://$MINT_DOMAIN/collection?x=1']) expect(text).toContain(s);
    for (const name of ['mint', 'web-mainnet', 'web-signet']) expect(text).toContain(`- name: ${name}`);
  });
});
