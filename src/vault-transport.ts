import { FactoryError } from "./errors.ts";
import type { VaultConfig } from "./vault-config.ts";
import { execFile } from "node:child_process";
import { existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface VaultGhAuthStatus {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghUser: string | null;
  suggestedRepo: string | null;
}

// ===== Stage B (ADR 0014 Decision 2): the runner seam + both transports =====

/** One external CLI call routed through the `VaultRunner` seam — `gh api`, `git clone/pull/push`, never a shell string. */
export interface VaultRunnerCall {
  /** The binary to run — `gh` or `git` in practice, anything a test wants to observe. */
  command: string;
  args: readonly string[];
  /** Working directory for the child (git operations inside the vault checkout). */
  cwd?: string;
  /** Extra child environment (an explicit token rides as `GH_TOKEN`). */
  env?: Record<string, string>;
}

/**
 * The injectable seam every external vault CLI call goes through (spec
 * §Implementation Decisions 1). The default runs real children with
 * `GIT_TERMINAL_PROMPT: "0"`; tests inject fakes that answer with in-memory
 * tarball fixtures — zero network, zero prompts. Resolves with the child's
 * stdout as raw bytes (tarball streams are binary).
 */
export type VaultRunner = (call: VaultRunnerCall) => Promise<Buffer>;

export const VAULT_FALLBACK_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] as const;

/**
 * Appends macOS/POSIX fallback binary directories to `basePath` when absent,
 * preserving any caller/test prepended entries first so `PATH` shims always win.
 */
export function buildVaultPath(basePath = process.env.PATH ?? ""): string {
  const segments = basePath.split(":").filter((segment) => segment !== "");
  for (const fallback of VAULT_FALLBACK_PATH_DIRS) {
    if (!segments.includes(fallback)) segments.push(fallback);
  }
  return segments.join(":");
}

