import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SleepInhibitor } from '../src/sleep-inhibitor.ts';

class Child extends EventEmitter {
  kills = 0;
  unref() {}
  kill() { this.kills++; return true; }
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
