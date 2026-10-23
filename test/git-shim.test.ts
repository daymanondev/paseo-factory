import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createFactory } from "../src/factory.ts";
import { refuseGitArgv } from "../src/choke.ts";
import { refuseGitArgv as mirrorRefuseGitArgv } from "../plugin/bin/git-refusals.mjs";
import { ensureGitShim } from "../plugin/server/shell.ts";
import { disposeDir, gitCommitAll, gitCommitChanges, makeTempDir, repoRoot } from "./helpers.ts";
import { GIT_ARGV_CASES } from "./choke-cases.ts";

/**
 * The git shim itself (`plugin/bin/git-shim.mjs`), hermetic: the "real git"
 * it passes through to is a stub script that records its argv and exits with a
 * scripted code — no daemon, no live git, no network. Plus the drift guard:
 * the plain-JS refusal mirror must answer the shared case table exactly as
 * `src/choke.ts` does.
 */

const shim = join(repoRoot, "plugin", "bin", "git-shim.mjs");
const REFUSAL_EXIT = 126;

interface Stage {
  dir: string;
  stateDir: string;
  workspace: string;
  fakeBin: string;
  /** Runs the shim with argv, in the workspace, with the fake bin on PATH. */
  run: (argv: string[]) => { status: number | null; stdout: string; stderr: string };
  logLines: () => unknown[];
}

/**
 * The stage: a state dir (the shim's log lands there), a workspace, and a
 * fakeBin holding the "real git" — an executable stub that appends its argv
 * to a file and exits 0 (or 7 with --exit-seven, to prove code passthrough).
 */