export function createDefaultVaultRunner(): VaultRunner {
  return (call) =>
    new Promise<Buffer>((resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ...call.env, GIT_TERMINAL_PROMPT: "0" };
      childEnv.PATH = buildVaultPath(childEnv.PATH);
      execFile(
        call.command,
        [...call.args],
        {
          cwd: call.cwd,
          encoding: "buffer",
          maxBuffer: VAULT_RUNNER_MAX_BUFFER_BYTES,
          env: childEnv,
        },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr.length > 0 ? stderr.toString("utf8").trim() : err.message;
            reject(new FactoryError("vault-runner-failed", `${call.command} ${call.args.join(" ")}: ${detail}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
}

/** The runner every transport uses unless the caller injects one. */
export const builtinVaultRunner = createDefaultVaultRunner();

export const GH_AUTH_CACHE_TTL_MS = 15_000;

export const ghAuthCache = new Map<VaultRunner, { expiresAt: number; value: VaultGhAuthStatus }>();

/** Clears the 15-second `probeGhAuth` cache (used by tests and explicit login re-checks). */
export function clearGhAuthCache(): void {
  ghAuthCache.clear();
}

/**
 * Probes GitHub CLI (`gh`) installation and active `github.com` login via
 * `gh auth status --json hosts` (falling back to `gh api user --jq .login`
 * when `--json` is unsupported on older `gh`), cached for 15 seconds per
 * runner so snapshot polls never spam subprocesses.
 */
export async function probeGhAuth(runner?: VaultRunner): Promise<VaultGhAuthStatus> {
  const effectiveRunner = runner ?? builtinVaultRunner;
  const now = Date.now();
  const cached = ghAuthCache.get(effectiveRunner);
  if (cached !== undefined && now < cached.expiresAt) {
    return { ...cached.value };
  }

  const store = (value: VaultGhAuthStatus): VaultGhAuthStatus => {
    if (value.ghAuthenticated) {
      ghAuthCache.set(effectiveRunner, { expiresAt: Date.now() + GH_AUTH_CACHE_TTL_MS, value });
    }
    return { ...value };
  };

  try {
    const out = await effectiveRunner({ command: "gh", args: ["auth", "status", "--json", "hosts"] });
    const parsed = parseGhHostsStatus(out.toString("utf8"));
    if (parsed.kind === "authenticated") {
      return store({
        ghInstalled: true,
        ghAuthenticated: true,
        ghUser: parsed.login,
        suggestedRepo: `${parsed.login}/factory-vault`,
      });
    }
    if (parsed.kind === "unauthenticated") {
      return store({ ghInstalled: true, ghAuthenticated: false, ghUser: null, suggestedRepo: null });
    }
  } catch (err) {
    if (isGhMissingError(err)) {
      return store({ ghInstalled: false, ghAuthenticated: false, ghUser: null, suggestedRepo: null });
    }
    if (isGhUnauthenticatedError(err)) {
      return store({ ghInstalled: true, ghAuthenticated: false, ghUser: null, suggestedRepo: null });
    }
  }

  try {
    const out = await effectiveRunner({ command: "gh", args: ["api", "user", "--jq", ".login"] });
    const login = out.toString("utf8").trim().split(/\r?\n/)[0]?.trim() ?? "";
    if (login !== "" && !login.includes(" ") && !login.startsWith("{")) {
      return store({
        ghInstalled: true,
        ghAuthenticated: true,
        ghUser: login,
        suggestedRepo: `${login}/factory-vault`,
      });
    }
  } catch (err) {
    if (isGhMissingError(err)) {
      return store({ ghInstalled: false, ghAuthenticated: false, ghUser: null, suggestedRepo: null });
    }
  }

  return store({ ghInstalled: true, ghAuthenticated: false, ghUser: null, suggestedRepo: null });
}

export function parseGhHostsStatus(raw: string): { kind: "authenticated"; login: string } | { kind: "unauthenticated" } | { kind: "unknown" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "unknown" };
  const hosts = (parsed as { hosts?: unknown }).hosts;
  if (typeof hosts !== "object" || hosts === null) return { kind: "unknown" };

  const candidates: Array<Record<string, unknown>> = [];
  if (Array.isArray(hosts)) {
    for (const item of hosts) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        if (rec.host === undefined || rec.host === "github.com") candidates.push(rec);
      }
    }
  } else {
    const ghCom = (hosts as Record<string, unknown>)["github.com"];
    if (Array.isArray(ghCom)) {
      for (const item of ghCom) {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          candidates.push(item as Record<string, unknown>);
        }
      }
    } else if (typeof ghCom === "object" && ghCom !== null) {
      candidates.push(ghCom as Record<string, unknown>);
    }
  }

  const valid = candidates.filter((entry) => {
    const login = typeof entry.login === "string" ? entry.login.trim() : typeof entry.user === "string" ? entry.user.trim() : "";
    if (login === "") return false;
    if (typeof entry.state === "string" && entry.state !== "success") return false;
    if (entry.authenticated === false) return false;
    return true;
  });

  if (valid.length === 0) return { kind: "unauthenticated" };
  const chosen = valid.find((entry) => entry.active === true) ?? valid[0]!;
  const login = (typeof chosen.login === "string" ? chosen.login : (chosen.user as string)).trim();
  return { kind: "authenticated", login };
}

export function isGhMissingError(err: unknown): boolean {
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\bENOENT\b|command not found|spawn gh\b.*not found|\bgh:\s*not found|\bgh not found\b|^not found$/i.test(msg);
}

export function isGhUnauthenticatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not logged in|You are not logged into|authentication failed|To log in, run|no oauth token/i.test(msg);
}

/**
 * Ensures the remote GitHub repository `<owner>/<repo>` exists: returns
 * `{ created: false, repo }` immediately for local filesystem paths or URLs,
 * otherwise runs `gh auth setup-git --hostname github.com` (best-effort),
 * probes `gh repo view <slug> --json nameWithOwner`, and creates the private
 * repository via `gh repo create <slug> --private --add-readme --description "Private vault for paseo-factory"`
 * when absent.
 */
export async function ensureRemoteVaultRepo(repo: string, runner?: VaultRunner): Promise<{ created: boolean; repo: string }> {
  const trimmed = repo.trim();
  if (
    isAbsolute(trimmed) ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("file://") ||
    trimmed.includes("://") ||
    /^[^/]+@[^:]+:/.test(trimmed)
  ) {
    return { created: false, repo };
  }
  const stripped = trimmed.replace(/^git:/, "").replace(/\.git$/, "");
  if (!/^[^\s/]+\/[^\s/]+$/.test(stripped)) {
    return { created: false, repo };
  }

  const effectiveRunner = runner ?? builtinVaultRunner;
  try {
    await effectiveRunner({ command: "gh", args: ["auth", "setup-git", "--hostname", "github.com"] });
  } catch {
    // best-effort: setup-git is non-fatal when git credentials are already configured
  }

  try {
    await effectiveRunner({ command: "gh", args: ["repo", "view", stripped, "--json", "nameWithOwner"] });
    return { created: false, repo: stripped };
  } catch {
    // repository does not exist yet — create it below
  }

  await effectiveRunner({
    command: "gh",
    args: ["repo", "create", stripped, "--private", "--add-readme", "--description", "Private vault for paseo-factory"],
  });
  return { created: true, repo: stripped };
}

/**
 * True for a local filesystem source — an absolute (`/`), relative (`.`), home
 * (`~`), or Windows drive (`C:\` / `C:/`) path — never a Git remote (v0.0.30,
 * ADR 0012 §2). Local directory installs skip the GitHub pull-access
 * pre-flight entirely so they work offline.
 */
export function isLocalCompanionGitSource(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.startsWith("/") || trimmed.startsWith(".") || trimmed.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(trimmed);
}

/** A companion source's normalized GitHub remote — the ls-remote URL and the owner/repo slug the refusal messages name. */
export interface CompanionGitRemote {
  remoteUrl: string;
  repoSlug: string;
}

/**
 * Normalizes the GitHub source forms a companion install carries —
 * `git:<owner>/<repo>[:<subpath>]`, `github:<owner>/<repo>`,
 * `https://github.com/<owner>/<repo>[.git]`, `ssh://git@github.com/<owner>/<repo>[.git]`,
 * and the scp-style `git@github.com:<owner>/<repo>[.git]` — into
 * `{ remoteUrl, repoSlug }`. The SSH forms keep their own URL as `remoteUrl`:
 * the pre-flight must probe the exact remote the daemon will clone, not a
 * rewritten HTTPS URL that would falsely refuse an SSH-key user without `gh`
 * HTTPS credentials. Anything else returns null: not a GitHub remote, so no
 * GitHub pre-flight applies.
 */
export function normalizeCompanionGitRemote(source: string): CompanionGitRemote | null {
  const trimmed = source.trim();
  const https = /^https:\/\/github\.com\/([^\s/#?]+)\/([^\s/#?]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https !== null) {
    return { remoteUrl: `https://github.com/${https[1]}/${https[2]}.git`, repoSlug: `${https[1]}/${https[2]}` };
  }
  const prefixed = /^(?:git|github):([^\s/:]+)\/([^\s/:]+?)(?:\.git)?(?::[^\s]*)?$/.exec(trimmed);
  if (prefixed !== null) {
    return { remoteUrl: `https://github.com/${prefixed[1]}/${prefixed[2]}.git`, repoSlug: `${prefixed[1]}/${prefixed[2]}` };
  }
  const sshUrl = /^ssh:\/\/git@github\.com\/([^\s/#?]+)\/([^\s/#?]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (sshUrl !== null) {
    return { remoteUrl: trimmed, repoSlug: `${sshUrl[1]}/${sshUrl[2]}` };
  }
  const scp = /^git@github\.com:([^\s/#?]+)\/([^\s/#?]+?)(?:\.git)?$/.exec(trimmed);
  if (scp !== null) {
    return { remoteUrl: trimmed, repoSlug: `${scp[1]}/${scp[2]}` };
  }
  return null;
}

/**
 * The pre-flight pull-access check for an explicit install of a `private`
 * companion (v0.0.30, ADR 0012 §2 / ADR 0014 §1): verifies the machine can
 * actually read the private repository before the daemon's `git clone` runs,
 * so an unauthorized user gets an actionable message instead of a raw clone
 * error. Local paths pass immediately (offline directory installs); non-GitHub
 * sources pass too (nothing to pre-flight). For a GitHub remote:
 *
 * 1. `probeGhAuth` — when `gh` is authenticated, run
 *    `gh auth setup-git --hostname github.com` best-effort so the host's Git
 *    HTTPS credential helper is wired even on a machine that logged in without
 *    ever running setup-git.
 * 2. `git ls-remote --heads -- <remoteUrl>` (the VaultRunner seam's own
 *    `GIT_TERMINAL_PROMPT: "0"` and augmented PATH) — success means pull
 *    access; failure refuses with the reason naming either `@<ghUser>` (ask
 *    the owner to invite them as a collaborator) or the `gh auth login` step.
 */
export async function probeCompanionGitAccess(
  source: string,
  options?: { runner?: VaultRunner },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (isLocalCompanionGitSource(source)) return { ok: true };
  const remote = normalizeCompanionGitRemote(source);
  if (remote === null) return { ok: true };
  const runner = options?.runner ?? builtinVaultRunner;

  const ghAuth = await probeGhAuth(runner);
  if (ghAuth.ghAuthenticated) {
    try {
      await runner({ command: "gh", args: ["auth", "setup-git", "--hostname", "github.com"] });
    } catch {
      // best-effort: setup-git is non-fatal when git credentials are already configured
    }
  }

  try {
    await runner({ command: "git", args: ["ls-remote", "--heads", "--", remote.remoteUrl] });
    return { ok: true };
  } catch {
    if (ghAuth.ghAuthenticated && ghAuth.ghUser !== null) {
      return {
        ok: false,
        reason: `GitHub account @${ghAuth.ghUser} does not have pull access to private repository ${remote.repoSlug}. Ask the repository owner to invite @${ghAuth.ghUser} as a collaborator.`,
      };
    }
    return {
      ok: false,
      reason: `${remote.repoSlug} is a private repository. Run "gh auth login --web -p https" with an authorized GitHub account before installing.`,
    };
  }
}

/** The default runner's stdout ceiling — vault tarballs are binary and can be large. */
export const VAULT_RUNNER_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * Ensures `<vaultDir>/.git` exists: tries `git clone --branch <branch> <url> <vaultDir>`
 * first, and when `<branch>` does not exist on an empty/branchless remote, cleans
 * `<vaultDir>`, clones without `--branch`, and initializes `<branch>` locally via
 * `git checkout -B <branch>`.
 */
export async function ensureVaultCheckout(runner: VaultRunner, config: VaultConfig, vaultDir: string): Promise<void> {
  if (existsSync(join(vaultDir, ".git"))) return;
  if (existsSync(vaultDir)) rmSync(vaultDir, { recursive: true, force: true });
  const remoteUrl = vaultRemoteUrl(config.repo);
  try {
    await runner({ command: "git", args: ["clone", "--branch", config.branch, remoteUrl, vaultDir] });
  } catch (err) {
    if (!isMissingRemoteBranchCloneError(err)) throw err;
    if (existsSync(vaultDir)) rmSync(vaultDir, { recursive: true, force: true });
    await runner({ command: "git", args: ["clone", remoteUrl, vaultDir] });
    await runner({ command: "git", args: ["checkout", "-B", config.branch], cwd: vaultDir });
    const gitConfigPath = join(vaultDir, ".git", "config");
    if (existsSync(gitConfigPath)) {
      const gitConfig = readFileSync(gitConfigPath, "utf8");
      if (!gitConfig.includes(`[branch "${config.branch}"]`)) {
        writeFileSync(
          gitConfigPath,
          `${gitConfig.endsWith("\n") ? gitConfig : `${gitConfig}\n`}[branch "${config.branch}"]\n\tremote = origin\n\tmerge = refs/heads/${config.branch}\n`,
        );
      }
    }
  }
}

export function isMissingRemoteBranchCloneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Remote branch .* not found|Could not find remote branch|cloned an empty repository|unborn/i.test(msg);
}

export function isEmptyOrUnbornPullError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /There is no tracking information|Couldn't find remote ref|no such ref was fetched|Remote branch .* not found|does not have any commits yet|unborn/i.test(msg);
}

/** `owner/repo` for `gh api`; a leading `git:` and trailing `.git` are tolerated, anything else is not a GitHub slug. */
export function githubRepoSlug(repo: string): string {
  const stripped = repo.startsWith("git:") ? repo.slice("git:".length) : repo;
  const slug = stripped.endsWith(".git") ? stripped.slice(0, -".git".length) : stripped;
  if (/^[^\s/]+\/[^\s/]+$/.test(slug)) return slug;
  throw new FactoryError("vault-repo-not-github", `direct hydrate needs a GitHub owner/repo slug, got "${repo}"`);
}

/** The clone/push URL: GitHub slugs expand to https remotes; local paths, `file://`, and URL/SCP forms pass through. */
export function vaultRemoteUrl(repo: string): string {
  const stripped = repo.startsWith("git:") ? repo.slice("git:".length) : repo;
  if (stripped.includes("://") || /^[^/]+:/.test(stripped) || stripped.startsWith("/") || stripped.startsWith("./") || stripped.startsWith("../")) {
    return stripped;
  }
  if (/^[^\s/]+\/[^\s/]+$/.test(stripped)) return `https://github.com/${stripped}.git`;
  return stripped;
}

/** Strips the GitHub tarball's single top-level `<owner>-<repo>-<sha>/` prefix; root-level entries and dirs yield `null`. */
export function vaultPathFromArchivePath(path: string): string | null {
  const slash = path.indexOf("/");
  if (slash <= 0) return null;
  const rest = path.slice(slash + 1);
  return rest === "" ? null : rest;
}

export interface TarEntry {
  path: string;
  data: Buffer;
}

/**
 * A minimal in-memory tar walker (`node:fs`-free, no external tar library):
 * 512-byte ustar headers, octal sizes, ustar prefix fields, GNU long-name
 * (`L`) and pax `path=` overrides, directories and links skipped, the
 * zero-block end marker honored, a truncated archive refused.
 */
export function parseTarEntries(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let pendingPath: string | null = null;
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (isAllZeroes(header)) break;
    const size = parseTarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new FactoryError("corrupted-vault-tarball", `the vault tarball is truncated inside an entry (needs ${dataEnd} bytes, has ${archive.length})`);
    }
    const data = archive.subarray(dataStart, dataEnd);
    const typeflag = String.fromCharCode(header[156]!);

    if (typeflag === "L" || typeflag === "x" || typeflag === "g") {
      const override = typeflag === "L" ? stripTrailingNul(data.toString("utf8")) : paxPath(data);
      if (override !== null) pendingPath = override;
    } else if (typeflag === "0" || typeflag === "\0") {
      let path = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      if (prefix !== "") path = `${prefix}/${path}`;
      if (pendingPath !== null) {
        path = pendingPath;
        pendingPath = null;
      }
      entries.push({ path, data });
    }
    // directories (`5`) and link entries are not vault content

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function isAllZeroes(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

/** Reads one NUL-terminated string field out of a tar header. */
export function tarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** Reads one octal tar header field; a blank field is 0, garbage is a corrupted archive. */
export function parseTarOctal(header: Buffer, offset: number, length: number): number {
  const raw = tarString(header, offset, length).trim();
  if (raw === "") return 0;
  const value = parseInt(raw, 8);
  if (Number.isNaN(value)) {
    throw new FactoryError("corrupted-vault-tarball", `the vault tarball header field at ${offset} is not octal ("${raw}")`);
  }
  return value;
}

/** Extracts `path=` from a pax extended header's `<len> key=value\n` records, if present. */
export function paxPath(data: Buffer): string | null {
  for (const line of data.toString("utf8").split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const record = line.slice(space + 1);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
  }
  return null;
}

export function stripTrailingNul(text: string): string {
  return text.replace(/\0+$/, "");
}
