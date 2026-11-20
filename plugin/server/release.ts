/**
 * Lead-owned Release runner (v0.14.0, ADR 0061):
 * runs inside the plugin server (never inside bridge.mjs), resolving `git` and
 * `gh` through `VaultRunner` + `buildVaultPath` so Finder-launched daemons and
 * hermetic tests share one injection seam.
 *
 * Preconditions run strictly before any external mutation (and record no
 * `release_failed` line); failures during the four idempotent steps record
 * `release_failed` with the failing step and error code so retries can resume
 * safely without re-tagging or re-pushing already-landed commits.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isSeatMemoryRelativePathAllowed } from "./core/choke.ts";
import { isReadOnlyPeerDisposition, type LedgerEvent } from "./core/events.ts";
import type { Factory } from "./core/factory.ts";
import { clearReleaseRequest, readReleaseRequest, readReleaseSettings } from "./core/project-settings.ts";
import type { ProjectReleaseMode } from "./core/project-settings.ts";
import { builtinVaultRunner, isGhMissingError, isGhUnauthenticatedError } from "./core/vault-transport.ts";
import type { VaultRunner } from "./core/vault-transport.ts";

export type ReleaseStep = "preconditions" | "tag" | "push-branch" | "push-tag" | "github-release";

export interface ReleaseProjectInput {
  factory: Factory;
  stateDir: string;
  projectSlug: string;
  projectRoot: string;
  version: string;
  runner?: VaultRunner;
}

export type ReleaseProjectResult =
  | {
      ok: true;
      version: string;
      tag: string;
      commit: string;
      branch: string;
      url: string | null;
      mode: ProjectReleaseMode;
      skipped: string[];
    }
  | {
      ok: false;
      step: ReleaseStep;
      code: string;
      message: string;
    };

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IDENTITY_ERROR_PATTERN = /identity unknown|unable to auto-detect email|please tell me who you are/i;
const NON_FF_ERROR_PATTERN = /non-fast-forward|fetch first|tip of your current branch is behind|remote contains work that you do not have/i;

function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v(?=\d)/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractChangelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRegExp(version)}\\]?(?:\\s|$|[-–—])`);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body !== "" ? body : lines[start]!.trim();
}

function hasRunningGateInLedger(events: readonly LedgerEvent[]): boolean {
  const resetIdx = events.findLastIndex((e) => (e as { event: string }).event === "project_reset");
  const active = events.slice(resetIdx + 1);
  const contracts = new Map<string, number>();
  const finished = new Set<string>();
  const started: Array<{ task: string; attempt: number; seq: number }> = [];
  for (const evt of active) {
    if (evt.event === "contract_set") {
      contracts.set(evt.task, evt.seq);
    } else if (evt.event === "gate_started") {
      started.push({ task: evt.task, attempt: evt.attempt, seq: evt.seq });
    } else if (evt.event === "gate_finished") {
      finished.add(`${evt.task}:${evt.attempt}:${contracts.get(evt.task) ?? 0}`);
    }
  }
  return started.some((s) => {
    const contractSeq = contracts.get(s.task) ?? 0;
    return s.seq >= contractSeq && !finished.has(`${s.task}:${s.attempt}:${contractSeq}`);
  });
}

function lastAcceptedLandingSha(events: readonly LedgerEvent[]): string | undefined {
  const resetIdx = events.findLastIndex((e) => (e as { event: string }).event === "project_reset");
  const active = events.slice(resetIdx + 1);
  const latestContractByTask = new Map<string, Extract<LedgerEvent, { event: "contract_set" }>>();
  const gateShaByKey = new Map<string, string>();
  let lastLandedSha: string | undefined;

  for (const evt of active) {
    if (evt.event === "contract_set") {
      latestContractByTask.set(evt.task, evt);
    } else if (evt.event === "gate_finished" && evt.verdict === "green" && typeof evt.sha === "string" && evt.sha !== "") {
      const contractSeq = latestContractByTask.get(evt.task)?.seq ?? 0;
      gateShaByKey.set(`${evt.task}:${evt.attempt}:${contractSeq}`, evt.sha);
    } else if (evt.event === "attempt_accepted") {
      if (evt.landing === "pending-conflict") continue;
      const contract = latestContractByTask.get(evt.task);
      if (contract !== undefined && isReadOnlyPeerDisposition(contract.disposition)) continue;
      const key = `${evt.task}:${evt.attempt}:${contract?.seq ?? 0}`;
      const sha = gateShaByKey.get(key);
      if (sha !== undefined) lastLandedSha = sha;
    }
  }
  return lastLandedSha;
}

async function runCli(
  runner: VaultRunner,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ ok: true; stdout: string } | { ok: false; error: unknown; message: string }> {
  try {
    const out = await runner({ command, args, cwd });
    return { ok: true, stdout: out.toString("utf8") };
  } catch (error) {
    return { ok: false, error, message: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveLandingCommit(
  runner: VaultRunner,
  projectRoot: string,
  claimedCommit: string,
  headCommit: string,
): Promise<string | undefined> {
  const ancestor = await runCli(runner, "git", ["merge-base", "--is-ancestor", claimedCommit, headCommit], projectRoot);
  if (!ancestor.ok) return undefined;
  if (claimedCommit === headCommit) return claimedCommit;

  const merges = await runCli(runner, "git", ["rev-list", "--merges", "--parents", headCommit], projectRoot);
  if (merges.ok) {
    for (const line of merges.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && parts.slice(1).includes(claimedCommit)) {
        return parts[0]!;
      }
    }
  }
  return claimedCommit;
}

async function resolveEffectiveBranch(
  runner: VaultRunner,
  projectRoot: string,
  configuredBranch: string | undefined,
  checkedOutBranch: string,
): Promise<string> {
  if (configuredBranch !== undefined && configuredBranch.trim() !== "") return configuredBranch.trim();

  const ghView = await runCli(runner, "gh", ["repo", "view", "--json", "defaultBranchRef"], projectRoot);
  if (ghView.ok) {
    try {
      const parsed = JSON.parse(ghView.stdout) as { defaultBranchRef?: { name?: unknown } | null };
      if (typeof parsed.defaultBranchRef?.name === "string" && parsed.defaultBranchRef.name.trim() !== "") {
        return parsed.defaultBranchRef.name.trim();
      }
    } catch {
      // fall through
    }
  }

  const originHead = await runCli(runner, "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], projectRoot);
  if (originHead.ok && originHead.stdout.trim() !== "") {
    const trimmed = originHead.stdout.trim();
    return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
  }

  return checkedOutBranch;
}

export type RepoIntegrityResult =
  | { ok: true; branch: string; commit: string }
  | { ok: false; code: string; message: string };

/**
 * Verifies `<project-root>` is clean, non-detached, has no running Contract
 * Gate, and `HEAD` equals the last accepted landing or descends from it only
 * through seat-memory commits. Shared by `releaseProject` and `storeReleaseProject`.
 */
