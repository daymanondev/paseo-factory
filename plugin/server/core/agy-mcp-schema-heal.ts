import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { catalog } from "./mcp/catalog.ts";
import type { ToolDefinition } from "./mcp/shared.ts";

const ALLOWED_ROLES = new Set(["supervisor", "lead", "agent"]);
const LEGACY_ROLE_TOOL_ALLOWLIST: Record<string, readonly string[]> = {
  lead: ["lead_repoke_agent"],
  agent: ["agent_escalate_blocker"],
};
const AGY_APP_DATA_NAMES = ["antigravity", "antigravity-cli"] as const;
const AGY_SERVER_DIR_NAMES = ["paseo-factory_paseo_factory", "paseo_factory"] as const;

interface HealTarget {
  serverDir: string;
  targetFile: string;
  toolName: string;
}

export interface HealSchemaOptions {
  seat: string;
  targetPath: string;
}

export interface HealCallSchemaOptions {
  seat: string;
  serverName: string;
  toolName: string;
}

export interface HealCommandSchemaOptions {
  seat: string;
  command: string;
}

function resolveEffectiveHome(): string | null {
  const effectiveHome = process.env.HOME?.trim() || homedir();
  return effectiveHome ? resolve(effectiveHome) : null;
}

function hasUnsafeRelativeSegment(raw: string): boolean {
  return raw.split(/[/\\]/).some((seg) => seg === "." || seg === "..");
}

