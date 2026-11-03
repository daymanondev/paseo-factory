import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { landTaskWorktree, prepareTaskWorktree, reapWorktreeProcesses } from "../src/workspace.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

test("worktree reaper escalates surviving Task processes and excludes sibling, own, parent and infrastructure processes", () => {
  const path = resolve("/state/projects/demo/worktrees/T-04");
  const alive = new Set([41001, 41002]);
  const signals: [number, string | number][] = [];
  const waits: number[] = [];
  const count = reapWorktreeProcesses(path, {
    inspect: () => [
      `41001 postgres -D ${path}/db`, `41002 node ${path}/server.mjs`,
      `41003 node ${path}-sibling/server.mjs`, `41004 node /unrelated/server.mjs`,
      `41005 node /other${path}/server.mjs`,
      `${process.pid} node ${path}/test.mjs`, `${process.ppid} node ${path}/parent.mjs`,
      ...["/usr/local/bin/paseo", "Paseo.app", "Paseo Helper", "paseo-factory/bin/run", "runtime-bin/run", "bridge.mjs", "driver.mjs", "factory.mjs", "claim.mjs", "plugin-process", "opencode"].map((binary, i) => `${42000 + i} ${binary} --cwd=${path}`),
    ].join("\n"),
    signal: (pid: number, signal: string | number) => {
      signals.push([pid, signal]);
      if (signal === "SIGTERM" && pid === 41001) alive.delete(pid);
      if (signal === 0 && !alive.has(pid)) throw new Error("ESRCH");
    },
    wait: (ms: number) => waits.push(ms),
  });
  assert.equal(count, 2);
  assert.deepEqual(signals.filter(([, signal]) => signal !== 0), [[41001, "SIGTERM"], [41002, "SIGTERM"], [41002, "SIGKILL"]]);
  assert.deepEqual(waits, [150]);
});

for (const operation of ["landing", "reset"] as const) {
  test(`${operation} reaps detached worktree services before directory removal`, { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
    const dir = makeTempDir("factory-reap-");
    disposeDir(t, dir);
    const root = join(dir, "repo");
    mkdirSync(root);
    writeFileSync(join(root, "app.txt"), "base\n");
    const base = gitCommitAll(root);
    const options = { stateDir: join(dir, "state"), workspace: root, task: "T-04", base };
    const prepared = prepareTaskWorktree(options);
    assert.ok(prepared.ok);
    const marker = join(dir, "terminated.json");
    const child = spawn(process.execPath, ["-e", `
      const fs = require('node:fs');
      process.on('SIGTERM', () => { fs.writeFileSync(process.argv[2], JSON.stringify({ existed: fs.existsSync(process.argv[1]) })); });
      setInterval(() => {}, 1000);
      console.log('ready');
    `, prepared.path, marker], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { try { child.kill("SIGKILL"); } catch {} });
    await once(child.stdout!, "data");
    const closed = once(child, "close");
    if (operation === "landing") {
      assert.equal((await landTaskWorktree({ projectRoot: root, worktree: prepared.path, claimedCommit: base, base, branch: prepared.branch })).landing, "landed");
      assert.equal(existsSync(prepared.path), false);
    } else {
      const reset = prepareTaskWorktree(options);
      assert.ok(reset.ok && reset.reset);
    }
    // The TERM handler records that cleanup happened while the worktree still existed;
    // this stubborn service then requires KILL to release its resources.
    assert.deepEqual(readFileSync(marker, "utf8"), '{"existed":true}');
    assert.deepEqual(await closed, [null, "SIGKILL"]);
  });
}
