import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import contribute, { createSleepInhibitionMonitor } from '../plugin/index.server.ts';
import { createFactory } from '../plugin/server/core/factory.ts';
import { ensureProjectRegistered } from '../plugin/server/core/project.ts';
import { setProjectStoreReleaseSettings } from '../plugin/server/core/project-settings.ts';
import { SleepInhibitor } from '../src/sleep-inhibitor.ts';
import { hasActiveStoreReleases, storeReleaseProject } from '../plugin/server/store-release.ts';
import { disposeDir, gitCommitAll, makeTempDir } from './helpers.ts';

class Child extends EventEmitter {
  kills = 0;
  unref() {}
  kill() { this.kills++; return true; }
}

function setupActiveStoreReleaseFixture(dir: string) {
  const paseoHome = join(dir, 'paseo-home');
  const stateDir = join(paseoHome, 'plugin-state', 'paseo-factory');
  const repoDir = join(dir, 'mobile-app');
  mkdirSync(join(repoDir, 'ios', 'Demo.xcodeproj'), { recursive: true });
  writeFileSync(join(repoDir, 'README.md'), '# Mobile\n');
  writeFileSync(join(repoDir, 'ios', 'Podfile'), "platform :ios, '15.0'\n");
  gitCommitAll(repoDir);
  const realRepo = realpathSync(repoDir);

  const project = ensureProjectRegistered(stateDir, realRepo);
  assert.ok(project.ok);
  const factory = createFactory({ stateDir: join(stateDir, 'projects', project.slug) });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: realRepo, encoding: 'utf8' }).trim();
  factory.setContract({ task: 'T-SLEEP', workspace: realRepo, gate: 'true', artifact: 'README.md' });
  factory.ledger.append({ event: 'claim_reported', task: 'T-SLEEP', attempt: 1, sha });
  factory.ledger.append({ event: 'gate_started', task: 'T-SLEEP', attempt: 1, cmd: 'true' });
  factory.ledger.append({ event: 'gate_finished', task: 'T-SLEEP', attempt: 1, exit: 0, verdict: 'green', note: 'ok', sha });
  factory.ledger.append({ event: 'report_written', task: 'T-SLEEP', attempt: 1, path: 'report-T-SLEEP-1.md' });

  const pluginRoot = join(paseoHome, 'plugins', 'factory-release-lab', 'ver-001');
  mkdirSync(join(pluginRoot, 'bin'), { recursive: true });
  mkdirSync(join(pluginRoot, 'plugin'), { recursive: true });
  writeFileSync(join(pluginRoot, 'bin', 'release-lab.mjs'), '#!/usr/bin/env node\n');

  const runtimeDir = join(paseoHome, 'vault-runtime');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, 'env.json'),
    JSON.stringify({
      ASC_KEY_PATH: '/tmp/synth-asc.p8',
      ASC_KEY_ID: 'SYNTHKEY',
      ASC_ISSUER: '00000000-0000-0000-0000-000000000001',
      APPLE_TEAM_ID: 'SYNTHTEAM',
    }),
  );
  setProjectStoreReleaseSettings(stateDir, project.slug, { mode: 'auto-staging' });

  return { paseoHome, stateDir, repoDir: realRepo, slug: project.slug, factory };
}
test('macOS holds one assertion through activity, cancels idle release, and releases after ten continuous idle minutes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children: Child[] = [], commands: unknown[] = [];
  const inhibitor = new SleepInhibitor({ platform: 'darwin', pid: 123, spawn: (command, args, options) => { commands.push([command, args, options]); const child = new Child(); children.push(child); return child; } });
  t.after(() => inhibitor.stop());
  inhibitor.poke(false); assert.equal(children.length, 0);
  inhibitor.poke(true); inhibitor.poke(true);
  assert.deepEqual(commands, [['caffeinate', ['-i', '-w', '123'], { stdio: 'ignore' }]]);
  inhibitor.poke(false); t.mock.timers.tick(599_999); assert.equal(children[0].kills, 0);
  inhibitor.poke(true); t.mock.timers.tick(1); assert.equal(children[0].kills, 0);
  inhibitor.poke(false); t.mock.timers.tick(300_000); inhibitor.poke(false); t.mock.timers.tick(300_000);
  assert.equal(children[0].kills, 1);
  inhibitor.poke(true); assert.equal(children.length, 2);
  inhibitor.stop(); inhibitor.stop(); assert.equal(children[1].kills, 1);
  inhibitor.poke(true); assert.equal(children.length, 2);
});
test('sleep inhibition is disabled outside macOS and spawn failures do not crash the plugin', () => {
  const disabled = new SleepInhibitor({ platform: 'linux', spawn: () => { throw new Error('must not spawn'); } });
  disabled.poke(true); disabled.stop();
  const child = new Child(); let attempts = 0;
  const inhibitor = new SleepInhibitor({ platform: 'darwin', spawn: () => { attempts++; return child; } });
  inhibitor.poke(true); child.emit('error', new Error('missing caffeinate'));
  inhibitor.poke(true); assert.equal(attempts, 2);
  child.emit('exit', 0); inhibitor.poke(true); assert.equal(attempts, 3); inhibitor.stop();
});

