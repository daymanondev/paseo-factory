/** Recognize a direct npx MCP stdio launch, without alternate packages or executables. */
export function isMcpStdioLaunch(args: readonly string[]): boolean {
  let index = 0;
  while (["-y", "--yes", "--no"].includes(args[index] ?? "")) index++;
  if (args[index] === "--") index++;
  const spec = args[index];
  if (spec === undefined) return false;
  // Only registry package names (with an optional version), never URLs or paths.
  const match = /^(?:(@[a-z0-9_-]+)\/)?([a-z0-9][a-z0-9._-]*)(?:@[a-z0-9.*^~+_-]+)?$/i.exec(spec);
  if (match === null) return false;
  const [, scope, name] = match;
  const pkg = scope === undefined ? name : `${scope}/${name}`;
  const server = ["@z_ai/mcp-server", "@upstash/context7-mcp", "@notionhq/notion-mcp-server"].includes(pkg!) ||
    (scope === "@modelcontextprotocol" && name!.startsWith("server-")) ||
    (name!.startsWith("mcp-") || /-mcp(?:-|$)/.test(name!));
  // npx options after the package can still alter execution on older npm versions.
  return server && !args.slice(index + 1).some((arg) => /^(?:--package|--call|--node-options|--script-shell)(?:=|$)|^-[pc]/.test(arg));
}