function stage(t: TestContext): Stage {
  const dir = makeTempDir("git-shim-test-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const workspace = join(dir, "ws");
  const fakeBin = join(dir, "fake-bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  const callsFile = join(dir, "stub-calls.log");
  const stub = join(fakeBin, "git");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}`,
      'if [ "$1" = "--exit-seven" ]; then exit 7; fi',
      "echo STUB-OK",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  const env = { ...process.env, FACTORY_STATE_DIR: stateDir, PATH: `${fakeBin}`, PASEO_AGENT_ID: "shim-test-agent" };
  return {
    dir,
    stateDir,
    workspace,
    fakeBin,
    run: (argv) => {
      const result = spawnSync(process.execPath, [shim, ...argv], { cwd: workspace, encoding: "utf8", env, timeout: 30_000 });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    logLines: () => {
      const path = join(stateDir, "git-blocked.log");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8").trimEnd().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
    },
  };
}

test("the plain-JS refusal mirror answers the shared table exactly as src/choke.ts does", () => {
  for (const { argv, rule } of GIT_ARGV_CASES) {
    const original = refuseGitArgv(argv);
    const mirror = mirrorRefuseGitArgv(argv);
    assert.equal(mirror?.rule ?? null, original?.rule ?? null, `"git ${argv.join(" ")}" — mirror and original disagree`);
    if (original !== undefined) {
      assert.equal(mirror?.reason, original.reason, `"git ${argv.join(" ")}" — mirror and original reasons disagree`);
    }
  }
});

test("a dangerous argv refuses pre-exec: exit 126, the refusal stderr, one log line", (t) => {
  const s = stage(t);
  const result = s.run(["push", "--force", "origin", "main"]);

  assert.equal(result.status, REFUSAL_EXIT, "the refusal exit is distinct from git's own 128 fatals");
  assert.match(result.stderr, /paseo-factory refused/);
  assert.match(result.stderr, /git:force-push/);
  assert.match(result.stderr, /nothing was executed/);

  const lines = s.logLines();
  assert.equal(lines.length, 1, "exactly one log line per refusal");
  const line = lines[0] as Record<string, string>;
  assert.equal(line.rule, "git:force-push");
  assert.equal(line.command, "git push --force origin main");
  assert.equal(line.cwd, realpathSync(s.workspace), "macOS resolves /var to /private/var — compare the real path");
  assert.equal(line.agent, "shim-test-agent");
  assert.match(line.id, /^[^-]+-[^-]+-/, "the line carries the ingestion dedupe id");
  assert.doesNotMatch(result.stderr, /STUB-OK/, "the real git stub never ran");
});

test("a benign argv passes through untouched: same argv at the real git, same exit code", (t) => {
  const s = stage(t);

  const ok = s.run(["status", "--short"]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /STUB-OK/);
  const calls = readFileSync(join(s.dir, "stub-calls.log"), "utf8").trimEnd().split("\n");
  assert.equal(calls.at(-1), "status --short", "the stub received the exact argv");
  assert.equal(s.logLines().length, 0, "no refusal, no log line");

  const failing = s.run(["--exit-seven", "push", "origin", "main"]);
  assert.equal(failing.status, 7, "the real git's exit code propagates through the shim");
  assert.equal(s.logLines().length, 0, "plain push never refuses");
});

test("the shim finds git by absolute fallback when PATH holds nothing but itself", (t) => {
  const s = stage(t);
  // The absolute fallbacks are real system paths (/opt/homebrew, /usr/local,
  // /usr/bin) — this machine and CI both carry /usr/bin/git. Prove the
  // fallback engaged by emptying PATH except the stub's own dir.
  const result = spawnSync(process.execPath, [shim, "--version"], {
    cwd: s.workspace,
    encoding: "utf8",
    env: { ...process.env, FACTORY_STATE_DIR: s.stateDir, PATH: join(s.dir, "empty-bin") },
    timeout: 30_000,
  });
  mkdirSync(join(s.dir, "empty-bin"), { recursive: true }); // created after, so PATH truly had nothing runnable
  assert.equal(result.status, 0, `a PATH with no git must still answer --version via the fallbacks: ${result.stderr}`);
  assert.match(result.stdout, /git version/);
});

test("the shim refuses to guess without FACTORY_STATE_DIR", () => {
  const result = spawnSync(process.execPath, [shim, "status"], {
    encoding: "utf8",
    env: { ...process.env, FACTORY_STATE_DIR: "", PATH: "/usr/bin:/bin" },
    timeout: 30_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /FACTORY_STATE_DIR/);
});

test("two refusals append two independent lines — concurrent shims never interleave", (t) => {
  const s = stage(t);
  s.run(["reset", "--hard"]);
  s.run(["branch", "-D", "old"]);
  const lines = s.logLines() as Record<string, string>[];
  assert.deepEqual(lines.map((l) => l.rule), ["git:reset-hard", "git:branch-D"]);
  assert.notEqual(lines[0]!.id, lines[1]!.id);
});

test("the full refusal table refuses through the real shim, and nothing else does", (t) => {
  const s = stage(t);
  for (const { argv, rule } of GIT_ARGV_CASES) {
    rmSync(join(s.stateDir, "git-blocked.log"), { force: true });
    const result = s.run([...argv]);
    const lines = s.logLines() as Record<string, string>[];
    if (rule === null) {
      assert.equal(result.status, 0, `"git ${argv.join(" ")}" must pass through to the stub`);
      assert.equal(lines.length, 0, `"git ${argv.join(" ")}" writes no log line`);
    } else {
      assert.equal(result.status, REFUSAL_EXIT, `"git ${argv.join(" ")}" refuses at exec time`);
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.rule, rule, `"git ${argv.join(" ")}" refusal rule`);
    }
  }
});

test("through the generated wrapper, pass-through does not recurse into itself", (t) => {
  // The regression this pins: the wrapper execs the shim with argv[1] = the
  // script path, so the shim's own dir is NOT dirname(argv[1]) — it is the
  // wrapper's dir under FACTORY_STATE_DIR/bin. Without skipping it, the shim
  // resolves ITSELF as "real git" and recurses forever (found live: the
  // battery's control arm hung to its 60s timeout).
  const dir = makeTempDir("git-shim-recursion-test-");
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const stubBin = join(dir, "stub-bin");
  mkdirSync(stubBin, { recursive: true });
  const callsFile = join(dir, "stub-calls.log");
  const stub = join(stubBin, "git");
  writeFileSync(stub, `#!/bin/sh\necho STUB-OK\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}\nexit 0\n`);
  chmodSync(stub, 0o755);
  ensureGitShim(stateDir, join(repoRoot, "plugin"), process.execPath);

  const result = spawnSync(join(stateDir, "bin", "git"), ["status", "--short"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, PATH: `${join(stateDir, "bin")}${delimiter ?? ":"}${stubBin}` },
  });
  assert.equal(result.status, 0, `pass-through through the wrapper: ${result.stderr}`);
  assert.match(result.stdout ?? "", /STUB-OK/);
  assert.equal(readFileSync(callsFile, "utf8").trimEnd(), "status --short", "the stub — not the shim again — served the call");
});