export async function checkRepoReleaseIntegrity(input: {
  factory: Factory;
  projectRoot: string;
  runner?: VaultRunner;
}): Promise<RepoIntegrityResult> {
  const runner = input.runner ?? builtinVaultRunner;

  const statusRes = await runCli(runner, "git", ["status", "--porcelain"], input.projectRoot);
  if (!statusRes.ok) {
    return { ok: false, code: "root-dirty", message: `could not read repository status: ${statusRes.message}` };
  }
  if (statusRes.stdout.trim() !== "") {
    return { ok: false, code: "root-dirty", message: "<project-root> has uncommitted or untracked changes — clean the tree before releasing." };
  }

  const branchRes = await runCli(runner, "git", ["symbolic-ref", "--short", "HEAD"], input.projectRoot);
  if (!branchRes.ok || branchRes.stdout.trim() === "") {
    return { ok: false, code: "root-detached", message: "<project-root> HEAD is detached — check out a branch before releasing." };
  }
  const checkedOutBranch = branchRes.stdout.trim();

  const headRes = await runCli(runner, "git", ["rev-parse", "HEAD"], input.projectRoot);
  if (!headRes.ok || headRes.stdout.trim() === "") {
    return { ok: false, code: "root-detached", message: "could not resolve HEAD commit" };
  }
  const headCommit = headRes.stdout.trim();

  if (hasRunningGateInLedger(input.factory.ledger.events)) {
    return { ok: false, code: "gate-running", message: "a Contract Gate is currently running for this Project — wait for its verdict before releasing." };
  }

  const claimedCommit = lastAcceptedLandingSha(input.factory.ledger.events);
  if (claimedCommit === undefined) {
    return { ok: false, code: "head-not-accepted", message: "no accepted wave landing exists in this Project's Ledger — land an engineer wave first." };
  }
  const landingCommit = await resolveLandingCommit(runner, input.projectRoot, claimedCommit, headCommit);
  if (landingCommit === undefined) {
    return {
      ok: false,
      code: "head-not-accepted",
      message: `HEAD (${headCommit.slice(0, 7)}) does not descend from the last accepted landing (${claimedCommit.slice(0, 7)}).`,
    };
  }
  if (landingCommit !== headCommit) {
    const postCommits = await runCli(runner, "git", ["log", "--format=", "--name-only", `${landingCommit}..${headCommit}`], input.projectRoot);
    if (!postCommits.ok) {
      return { ok: false, code: "head-not-accepted", message: `could not inspect commits since last landing: ${postCommits.message}` };
    }
    const touched = postCommits.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const nonMemory = touched.filter((file) => !isSeatMemoryRelativePathAllowed(file));
    if (nonMemory.length > 0) {
      return {
        ok: false,
        code: "head-not-accepted",
        message: `HEAD has unaccepted product changes since the last landing: ${nonMemory.slice(0, 5).join(", ")}`,
      };
    }
  }

  return { ok: true, branch: checkedOutBranch, commit: headCommit };
}

