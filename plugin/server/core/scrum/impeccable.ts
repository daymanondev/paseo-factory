import { existsSync, mkdirSync, readdirSync, symlinkSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
/** Discover whole upstream directories; keep references, scripts and engine together. */
export function provisionImpeccable(roleHome: string, userHome: string): string[] {
  const skills = new Map<string, string>();
  for (const provider of ['.agents', '.claude', '.gemini', '.pi', '.codex', '.opencode']) {
    const dir = join(userHome, provider, 'skills');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/^impeccable(?:$|[-_])/.test(name) && existsSync(join(dir, name, 'SKILL.md')) && !skills.has(name)) skills.set(name, join(dir, name));
    }
  }
  const target = join(roleHome, 'skills');
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) rmSync(target);
  mkdirSync(target, { recursive: true });
  for (const [name, path] of skills) {
    rmSync(join(target, name), { recursive: true, force: true });
    symlinkSync(path, join(target, name), 'dir');
  }
  const launcher = skills.has('impeccable') && existsSync(join(skills.get('impeccable')!, 'scripts/impeccable')) ? join(skills.get('impeccable')!, 'scripts/impeccable') : 'impeccable';
  const extension = join(roleHome, 'impeccable-hook.mjs');
  // Pi's tool_result is its postToolUse seam. Non-UI edits never start a process.
  writeFileSync(extension, `import { spawnSync } from 'node:child_process';
export default function(pi) {
  pi.on('tool_result', async (event, ctx) => {
    if (!['write','edit','Write','Edit','apply_patch'].includes(event.toolName)) return;
    const input = event.input || {}, path = input.path || input.file_path || '';
    const patch = input.patch || input.input || '';
    if (!/\\.(html|css|scss|jsx|tsx|vue|svelte|astro)$/i.test(path) && !/\\.(html|css|scss|jsx|tsx|vue|svelte|astro)(?:\\s|$)/im.test(patch)) return;
    const result = spawnSync(${JSON.stringify(launcher)}, ['hook'], { cwd: ctx.cwd, input: JSON.stringify({ tool_name: event.toolName, tool_input: input, tool_response: event }), encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    const output = [result.stdout,result.stderr].filter(Boolean).join('\\n');
    if (output || result.error) return { content: [...(event.content || []), { type:'text', text:'Impeccable postToolUse: '+(output || result.error.message) }] };
  });
}\n`);
  const command = "'" + launcher.replace(/'/g, "'\\''") + "' hook";
  // Emit the native hook manifest too; never write the user's global settings.
  writeFileSync(join(roleHome, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write|apply_patch', hooks: [{ type: 'command', command, timeout: 5 }] }] } }, null, 2) + '\n');
  return [...skills.keys()];
}