test('createSleepInhibitionMonitor keeps caffeinate -i alive while async Store releases run even when seats and GateQueue are idle, then releases after settle', async t => {
  const dir = makeTempDir('sleep-store-release-');
  disposeDir(t, dir);
  const fx = setupActiveStoreReleaseFixture(dir);
  t.after(() => fx.factory.history.stop());
  await fx.factory.accept({ task: 'T-SLEEP', attempt: 1, accepted_by: 'lead' });

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const children: Child[] = [];
  const commands: Array<[string, string[], { stdio: 'ignore' }]> = [];
  const inhibitor = new SleepInhibitor({
    platform: 'darwin',
    pid: 456,
    spawn: (command, args, options) => {
      commands.push([command, args, options]);
      const child = new Child();
      children.push(child);
      return child;
    },
  });

  const monitor = createSleepInhibitionMonitor({
    stateDir: fx.stateDir,
    leadMail: { hasActiveWork: async () => false },
    gateQueue: { hasRunning: () => false, hasQueued: () => false },
    sleepInhibitor: inhibitor,
    platform: 'darwin',
    watchStateDir: false,
    sweepIntervalMs: 60_000,
  });
  t.after(() => monitor.stop());

  await monitor.refresh();
  assert.equal(children.length, 0, 'no caffeinate spawned when everything is idle');

  let resolveFirst!: () => void;
  let resolveSecond!: () => void;
  const firstGate = new Promise<void>(resolve => { resolveFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { resolveSecond = resolve; });

  const firstRes = await storeReleaseProject({
    factory: fx.factory,
    stateDir: fx.stateDir,
    paseoHome: fx.paseoHome,
    projectSlug: fx.slug,
    projectRoot: fx.repoDir,
    action: 'stage',
    listPlugins: async () => ({ ok: false as const, reason: 'offline' }),
    runner: async () => {
      await firstGate;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ id: 'rel-sleep-1', status: 'completed', platforms: ['ios'], phases: [] }),
        stderr: '',
      };
    },
  });
  assert.equal(firstRes.ok, true);
  assert.equal(hasActiveStoreReleases(), true);

  await new Promise(resolve => setImmediate(resolve));
  await monitor.refresh();
  assert.deepEqual(commands, [['caffeinate', ['-i', '-w', '456'], { stdio: 'ignore' }]]);
  assert.equal(commands[0]![1].includes('-d'), false, 'must NOT pass -d display-sleep flag');
  assert.equal(children.length, 1);

  // Ticking well past the 10-minute idle grace while Store release runs keeps caffeinate alive.
  t.mock.timers.tick(650_000);
  await monitor.refresh();
  assert.equal(children[0]!.kills, 0);

  // Start a second concurrent Store release; finishing the first keeps inhibition held.
  const secondRes = await storeReleaseProject({
    factory: fx.factory,
    stateDir: fx.stateDir,
    paseoHome: fx.paseoHome,
    projectSlug: fx.slug,
    projectRoot: fx.repoDir,
    action: 'stage',
    listPlugins: async () => ({ ok: false as const, reason: 'offline' }),
    runner: async () => {
      await secondGate;
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'simulated failure',
      };
    },
  });
  assert.equal(secondRes.ok, true);

  resolveFirst();
  if (firstRes.ok && 'settled' in firstRes) await firstRes.settled;
  assert.equal(hasActiveStoreReleases(), true, 'second concurrent Store release still active');
  await monitor.refresh();
  t.mock.timers.tick(650_000);
  assert.equal(children[0]!.kills, 0);

  // Once the second release settles (even on failure), active count drops to 0 and idle timer releases caffeinate.
  resolveSecond();
  if (secondRes.ok && 'settled' in secondRes) await secondRes.settled;
  assert.equal(hasActiveStoreReleases(), false);
  await new Promise(resolve => setImmediate(resolve));

  t.mock.timers.tick(599_999);
  assert.equal(children[0]!.kills, 0);
  t.mock.timers.tick(1);
  assert.equal(children[0]!.kills, 1, 'caffeinate released after 10 continuous idle minutes post-settlement');
});

