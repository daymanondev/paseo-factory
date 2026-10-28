import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, disposeDir } from "./helpers.ts";

test(
  "actual plugin reports a late Scrum completion once without restarting",
  { timeout: 12000 },
  (t) => {
    const home = makeTempDir();
    disposeDir(t, home);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PASEO_HOME: join(home, "trial"),
    };
    delete env.NODE_TEST_CONTEXT;
    const out = execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./fixtures/scrum-live-recovery.ts", import.meta.url),
        ),
      ],
      { env, encoding: "utf8", timeout: 10000 },
    );
    assert.match(out, /SCRUM_LIVE_RECOVERY_OK/);
  },
);
