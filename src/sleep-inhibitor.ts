import { spawn } from 'node:child_process';

interface InhibitorChild {
  kill(): boolean;
  unref(): void;
  once(event: 'error' | 'exit', listener: (...args: any[]) => void): unknown;
}
interface SleepInhibitorOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  idleReleaseMs?: number;
  spawn?: (command: string, args: string[], options: { stdio: 'ignore' }) => InhibitorChild;
  onError?: (error: unknown) => void;
}
/** One process-bound idle-sleep assertion with a continuous-idle grace period. */
export class SleepInhibitor {
  readonly #options: SleepInhibitorOptions;
  #child?: InhibitorChild;
  #idleTimer?: ReturnType<typeof setTimeout>;
  #stopped = false;

  constructor(options: SleepInhibitorOptions = {}) { this.#options = options; }

  poke(active: boolean): void {
    if (this.#stopped || (this.#options.platform ?? process.platform) !== 'darwin') return;
    if (active) {
      this.#cancelIdle();
      if (this.#child) return;
      try {
        const child = (this.#options.spawn ?? spawn)('caffeinate', ['-i', '-w', String(this.#options.pid ?? process.pid)], { stdio: 'ignore' });
        this.#child = child;
        child.once('error', error => { if (this.#child === child) this.#child = undefined; this.#options.onError?.(error); });
        child.once('exit', () => { if (this.#child === child) this.#child = undefined; });
        child.unref();
      } catch (error) { this.#options.onError?.(error); }
    } else if (this.#child && !this.#idleTimer) {
      this.#idleTimer = setTimeout(() => { this.#idleTimer = undefined; this.#release(); }, this.#options.idleReleaseMs ?? 600_000);
      this.#idleTimer.unref?.();
    }
  }

  stop(): void { this.#stopped = true; this.#cancelIdle(); this.#release(); }
  #cancelIdle(): void { if (this.#idleTimer) clearTimeout(this.#idleTimer); this.#idleTimer = undefined; }
  #release(): void {
    const child = this.#child; this.#child = undefined;
    try { child?.kill(); } catch (error) { this.#options.onError?.(error); }
  }
}
