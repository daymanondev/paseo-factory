import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { catalog } from "./mcp/catalog.ts";
import type { ToolDefinition } from "./mcp/shared.ts";

const ALLOWED_ROLES = new Set(["supervisor", "lead", "agent"]);
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

/** Resolve and validate a candidate Antigravity `paseo_factory` MCP schema file path. */
function resolveHealTarget(targetPath: string): HealTarget | null {
  const raw = typeof targetPath === "string" ? targetPath.trim() : "";
  if (raw === "" || !isAbsolute(raw) || raw.endsWith("/") || raw.endsWith("\\")) return null;
  if (raw.split(/[/\\]/).some((seg) => seg === "." || seg === "..")) return null;

  const effectiveHome = process.env.HOME?.trim() || homedir();
  if (!effectiveHome) return null;

  const resolvedHome = resolve(effectiveHome);
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

/** Look up an MCP tool definition only if it belongs to the calling seat's role allowlist. */
function resolveAllowedToolForSeat(seat: string, toolName: string): ToolDefinition | null {
  if (!ALLOWED_ROLES.has(seat)) return null;
  const allowedTools = catalog.roles[seat];
  if (!Array.isArray(allowedTools) || !allowedTools.includes(toolName)) return null;
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
  let tempPath: string | null = null;
  try {
    const target = resolveHealTarget(options.targetPath);
    if (target === null) return false;

    const tool = resolveAllowedToolForSeat(options.seat, target.toolName);
    if (tool === null) return false;

    if (!isMissingPath(target.targetFile)) return false;

    mkdirSync(target.serverDir, { recursive: true });
    tempPath = join(target.serverDir, `.${target.toolName}.json.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tempPath, serializeAgyMcpSchema(tool), { encoding: "utf8", flag: "wx" });

    if (!isMissingPath(target.targetFile)) {
      removeQuietly(tempPath);
      tempPath = null;
      return false;
    }

    renameSync(tempPath, target.targetFile);
    tempPath = null;
    return true;
  } catch {
    if (tempPath !== null) removeQuietly(tempPath);
    return false;
  }
}
