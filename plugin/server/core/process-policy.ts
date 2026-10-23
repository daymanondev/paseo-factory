import type { ChildProcess } from "node:child_process";

/** Gates own a detached process group; wrappers preserve the child's native outcome. */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (child.pid === undefined || process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { child.kill(signal); }
}

/** Run in a native executable wrapper after spawning its real executable. */
export function inheritChildOutcome(child: ChildProcess, onError: (error: Error) => void): void {
  const forwarded: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map(forwarded.map((signal) => [signal, () => { child.kill(signal); }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.on("error", (error) => {
    onError(error);
    process.exit(127);
  });
  child.on("close", (code, signal) => {
    if (signal !== null) {
      for (const [forwardedSignal, handler] of handlers) process.removeListener(forwardedSignal, handler);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}