function writeMissingSchemaFile(serverDir: string, tool: ToolDefinition): boolean {
  let tempPath: string | null = null;
  try {
    const targetFile = join(serverDir, `${tool.name}.json`);
    if (!isMissingPath(targetFile)) return false;

    mkdirSync(serverDir, { recursive: true });
    tempPath = join(serverDir, `.${tool.name}.json.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tempPath, serializeAgyMcpSchema(tool), { encoding: "utf8", flag: "wx" });

    if (!isMissingPath(targetFile)) {
      removeQuietly(tempPath);
      tempPath = null;
      return false;
    }

    renameSync(tempPath, targetFile);
    tempPath = null;
    return true;
  } catch {
    if (tempPath !== null) removeQuietly(tempPath);
    return false;
  }
}

function resolveAllowedToolsForSeat(seat: string): ToolDefinition[] {
  if (!ALLOWED_ROLES.has(seat)) return [];
  const allowedTools = catalog.roles[seat];
  if (!Array.isArray(allowedTools)) return [];
  const defs: ToolDefinition[] = [];
  for (const name of allowedTools) {
    const tool = catalog.tools[name];
    if (tool) defs.push(tool);
  }
  return defs;
}

function healMissingSchemasInDir(serverDir: string, seat: string): number {
  let healed = 0;
  for (const tool of resolveAllowedToolsForSeat(seat)) {
    if (writeMissingSchemaFile(serverDir, tool)) healed += 1;
  }
  return healed;
}

/** Resolve and validate a candidate Antigravity `paseo_factory` MCP schema file path. */
function resolveHealTarget(targetPath: string): HealTarget | null {
  const raw = typeof targetPath === "string" ? targetPath.trim() : "";
  if (raw === "" || !isAbsolute(raw) || raw.endsWith("/") || raw.endsWith("\\")) return null;
  if (hasUnsafeRelativeSegment(raw)) return null;

  const resolvedHome = resolveEffectiveHome();
  if (!resolvedHome) return null;

  const resolvedTarget = resolve(raw);
  const parentDir = dirname(resolvedTarget);
  const fileName = basename(resolvedTarget);
  if (!fileName.endsWith(".json")) return null;

  const toolName = fileName.slice(0, -".json".length);
  if (toolName === "" || toolName.includes("/") || toolName.includes("\\")) return null;

  for (const appName of AGY_APP_DATA_NAMES) {
    for (const serverDirName of AGY_SERVER_DIR_NAMES) {
      const serverDir = resolve(resolvedHome, ".gemini", appName, "mcp", serverDirName);
      if (parentDir === serverDir) {
        return { serverDir, targetFile: resolvedTarget, toolName };
      }
    }
  }
  return null;
}

/** Look up an MCP tool definition only if it belongs to the calling seat's role allowlist (including legacy aliases). */
function resolveAllowedToolForSeat(seat: string, toolName: string): ToolDefinition | null {
  if (!ALLOWED_ROLES.has(seat)) return null;
  const allowedTools = catalog.roles[seat];
  const legacyTools = LEGACY_ROLE_TOOL_ALLOWLIST[seat] ?? [];
  if ((!Array.isArray(allowedTools) || !allowedTools.includes(toolName)) && !legacyTools.includes(toolName)) {
    return null;
  }
  return catalog.tools[toolName] ?? null;
}

/** Format a tool definition in Antigravity's on-disk lazy schema JSON layout (omitting `_meta`). */
function serializeAgyMcpSchema(tool: ToolDefinition): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  });
}

function isMissingPath(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Fail open on temp cleanup errors.
  }
}

/** Atomically restore a missing role-permitted MCP schema file; strictly additive and fail-open. */
export function healAgyMcpSchemaFile(options: HealSchemaOptions): boolean {
  try {
    const target = resolveHealTarget(options.targetPath);
    if (target === null) return false;

    const tool = resolveAllowedToolForSeat(options.seat, target.toolName);
    if (tool === null) return false;

    return writeMissingSchemaFile(target.serverDir, tool);
  } catch {
    return false;
  }
}

/**
 * Atomically restore all missing role-permitted MCP schema files when a seat
 * lists or searches an Antigravity `paseo_factory` MCP schema directory.
 * Strictly additive (never overwrites or prunes sibling schemas) and fail-open.
 */
export function healAgyMcpSchemasForDirectory(options: HealSchemaOptions): number {
  try {
    if (!ALLOWED_ROLES.has(options.seat)) return 0;
    const raw = typeof options.targetPath === "string" ? options.targetPath.trim() : "";
    if (raw === "" || !isAbsolute(raw) || hasUnsafeRelativeSegment(raw)) return 0;

    const resolvedHome = resolveEffectiveHome();
    if (!resolvedHome) return 0;

    const resolvedTarget = resolve(raw);
    for (const appName of AGY_APP_DATA_NAMES) {
      const mcpRoot = resolve(resolvedHome, ".gemini", appName, "mcp");
      for (const serverDirName of AGY_SERVER_DIR_NAMES) {
        const serverDir = resolve(mcpRoot, serverDirName);
        if (resolvedTarget === serverDir) {
          return healMissingSchemasInDir(serverDir, options.seat);
        }
      }
      if (resolvedTarget === mcpRoot) {
        let healed = 0;
        for (const serverDirName of AGY_SERVER_DIR_NAMES) {
          const serverDir = resolve(mcpRoot, serverDirName);
          if (!isMissingPath(serverDir)) {
            healed += healMissingSchemasInDir(serverDir, options.seat);
          }
        }
        return healed;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Atomically restore missing role-permitted MCP schema files when a shell
 * command inspects an Antigravity `paseo_factory` MCP schema directory.
 */
export function healAgyMcpSchemasForCommand(options: HealCommandSchemaOptions): number {
  try {
    if (!ALLOWED_ROLES.has(options.seat)) return 0;
    const command = typeof options.command === "string" ? options.command : "";
    const matchedServers = AGY_SERVER_DIR_NAMES.filter((name) => command.includes(name));
    if (matchedServers.length === 0) return 0;

    const resolvedHome = resolveEffectiveHome();
    if (!resolvedHome) return 0;

    let healed = 0;
    for (const appName of AGY_APP_DATA_NAMES) {
      const mcpRoot = resolve(resolvedHome, ".gemini", appName, "mcp");
      if (isMissingPath(mcpRoot)) continue;
      for (const serverDirName of matchedServers) {
        const serverDir = resolve(mcpRoot, serverDirName);
        if (!isMissingPath(serverDir) || command.includes(join(".gemini", appName, "mcp", serverDirName))) {
          healed += healMissingSchemasInDir(serverDir, options.seat);
        }
      }
    }
    return healed;
  } catch {
    return 0;
  }
}

/**
 * Keep the called tool's on-disk schema warm when a seat invokes `call_mcp_tool`
 * against `paseo-factory_paseo_factory` or `paseo_factory`.
 */
export function healAgyMcpSchemaForCall(options: HealCallSchemaOptions): boolean {
  try {
    const serverName = typeof options.serverName === "string" ? options.serverName.trim() : "";
    if (!AGY_SERVER_DIR_NAMES.includes(serverName as (typeof AGY_SERVER_DIR_NAMES)[number])) return false;

    const tool = resolveAllowedToolForSeat(options.seat, options.toolName);
    if (tool === null) return false;

    const resolvedHome = resolveEffectiveHome();
    if (!resolvedHome) return false;

    let healed = false;
    for (const appName of AGY_APP_DATA_NAMES) {
      const mcpRoot = resolve(resolvedHome, ".gemini", appName, "mcp");
      if (isMissingPath(mcpRoot)) continue;
      const serverDir = resolve(mcpRoot, serverName);
      if (writeMissingSchemaFile(serverDir, tool)) healed = true;
    }
    return healed;
  } catch {
    return false;
  }
}
