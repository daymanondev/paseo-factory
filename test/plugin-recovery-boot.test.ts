import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { disposeDir, makeTempDir } from "./helpers.ts";

for (const action of ["resume", "restore"]) for (const project of [false, true]) {
  test(`actual plugin boot keeps ${project ? "Project" : "root"} ${action} entrances alive and resumes deferred work`, { timeout: 15_000 }, (t) => {
    const dir = makeTempDir(); disposeDir(t, dir);
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/plugin-recovery-boot.ts", import.meta.url))], {
      env: { ...process.env, HOME: dir, PASEO_HOME: join(dir, "trial"), RECOVERY_ACTION: action, RECOVERY_PROJECT: project ? "yes" : "no" }, encoding: "utf8", timeout: 12_000,
    });
    assert.match(output, /RECOVERY_OK/);
  });
}

 test("actual recovery Spool answers refused controls without pre-existing reply infrastructure and still resumes", { timeout: 15_000 }, (t) => {
  const dir = makeTempDir(); disposeDir(t, dir);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/plugin-recovery-boot.ts", import.meta.url))], {
    env: { ...process.env, HOME: dir, PASEO_HOME: join(dir, "trial"), RECOVERY_ACTION: "resume", RECOVERY_PROJECT: "no", RECOVERY_NO_SPOOL: "yes" }, encoding: "utf8", timeout: 12_000,
  });
  assert.match(output, /RECOVERY_OK/);
});
