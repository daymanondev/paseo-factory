import { existsSync, mkdirSync, readdirSync, symlinkSync, rmSync, writeFileSync, lstatSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
/** Discover whole upstream directories; keep references, scripts and engine together. */
export function provisionImpeccable(roleHome: string, userHome: string, sourceCodexHome = join(userHome, '.codex')): string[] {
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
  mkdirSync(join(roleHome, '.claude-plugin'), { recursive: true });
  mkdirSync(join(roleHome, 'hooks'), { recursive: true });
  writeFileSync(join(roleHome, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'factory-scrum-ui', version: '1.0.0', description: 'Role-scoped upstream Impeccable skills and scanner' }));
  const nativeHooks = JSON.parse(readFileSync(join(roleHome, 'hooks.json'), 'utf8'));
  writeFileSync(join(roleHome, 'hooks/hooks.json'), JSON.stringify(nativeHooks));
  writeFileSync(join(roleHome, 'agy-settings.json'), JSON.stringify(nativeHooks));
  // OpenCode uses a native plugin, scoped to the dedicated server's environment.
  writeFileSync(join(roleHome, 'impeccable-opencode.mjs'), `import { spawnSync } from 'node:child_process';
export default async function({directory}) { return { 'tool.execute.after': async (event, output) => {
  const args=event.args||{}, file=args.filePath||args.file_path||args.path||'', patch=args.patchText||args.patch||'';
  if (!['write','edit','apply_patch'].includes(event.tool) || (!/\\.(html|css|scss|jsx|tsx|vue|svelte|astro)$/i.test(file) && !/\\.(html|css|scss|jsx|tsx|vue|svelte|astro)(?:\\s|$)/im.test(patch))) return;
  const result=spawnSync(${JSON.stringify(launcher)},['hook'],{cwd:directory,input:JSON.stringify({tool_name:event.tool,tool_input:args,tool_response:output}),encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  const text=[result.stdout,result.stderr,result.error?.message].filter(Boolean).join('\\n');
  if(text)output.output=(output.output||'')+'\\nImpeccable postToolUse: '+text;
} } }`);
  // Copilot has a distinct hook schema; its plugin root is separate from Claude's.
  const copilot = join(roleHome, 'copilot');
  mkdirSync(join(copilot, '.claude-plugin'), { recursive: true });
  writeFileSync(join(copilot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'factory-scrum-ui', version: '1.0.0' }));
  rmSync(join(copilot, 'skills'), { recursive: true, force: true });
  symlinkSync(target, join(copilot, 'skills'), 'dir');
  writeFileSync(join(copilot, 'hooks.json'), JSON.stringify({ version: 1, hooks: { postToolUse: [{ type: 'command', bash: command, timeoutSec: 5 }] } }));
  // Codex reads its native hooks from CODEX_HOME. Preserve auth/provider config.
  for (const name of ['auth.json', 'config.toml']) {
    const source = join(sourceCodexHome, name), dest = join(roleHome, name);
    if (existsSync(source) && !existsSync(dest)) { if (name === 'config.toml') copyFileSync(source, dest); else symlinkSync(source, dest); }
  }
  return [...skills.keys()];
}

/** Launch overlays are confined to the specialist process; preserve operator config. */
export function impeccableEnvironment(roleHome: string, environment: Record<string, string | undefined>): Record<string, string> {
  environment = restoreImpeccableEnvironment(environment);
  let openCode: Record<string, unknown> = {};
  try { const parsed = JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) openCode = parsed; } catch { throw new Error('Invalid OPENCODE_CONFIG_CONTENT; cannot safely add the UI scanner'); }
  const existingSkills = typeof openCode.skills === 'object' && openCode.skills ? openCode.skills as Record<string, unknown> : {};
  return {
    PASEO_FACTORY_UI_BASE_ENV: JSON.stringify(Object.fromEntries(['CODEX_HOME','OPENCODE_CONFIG_CONTENT','OMP_PROFILE','PI_PROFILE'].map(key => [key, environment[key] ?? null]))),
    PASEO_FACTORY_IMPECCABLE: join(roleHome, 'skills/impeccable/scripts/impeccable'),
    PASEO_FACTORY_UI_HOME: roleHome,
    CODEX_HOME: roleHome,
    OMP_PROFILE: '', PI_PROFILE: '',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...openCode, plugin: [...new Set([...(Array.isArray(openCode.plugin) ? openCode.plugin : []), pathToFileURL(join(roleHome, 'impeccable-opencode.mjs')).href])], skills: { ...existingSkills, paths: [...new Set([...(Array.isArray(existingSkills.paths) ? existingSkills.paths : []), join(roleHome, 'skills')])] } }),
  };
}

/** Remove Factory-owned overlays before changing identity or rebuilding a session. */
export function restoreImpeccableEnvironment<T extends Record<string, string | undefined>>(environment: T): Record<string, string> {
  const restored = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
  const base = environment.PASEO_FACTORY_UI_BASE_ENV;
  if (base) {
    try {
      const original = JSON.parse(base);
      for (const key of ['CODEX_HOME','OPENCODE_CONFIG_CONTENT','OMP_PROFILE','PI_PROFILE']) {
        if (typeof original[key] === 'string') restored[key] = original[key]; else delete restored[key];
      }
    } catch { throw new Error('Invalid original UI environment; cannot safely restore role isolation'); }
  }
  for (const key of ['PASEO_FACTORY_UI_HOME','PASEO_FACTORY_IMPECCABLE','PASEO_FACTORY_UI_BASE_ENV']) delete restored[key];
  return restored;
}
