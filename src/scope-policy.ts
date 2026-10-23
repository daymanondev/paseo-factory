export const PACKAGE_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);


/** A scope entry owns literal file/directory prefixes or paths matched by its glob. */
export function scopeCoversFile(scope: readonly string[], file: string): boolean {
  const directMatch = (target: string): boolean =>
    scope.some((entry) => {
      const prefix = normalizeScopePath(entry);
      const path = normalizeScopePath(target);
      if (!/[*?]/.test(prefix)) return path === prefix || path.startsWith(`${prefix}/`);
      return scopeGlob(prefix).test(path);
    });
  if (directMatch(file)) return true;
  const slashIdx = file.lastIndexOf("/");
  const baseName = slashIdx === -1 ? file : file.slice(slashIdx + 1);
  if (PACKAGE_LOCKFILES.has(baseName)) {
    const companionPkgJson = slashIdx === -1 ? "package.json" : `${file.slice(0, slashIdx)}/package.json`;
    if (directMatch(companionPkgJson)) return true;
  }
  return false;
}

/** Restore the whole branch diff from the Contract base, including previously committed files. */
export function scopeRecoveryCommands(base: string, files: readonly string[]): string {
  const quote = (value: string): string => /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
  return files.map((file) => `git restore --source=${quote(base)} -- ${quote(file)}`).join("; ");
}

/** Contract paths are relative Git paths; tolerate the conventional ./ and trailing slash. */
export function normalizeScopePath(path: string): string {
  return path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

export function scopeGlob(pattern: string): RegExp {
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        expression += "(?:[^/]+/)*";
        i++;
      } else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