export async function releaseProject(input: ReleaseProjectInput): Promise<ReleaseProjectResult> {
  const runner = input.runner ?? builtinVaultRunner;
  const cleanVersion = normalizeVersion(input.version);
  if (!SEMVER_PATTERN.test(cleanVersion)) {
    return {
      ok: false,
      step: "preconditions",
      code: "invalid-release-version",
      message: `invalid semver version "${input.version}" — expected X.Y.Z`,
    };
  }
  const tag = `v${cleanVersion}`;

  const preFail = (code: string, message: string): ReleaseProjectResult => ({
    ok: false,
    step: "preconditions",
    code,
    message,
  });

  // 1. Release mode & pending Request
  const settings = readReleaseSettings(input.stateDir, input.projectSlug);
  if (settings.mode === "off") {
    return preFail("release-not-granted", "Release mode is off for this Project; the Owner must enable on-request or auto in Project settings.");
  }
  if (settings.mode === "on-request") {
    const pending = readReleaseRequest(input.stateDir, input.projectSlug);
    if (pending === undefined) {
      return preFail("no-release-intent", "Release mode is on-request and there is no pending Release request from the Owner.");
    }
    if (pending.version !== undefined && normalizeVersion(pending.version) !== cleanVersion) {
      return preFail(
        "version-mismatch",
        `pending Release request pins version ${pending.version}, which does not match requested ${cleanVersion}`,
      );
    }
  }

  // 2. origin exists
  const originRes = await runCli(runner, "git", ["remote", "get-url", "origin"], input.projectRoot);
  if (!originRes.ok || originRes.stdout.trim() === "") {
    return preFail("no-origin", "Project has no `origin` remote — publish it to GitHub from the panel first.");
  }

  // 3–5. Repo clean, non-detached, no running gate, accepted HEAD
  const integrity = await checkRepoReleaseIntegrity({ factory: input.factory, projectRoot: input.projectRoot, runner });
  if (!integrity.ok) {
    return preFail(integrity.code, integrity.message);
  }
  const checkedOutBranch = integrity.branch;
  const headCommit = integrity.commit;

  // 6. CHANGELOG.md, if present, has ## [x.y.z]
  let notes: string | undefined;
  const changelogPath = join(input.projectRoot, "CHANGELOG.md");
  if (existsSync(changelogPath)) {
    const changelogText = readFileSync(changelogPath, "utf8");
    notes = extractChangelogSection(changelogText, cleanVersion);
    if (notes === undefined) {
      return preFail("changelog-missing-section", `CHANGELOG.md exists but has no \`## [${cleanVersion}]\` section.`);
    }
  }

  // 7. In auto mode, product paths must have changed since the last v* tag
  if (settings.mode === "auto") {
    const tagsRes = await runCli(runner, "git", ["tag", "--list", "v*", "--merged", headCommit, "--sort=-v:refname"], input.projectRoot);
    const prevTag = tagsRes.ok
      ? tagsRes.stdout.split(/\r?\n/).map((t) => t.trim()).find((t) => t !== "" && t !== tag)
      : undefined;
    let changedFiles: string[] = [];
    if (prevTag !== undefined) {
      const diffRes = await runCli(runner, "git", ["diff", "--name-only", `${prevTag}..${headCommit}`], input.projectRoot);
      if (diffRes.ok) {
        changedFiles = diffRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      }
    } else {
      const lsRes = await runCli(runner, "git", ["ls-files"], input.projectRoot);
      if (lsRes.ok) {
        changedFiles = lsRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      }
    }
    const productChanges = changedFiles.filter((file) => !isSeatMemoryRelativePathAllowed(file));
    if (productChanges.length === 0) {
      return preFail(
        "nothing-to-release",
        prevTag !== undefined
          ? `no product changes landed since tag ${prevTag}`
          : "no product changes exist to release",
      );
    }
  }

  const branch = await resolveEffectiveBranch(runner, input.projectRoot, settings.branch, checkedOutBranch);
  const skipped: string[] = [];

  const recordStepFailure = (step: Exclude<ReleaseStep, "preconditions">, code: string, message: string): ReleaseProjectResult => {
    input.factory.ledger.append({
      event: "release_failed",
      version: cleanVersion,
      step,
      code,
      detail: message,
    });
    return { ok: false, step, code, message };
  };

  // Step 1: annotated tag vX.Y.Z on HEAD
  const verifyLocalTag = await runCli(runner, "git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], input.projectRoot);
  if (verifyLocalTag.ok && verifyLocalTag.stdout.trim() !== "") {
    const taggedCommitRes = await runCli(runner, "git", ["rev-list", "-n", "1", tag], input.projectRoot);
    const taggedCommit = taggedCommitRes.ok ? taggedCommitRes.stdout.trim() : "";
    if (taggedCommit === headCommit) {
      skipped.push("tag");
    } else {
      return recordStepFailure("tag", "tag-conflict", `tag ${tag} already exists on commit ${taggedCommit || "unknown"}, not HEAD (${headCommit})`);
    }
  } else {
    let tagRes = await runCli(runner, "git", ["tag", "-a", tag, "-m", `Release ${tag}`], input.projectRoot);
    if (!tagRes.ok && IDENTITY_ERROR_PATTERN.test(tagRes.message)) {
      tagRes = await runCli(
        runner,
        "git",
        ["-c", "user.name=Factory", "-c", "user.email=factory@local", "tag", "-a", tag, "-m", `Release ${tag}`],
        input.projectRoot,
      );
    }
    if (!tagRes.ok) {
      return recordStepFailure("tag", "tag-conflict", `failed to create tag ${tag}: ${tagRes.message}`);
    }
  }

  // Step 2: fast-forward push HEAD to Release branch on origin
  const remoteBranchRes = await runCli(runner, "git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], input.projectRoot);
  const remoteBranchSha = remoteBranchRes.ok
    ? remoteBranchRes.stdout.trim().split(/\s+/)[0] ?? ""
    : "";
  if (remoteBranchSha === headCommit) {
    skipped.push("push-branch");
  } else {
    const pushBranchRes = await runCli(runner, "git", ["push", "origin", `HEAD:refs/heads/${branch}`], input.projectRoot);
    if (!pushBranchRes.ok) {
      const code = NON_FF_ERROR_PATTERN.test(pushBranchRes.message) ? "release-not-fast-forward" : "push-rejected";
      return recordStepFailure("push-branch", code, `failed to push HEAD to ${branch}: ${pushBranchRes.message}`);
    }
  }

  // Step 3: push tag to origin
  const remoteTagRes = await runCli(
    runner,
    "git",
    ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    input.projectRoot,
  );
  let remoteTagCommit = "";
  if (remoteTagRes.ok && remoteTagRes.stdout.trim() !== "") {
    const lines = remoteTagRes.stdout.trim().split(/\r?\n/);
    const peeled = lines.find((line) => line.endsWith("^{}"));
    const chosen = peeled ?? lines[0];
    remoteTagCommit = chosen?.trim().split(/\s+/)[0] ?? "";
  }
  if (remoteTagCommit !== "") {
    if (remoteTagCommit === headCommit) {
      skipped.push("push-tag");
    } else {
      return recordStepFailure(
        "push-tag",
        "tag-conflict",
        `remote tag ${tag} already exists on commit ${remoteTagCommit}, not HEAD (${headCommit})`,
      );
    }
  } else {
    const pushTagRes = await runCli(runner, "git", ["push", "origin", `refs/tags/${tag}`], input.projectRoot);
    if (!pushTagRes.ok) {
      const code = /already exists|cannot lock ref/i.test(pushTagRes.message) ? "tag-conflict" : "push-rejected";
      return recordStepFailure("push-tag", code, `failed to push tag ${tag}: ${pushTagRes.message}`);
    }
  }

  // Step 4: gh release create
  let releaseUrl: string | null = null;
  const viewRes = await runCli(runner, "gh", ["release", "view", tag, "--json", "url"], input.projectRoot);
  if (viewRes.ok) {
    skipped.push("github-release");
    try {
      const parsed = JSON.parse(viewRes.stdout) as { url?: unknown };
      if (typeof parsed.url === "string" && parsed.url.trim() !== "") {
        releaseUrl = parsed.url.trim();
      }
    } catch {
      // ignore unparseable URL
    }
  } else if (isGhMissingError(viewRes.error)) {
    return recordStepFailure("github-release", "gh-unavailable", `gh CLI is unavailable: ${viewRes.message}`);
  } else if (isGhUnauthenticatedError(viewRes.error)) {
    return recordStepFailure("github-release", "gh-unauthenticated", `gh CLI is not authenticated: ${viewRes.message}`);
  } else {
    const createArgs = [
      "release",
      "create",
      tag,
      "--title",
      tag,
      ...(notes !== undefined ? ["--notes", notes] : ["--generate-notes"]),
    ];
    const createRes = await runCli(runner, "gh", createArgs, input.projectRoot);
    if (!createRes.ok) {
      const code = isGhMissingError(createRes.error)
        ? "gh-unavailable"
        : isGhUnauthenticatedError(createRes.error)
          ? "gh-unauthenticated"
          : "release-create-failed";
      return recordStepFailure("github-release", code, `gh release create failed: ${createRes.message}`);
    }
    const urlLine = createRes.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("http"))
      .at(-1);
    releaseUrl = urlLine ?? null;
  }

  if (settings.mode === "on-request") {
    clearReleaseRequest(input.stateDir, input.projectSlug);
  }
  input.factory.ledger.append({
    event: "release_published",
    version: cleanVersion,
    tag,
    commit: headCommit,
    branch,
    url: releaseUrl,
    mode: settings.mode,
    skipped,
  });

  return {
    ok: true,
    version: cleanVersion,
    tag,
    commit: headCommit,
    branch,
    url: releaseUrl,
    mode: settings.mode,
    skipped,
  };
}
