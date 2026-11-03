import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { judgeSeatShellCommand, judgeShellCommand, writableRootsFor } from "../src/choke.ts";

const projectRoot = "/workspace/project";
const stateDir = "/factory-state";
function hookDecision(seat: "supervisor" | "lead" | "agent", command: string): { decision: string; reason?: string } {
  return JSON.parse(execFileSync(process.execPath, [new URL("../plugin/bin/agy-pre-tool-hook.mjs", import.meta.url).pathname], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: projectRoot }),
    env: {
      PATH: process.env.PATH,
      PASEO_FACTORY_SEAT: seat,
      PASEO_FACTORY_STATE_DIR: stateDir,
      PASEO_FACTORY_PROJECT_ROOT: projectRoot,
    },
    encoding: "utf8",
  }));
}
const planningProse = [
  "touch implementation after approval",
  "install dependencies later",
  "rm obsolete source",
  "mv old new",
  "cp draft src/app.ts",
  "git reset --hard",
  "dd of=src/app.ts",
  "> Note: keep this decision",
  ">= 0.5 -> review",
].join("\n");

test("seat shell permission allows planning prose inside documentation heredocs", () => {
  for (const command of [
    `cat <<'EOF' > AGENTS.md\n${planningProse}\nEOF`,
    `cat <<EOF > CONTEXT.md\n${planningProse}\nEOF`,
    `tee .scratch/plan.md <<"EOF"\n${planningProse}\nEOF`,
    `cat <<-EOF > docs/notes.md\n\t${planningProse.replaceAll("\n", "\n\t")}\n\tEOF`,
  ]) {
    assert.deepEqual(judgeSeatShellCommand(command, projectRoot, stateDir), { behavior: "allow" }, command);
  }
});

test("seat shell permission keeps source redirects and executable interpreter heredocs fenced", () => {
  for (const command of [
    "cat <<'EOF' > src/app.ts\nhello\nEOF",
    "cat <<EOF | tee src/app.ts\nhello\nEOF",
    "cat <<EOF > docs/notes.md\nhello\nEOF\ntouch src/app.ts",
    "python3 - <<'PY'\nfrom pathlib import Path\nPath('src/app.ts').write_text('changed')\nPY",
    "node <<'JS'\nrequire('fs').writeFileSync('src/app.ts', 'changed')\nJS",
    "bash <<'EOF'\necho changed > src/app.ts\nEOF",
    "MODE=test env /usr/bin/python3 - <<'PY'\nopen('src/app.ts', 'w').write('changed')\nPY",
    "/usr/bin/env -i MODE=test /usr/bin/node <<'JS'\nrequire('fs').writeFileSync('src/app.ts', 'changed')\nJS",
    "cat <<EOF | /bin/bash\necho changed > src/app.ts\nEOF",
    "echo plan # <<EOF\ntouch src/app.ts\nEOF",
  ]) {
    const decision = judgeSeatShellCommand(command, projectRoot, stateDir);
    assert.equal(decision.behavior, "deny", command);
    assert.equal(decision.rule, "seat-write-fence", command);
  }
});

test("Antigravity permits Supervisor and Lead documentation heredocs with planning prose", () => {
  for (const seat of ["supervisor", "lead"] as const) {
    for (const command of [
      `cat <<'EOF' > AGENTS.md\n${planningProse}\nEOF`,
      `tee .scratch/plan.md <<EOF\n${planningProse}\nEOF`,
      `cat <<-"EOF" > docs/notes.md\n\t${planningProse.replaceAll("\n", "\n\t")}\n\tEOF`,
    ]) assert.equal(hookDecision(seat, command).decision, "allow", `${seat}: ${command}`);
  }
});