test("the generated wrapper shape matches the claim CLI's law (shell wrapper, baked state dir)", (t) => {
  // Sanity on the generation contract tested further in shell.test.ts: the
  // shim must be reachable as plain `git` through a wrapper, which means the
  // shim itself never depends on cwd or a specific node — FACTORY_STATE_DIR
  // and argv are its whole world. Executed here through a wrapper literally
  // named `git` on a PATH, the way agents reach it.
  const dir = makeTempDir("git-shim-wrapper-test-");
  disposeDir(t, dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, "git");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 FACTORY_STATE_DIR=${JSON.stringify(join(dir, "state"))} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(shim)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  const refused = spawnSync(wrapper, ["clean", "-fd"], { env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` }, encoding: "utf8" });
  assert.equal(refused.status, REFUSAL_EXIT, "the wrapper reaches the shim exactly as agents reach it");
  const lines = readFileSync(join(dir, "state", "git-blocked.log"), "utf8").trimEnd().split("\n");
  assert.equal((JSON.parse(lines[0]!) as Record<string, string>).rule, "git:clean-force");
});


test("installed agent git shim accepts glob scopes and gives branch-base recovery for staged or committed violations", (t) => {
  const dir = makeTempDir("git-shim-scope-");
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "main.ts"), "export const main = 1;\n");
  writeFileSync(join(workspace, "README.md"), "original\n");
  const base = gitCommitAll(workspace);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  factory.setContract({ task: "GLOB", workspace, gate: "true", artifact: "src/main.ts", scope: ["src/**/*.ts"] });
  ensureGitShim(stateDir, join(repoRoot, "plugin"), process.execPath);
  const run = (args: string[]) => spawnSync(join(stateDir, "bin", "git"), args, {
    cwd: workspace, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PASEO_FACTORY_SEAT: "agent", PASEO_FACTORY_TASK: "GLOB" },
  });
  writeFileSync(join(workspace, "src", "main.ts"), "export const main = 2;\n");
  writeFileSync(join(workspace, "README.md"), "out of scope\n");
  execFileSync("git", ["add", "."], { cwd: workspace });
  const staged = run(["commit", "-m", "bad staged file"]);
  assert.equal(staged.status, 126, staged.stderr);
  assert.ok(staged.stderr.includes(`git restore --source=${base} -- README.md`), staged.stderr);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(), base);
  gitCommitChanges(workspace, "simulate file already committed outside shim");
  const committed = run(["commit", "--allow-empty", "-m", "still bad branch range"]);
  assert.equal(committed.status, 126, committed.stderr);
  assert.ok(committed.stderr.includes(`git restore --source=${base} -- README.md`), committed.stderr);
  assert.equal(run(["restore", `--source=${base}`, "--", "README.md"]).status, 0);
  assert.equal(run(["add", "README.md"]).status, 0);
  const repaired = run(["commit", "-m", "restore from branch base"]);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.deepEqual(execFileSync("git", ["diff", "--name-only", base, "HEAD"], { cwd: workspace, encoding: "utf8" }).trim().split("\n"), ["src/main.ts"]);
  const records = readFileSync(join(stateDir, "git-blocked.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.rule === "out-of-scope"));
  writeFileSync(join(workspace, "README.md"), "unstaged outside scope\n");
  writeFileSync(join(workspace, "src", "main.ts"), "export const main = 3;\n");
  assert.equal(run(["add", "src/main.ts"]).status, 0);
  const scopedOnly = run(["commit", "-mplain"]);
  assert.equal(scopedOnly.status, 0, scopedOnly.stderr);
  for (const args of [["commit", "-am", "all tracked files"], ["commit", "-m", "explicit path", "--", "README.md"]]) {
    const refused = run(args);
    assert.equal(refused.status, 126, refused.stderr);
    assert.ok(refused.stderr.includes(`git restore --source=${base} -- README.md`), refused.stderr);
  }
  gitCommitChanges(workspace, "simulate a second earlier out-of-scope commit");
  assert.equal(run(["restore", `--source=${base}`, "--", "README.md"]).status, 0);
  assert.equal(run(["add", "README.md"]).status, 0);
  writeFileSync(join(workspace, "src", "main.ts"), "export const main = 4;\n");
  const excludedRepair = run(["commit", "-m", "repair excluded by pathspec", "--", "src/main.ts"]);
  assert.equal(excludedRepair.status, 126, excludedRepair.stderr);
});
