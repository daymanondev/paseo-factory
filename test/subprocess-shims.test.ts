import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

const wrappers = [
  { name: "exec", tool: "gh", script: "exec-shim.mjs" },
  { name: "git", tool: "git", script: "git-shim.mjs" },
];
// Full-suite process contention can delay Node startup; readiness still drives signalling.
const FIXTURE_TIMEOUT_MS = 10_000;

function stage(t: TestContext, wrapper: typeof wrappers[number]) {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const executable = join(bin, wrapper.tool);
  const installed = join(dir, "installed-bin");
  cpSync(join(repoRoot, "plugin/bin"), installed, { recursive: true });
  writeFileSync(executable, `#!${process.execPath}
    const [mode, value] = process.argv.slice(2);
    if (mode === "signal") process.kill(process.pid, value);
    else if (mode === "wait") {
      setInterval(() => {}, 1000);
      console.log(process.pid);
    } else process.exit(Number(value));
  `, { mode: 0o755 });
  const env = { ...process.env, PATH: bin, FACTORY_STATE_DIR: join(dir, "state"), PASEO_FACTORY_SEAT: "", PASEO_FACTORY_CORRELATION: "" };
  const wrappedArgs = [join(installed, wrapper.script), ...(wrapper.name === "exec" ? [wrapper.tool] : [])];
  return { executable, env, wrappedArgs };
}

for (const wrapper of wrappers) {
  for (const outcome of [0, 7, "SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`${wrapper.name} shim preserves direct child outcome ${outcome}`, { skip: process.platform === "win32" }, (t) => {
      const { executable, env, wrappedArgs } = stage(t, wrapper);
      const args = [typeof outcome === "number" ? "exit" : "signal", String(outcome)];
      const direct = spawnSync(executable, args, { env, timeout: FIXTURE_TIMEOUT_MS });
      const wrapped = spawnSync(process.execPath, [...wrappedArgs, ...args], { env, timeout: FIXTURE_TIMEOUT_MS });

      assert.equal(direct.error, undefined);
      assert.equal(wrapped.error, undefined);
      assert.equal(direct.status, typeof outcome === "number" ? outcome : null);
      assert.equal(direct.signal, typeof outcome === "number" ? null : outcome);
      assert.equal(wrapped.status, direct.status);
      assert.equal(wrapped.signal, direct.signal);
    });
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`${wrapper.name} shim forwards ${signal} and preserves signal termination`, { skip: process.platform === "win32" }, async (t) => {
      const { executable, env, wrappedArgs } = stage(t, wrapper);
      const run = async (command: string, args: string[]) => {
        const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let signalled = false;
        const killFixture = () => {
          const fixturePid = Number(output.trim());
          if (Number.isInteger(fixturePid) && fixturePid > 0) {
            try { process.kill(fixturePid, "SIGKILL"); } catch { /* already dead */ }
          }
          child.kill("SIGKILL");
        };
        t.after(killFixture);
        const timer = setTimeout(killFixture, FIXTURE_TIMEOUT_MS);
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (!signalled && output.includes("\n")) {
            signalled = true;
            child.kill(signal);
          }
        });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code, signal) => resolve({ code, signal }));
        }).finally(() => clearTimeout(timer));
        assert.equal(signalled, true, "fixture reached its ready state before signalling");
        return result;
      };
      const direct = await run(executable, ["wait"]);
      const wrapped = await run(process.execPath, [...wrappedArgs, "wait"]);
      assert.deepEqual(direct, { code: null, signal });
      assert.deepEqual(wrapped, direct);
    });
  }
}

test("npx shim permits MCP stdio servers for coordination seats and blocks general execution", (t) => {
  const { executable, env, wrappedArgs } = stage(t, { name: "exec", tool: "npx", script: "exec-shim.mjs" });
  writeFileSync(executable, `#!${process.execPath}\nconsole.log(process.argv.slice(2).join(' '));\n`, { mode: 0o755 });
  for (const seat of ["supervisor", "lead"]) {
    for (const pkg of ["chrome-devtools-mcp", "@notionhq/notion-mcp-server", "@z_ai/mcp-server", "@upstash/context7-mcp", "@modelcontextprotocol/server-filesystem@latest", "mcp-demo", "demo-mcp-server"]) {
      const result = spawnSync(process.execPath, [...wrappedArgs, "-y", pkg], { env: { ...env, PASEO_FACTORY_SEAT: seat }, encoding: "utf8" });
      assert.equal(result.status, 0, `${seat}: ${pkg}: ${result.stderr}`);
      assert.equal(result.stdout.trim(), `-y ${pkg}`);
    }
    for (const args of [["create-vite@latest"], ["tsx", "script.ts"], ["-p", "chrome-devtools-mcp", "tsx"], ["chrome-devtools-mcp", "--call=touch a"], ["./chrome-devtools-mcp"]]) {
      const result = spawnSync(process.execPath, [...wrappedArgs, ...args], { env: { ...env, PASEO_FACTORY_SEAT: seat }, encoding: "utf8" });
      assert.equal(result.status, 126, args.join(" "));
      assert.match(result.stderr, /seat-write-fence/);
    }
  }
});