test("Antigravity keeps source writes and interpreter heredocs fenced for both planning seats", () => {
  for (const seat of ["supervisor", "lead"] as const) {
    for (const command of [
      "cat <<EOF > src/app.ts\nhello\nEOF",
      "cat <<EOF | tee src/app.ts\nhello\nEOF",
      "cat <<EOF > docs/notes.md\nhello\nEOF\ntouch src/app.ts",
      "python3 - <<'PY'\nopen('src/app.ts', 'w').write('changed')\nPY",
      "/usr/bin/env -i MODE=test /usr/bin/node <<'JS'\nrequire('fs').writeFileSync('src/app.ts', 'changed')\nJS",
      "cat <<EOF | /bin/bash\necho changed > src/app.ts\nEOF",
      "echo plan # <<EOF\ntouch src/app.ts\nEOF",
    ]) {
      const decision = hookDecision(seat, command);
      assert.equal(decision.decision, "deny", `${seat}: ${command}`);
      assert.match(decision.reason ?? "", /Seat write fence/);
    }
  }
});

test("contracted shell permissions inspect interpreter bodies while ignoring literal heredoc payloads", () => {
  const roots = writableRootsFor(projectRoot, stateDir, "/home/peer", {});
  const payload = `echo changed > ${stateDir}/ledger.jsonl`;
  for (const [header, behavior] of [["cat > docs/notes.md", "allow"], ["/usr/bin/env MODE=test /bin/bash", "deny"]] as const) {
    const command = `${header} <<'EOF'\n${payload}\nEOF`;
    assert.equal(judgeShellCommand(command, roots).behavior, behavior, command);
    assert.equal(hookDecision("agent", command).decision, behavior, command);
  }
});


test("expanding documentation heredocs cannot hide executable command substitutions", () => {
  for (const expansion of ["$(touch src/app.ts)", "`touch src/app.ts`", "'$(touch src/app.ts)'", "$(python3 -c \"open('src/app.ts', 'w').write('changed')\")"]) {
    const command = `cat <<EOF > docs/notes.md\n${expansion}\nEOF`;
    assert.equal(judgeSeatShellCommand(command, projectRoot, stateDir).behavior, "deny", command);
    for (const seat of ["supervisor", "lead"] as const) {
      assert.equal(hookDecision(seat, command).decision, "deny", `${seat}: ${command}`);
    }
  }
});

test("redirect prefixes cannot disguise executable interpreter heredocs", () => {
  for (const header of [
    "<<EOF bash",
    "<<EOF env -i MODE=test /bin/bash",
    "<<EOF /usr/bin/env -i MODE=test /usr/bin/node",
    ">docs/trace.md <<EOF /usr/bin/env MODE=test /bin/bash",
    "2>/dev/null <<EOF MODE=test /bin/bash",
  ]) {
    const command = `${header}\necho changed > src/app.ts\nEOF`;
    assert.deepEqual([
      judgeSeatShellCommand(command, projectRoot, stateDir).behavior,
      hookDecision("supervisor", command).decision,
      hookDecision("lead", command).decision,
    ], ["deny", "deny", "deny"], command);
  }
});

test("quoted delimiters and escaped substitutions remain literal documentation", () => {
  for (const command of [
    "cat <<'EOF' > docs/notes.md\n$(touch src/app.ts)\n`touch src/app.ts`\nEOF",
    'cat <<"EOF" > docs/notes.md\n$(touch src/app.ts)\n`touch src/app.ts`\nEOF',
    "cat <<EOF > docs/notes.md\n\\$(touch src/app.ts)\n\\`touch src/app.ts\\`\nEOF",
  ]) {
    assert.deepEqual([
      judgeSeatShellCommand(command, projectRoot, stateDir).behavior,
      hookDecision("supervisor", command).decision,
      hookDecision("lead", command).decision,
    ], ["allow", "allow", "allow"], command);
  }
});

test("contracted shell permissions also fence discarded heredoc substitutions", () => {
  const roots = writableRootsFor(projectRoot, stateDir, "/home/peer", {});
  for (const expansion of [`$(touch ${stateDir}/ledger.jsonl)`, `\`touch ${stateDir}/ledger.jsonl\``]) {
    const command = `cat <<EOF > docs/notes.md\n${expansion}\nEOF`;
    assert.deepEqual([
      judgeShellCommand(command, roots).behavior,
      hookDecision("agent", command).decision,
    ], ["deny", "deny"], command);
  }
});
