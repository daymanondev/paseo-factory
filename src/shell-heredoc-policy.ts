/** Canonical shell scanning policy, bundled into standalone permission hooks (ADR 0022). */
export const PROCESS_KILL_WRAPPER_PREFIXES = new Set([
  "env",
  "command",
  "nohup",
  "sudo",
  "xargs",
  "exec",
  "timeout",
  "nice",
]);

/** The duration/adjustment operand `timeout`/`nice` carry before the command. */
export function isTimeoutOrNiceOperand(token: string): boolean {
  return /^[-+]?\d[\d.]*[a-z]?$/i.test(token) || token === "-n" || token === "--adjustment";
}

/** Split without heredoc handling, also used to inspect the header itself. */
export function rawShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (current.trim() !== "") segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") segments.push(current.trim());
  return segments;
}

const HEREDOC_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "node", "python", "python3", "ruby", "perl", "php"]);

/** Only operators outside quoted prose are heredoc headers; `<<<` is a here-string. */
function heredocDelimiters(line: string): { delimiter: string; tabs: boolean; expands: boolean }[] {
  const delimiters: { delimiter: string; tabs: boolean; expands: boolean }[] = [];
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && quote !== "'") { i += 1; continue; }
    if (quote !== null) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /[\s;|&()]/.test(line[i - 1]!))) break;
    if (line.startsWith("<<<", i)) { i += 2; continue; }
    if (!line.startsWith("<<", i)) continue;
    const match = /^<<(-)?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/.exec(line.slice(i));
    if (match === null) continue;
    delimiters.push({ delimiter: (match[2] ?? match[3] ?? match[4])!, tabs: match[1] !== undefined, expands: match[2] === undefined && match[3] === undefined });
    i += match[0].length - 1;
  }
  return delimiters;
}

/** Redirections may legally precede the executable; inspect command words without their operands. */
function headerWithoutRedirections(header: string): string {
  let result = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]!;
    if (ch === "\\" && quote !== "'") { result += ch + (header[++i] ?? ""); continue; }
    if (quote !== null) { if (ch === quote) quote = null; result += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; result += ch; continue; }
    const redirect = /^(?:\d+)?(?:<<<|<<-?|>>|<>|<&|>&|[<>])\s*(?:'[^']*'|"[^"]*"|[^\s;|&<>]+)/.exec(header.slice(i));
    if (redirect !== null) { result += " "; i += redirect[0].length - 1; continue; }
    result += ch;
  }
  return result;
}

function heredocHeaderInvokesInterpreter(header: string): boolean {
  return rawShellSegments(headerWithoutRedirections(header)).some((segment) => {
    const words = quoteAwareWords(segment);
    let i = 0;
    while (i < words.length) {
      const word = words[i]!;
      const bin = word.split("/").at(-1)!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || bin === "export") { i++; continue; }
      if (!PROCESS_KILL_WRAPPER_PREFIXES.has(bin)) return HEREDOC_INTERPRETERS.has(bin);
      i++;
      // Wrapper options precede the actual executable (`env -i X=y /usr/bin/node`).
      while (i < words.length && words[i]!.startsWith("-")) {
        const option = words[i++]!;
        if (["-u", "--unset", "-C", "--chdir", "-n", "--adjustment"].includes(option)) i++;
      }
      if (bin === "timeout" && i < words.length && isTimeoutOrNiceOperand(words[i]!)) i++;
    }
    return false;
  });
}

/** Expanding heredoc bodies perform command substitution even inside quote-looking prose. */
function hasCommandSubstitution(body: string): boolean {
  const joined = body.replaceAll("\\\n", "");
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "\\") { i++; continue; }
    if (joined[i] === "`" || joined.startsWith("$(", i)) return true;
  }
  return false;
}

/** Keep executable stdin visible and flag substitutions that cannot safely be discarded as prose. */
export function inspectShellHeredocs(command: string): { command: string; interpreter: boolean; commandSubstitution: boolean } {
  const lines = command.split("\n");
  const result: string[] = [];
  let interpreter = false;
  let commandSubstitution = false;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!;
    result.push(header);
    const delimiters = heredocDelimiters(header);
    const preserve = delimiters.length > 0 && heredocHeaderInvokesInterpreter(header);
    interpreter ||= preserve;
    for (const { delimiter, tabs, expands } of delimiters) {
      const body: string[] = [];
      while (++i < lines.length) {
        const line = lines[i]!;
        if (preserve) result.push(line);
        if ((tabs ? line.replace(/^\t+/, "") : line).replace(/\r$/, "") === delimiter) break;
        body.push(line);
      }
      if (expands && hasCommandSubstitution(body.join("\n"))) commandSubstitution = true;
    }
  }
  return { command: result.join("\n"), interpreter, commandSubstitution };
}

/** Ignore literal documentation payloads, retaining every executable header and interpreter body. */
export function stripNonInterpreterHeredocs(command: string): string {
  return inspectShellHeredocs(command).command;
}

/**
 * Tokenizes a single shell segment preserving quoted strings as single tokens
 * so `--message "npm install src/foo.ts"` is not mistaken for a subcommand.
 */
export function quoteAwareWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") words.push(current);
  return words;
}