test('plugin/index.server.ts contribute() spawns caffeinate -i during active Store release on macOS', { skip: process.platform !== 'darwin' }, async t => {
  const dir = makeTempDir('sleep-contribute-');
  const binDir = join(dir, 'fake-bin');
  const pidPath = join(dir, 'caffeinate.pid');
  const argsPath = join(dir, 'caffeinate.args.json');
  const releaseFlag = join(dir, 'release-done.flag');
  t.after(() => {
    if (!existsSync(pidPath)) return;
    try { process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGKILL'); } catch { /* already dead */ }
  });
  disposeDir(t, dir);

  mkdirSync(binDir, { recursive: true });
  const fakeCaffeinate = join(binDir, 'caffeinate');
  writeFileSync(
    fakeCaffeinate,
    `#!${process.execPath}
import { renameSync, writeFileSync } from 'node:fs';
const pidTmp = ${JSON.stringify(`${pidPath}.tmp`)};
writeFileSync(pidTmp, String(process.pid));
renameSync(pidTmp, ${JSON.stringify(pidPath)});
const argsTmp = ${JSON.stringify(`${argsPath}.tmp`)};
writeFileSync(argsTmp, JSON.stringify(process.argv.slice(2)));
renameSync(argsTmp, ${JSON.stringify(argsPath)});
setInterval(() => {}, 60000);
`,
  );
  chmodSync(fakeCaffeinate, 0o755);

  const fx = setupActiveStoreReleaseFixture(dir);
  await fx.factory.accept({ task: 'T-SLEEP', attempt: 1, accepted_by: 'lead' });
  fx.factory.history.stop();

  const fakeRunnerBin = join(fx.paseoHome, 'plugins', 'factory-release-lab', 'ver-001', 'bin', 'release-lab.mjs');
  writeFileSync(
    fakeRunnerBin,
    `#!${process.execPath}
import { existsSync } from 'node:fs';
const wait = setInterval(() => {
  if (!existsSync(${JSON.stringify(releaseFlag)})) return;
  clearInterval(wait);
  console.log(JSON.stringify({ id: 'rel-contribute-1', status: 'completed', platforms: ['ios'], phases: [] }));
  process.exit(0);
}, 20);
`,
  );
  chmodSync(fakeRunnerBin, 0o755);

  const prevHome = process.env.HOME;
  const prevPaseoHome = process.env.PASEO_HOME;
  const prevPath = process.env.PATH;
  process.env.HOME = dir;
  process.env.PASEO_HOME = fx.paseoHome;
  process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevPaseoHome;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  });

  const server = {
    addHook: () => () => {},
    handle: () => {},
  } as unknown as Parameters<typeof contribute>[0];
  const stop = contribute(server);
  t.after(() => stop());

  const reqPath = join(fx.stateDir, 'spool', 'requests', 'req-store-sleep.json');
  const replyPath = join(fx.stateDir, 'spool', 'replies', 'req-store-sleep.json');
  writeFileSync(
    reqPath,
    JSON.stringify({
      id: 'req-store-sleep',
      kind: 'store-release',
      action: 'stage',
      workspace: fx.repoDir,
      projectSlug: fx.slug,
      seat: 'lead',
    }),
  );

  try {
    const startDeadline = Date.now() + 5_000;
    while ((!existsSync(replyPath) || !existsSync(argsPath)) && Date.now() < startDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(replyPath), 'spool replied to store-release request');
    const reply = JSON.parse(readFileSync(replyPath, 'utf8')) as { ok?: boolean; started?: boolean };
    assert.equal(reply.ok, true);
    assert.equal(reply.started, true);
    assert.equal(hasActiveStoreReleases(), true);
    assert.ok(existsSync(argsPath), 'contribute() spawned caffeinate while Store release was running');
    const argv = JSON.parse(readFileSync(argsPath, 'utf8')) as string[];
    assert.deepEqual(argv, ['-i', '-w', String(process.pid)]);
    assert.equal(argv.includes('-d'), false);
  } finally {
    writeFileSync(releaseFlag, 'done\n');
    const settleDeadline = Date.now() + 5_000;
    while (hasActiveStoreReleases() && Date.now() < settleDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  assert.equal(hasActiveStoreReleases(), false);
  const ledgerPath = join(fx.stateDir, 'projects', fx.slug, 'ledger.jsonl');
  const ledgerDeadline = Date.now() + 3_000;
  while (!readFileSync(ledgerPath, 'utf8').includes('store_release_completed') && Date.now() < ledgerDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(readFileSync(ledgerPath, 'utf8'), /store_release_completed/);
});
