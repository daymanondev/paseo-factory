import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProviderExecutionFence } from "../plugin/server/roles.ts";

for (const role of ["supervisor", "lead", "agent"] as const) {
  for (const provider of ["opencode", "copilot"] as const) {
    for (const host of ["modern", "legacy"] as const) {
      test(`${host} ${provider} ${role} retains effective seat options`, () => {
        const root = mkdtempSync(join(tmpdir(), "roles-options-"));
        try {
          const config = applyProviderExecutionFence({
            provider, cwd: root,
            featureValues: { auto_accept: true, fast_mode: true },
            providerOptions: { custom: "preserved" },
          }, { role, stateDir: root, userHome: root, correlationId: "test", projectSlug: "test" });
          // Modern hosts read providerOptions; older hosts read composer featureValues.
          const options: Record<string, unknown> = host === "modern" ? config.providerOptions : config.featureValues;
          assert.equal(options.auto_accept, provider === "copilot" && (role === "supervisor" || role === "lead") ? false : true);
          assert.equal(options.fast_mode, true);
          assert.equal(config.providerOptions.custom, "preserved");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}

for (const role of ["supervisor", "lead", "agent"] as const) {
  for (const autoAccept of [undefined, false, true]) {
    test(`OpenCode ${role} default/toggle ${autoAccept} reaches both host formats`, () => {
      const root = mkdtempSync(join(tmpdir(), "roles-options-"));
      try {
        const result = applyProviderExecutionFence({
          provider: "opencode", cwd: root,
          featureValues: autoAccept === undefined ? {} : { auto_accept: autoAccept },
        }, { role, stateDir: root, userHome: root, correlationId: "test", projectSlug: "test" });
        const expected = autoAccept ?? true;
        assert.equal(result.featureValues?.auto_accept, expected);
        assert.equal((result as { providerOptions?: Record<string, unknown> }).providerOptions?.auto_accept, expected);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("explicit modern options take precedence over conflicting legacy toggles", () => {
  const root = mkdtempSync(join(tmpdir(), "roles-options-"));
  try {
    const result = applyProviderExecutionFence({
      provider: "opencode", cwd: root,
      featureValues: { auto_accept: true }, providerOptions: { auto_accept: false },
    }, { role: "lead", stateDir: root, userHome: root, correlationId: "test", projectSlug: "test" });
    assert.equal(result.providerOptions.auto_accept, false);
    assert.equal(result.featureValues.auto_accept, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
