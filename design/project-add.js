'use strict';
/* Add Project Onboarding Flow — Clean 5-Step English Wizard */

const WIZ_SAMPLE_FOLDERS = [
  {
    id: 'fintech',
    name: 'fintech-superapp',
    label: 'Fintech SuperApp',
    path: '~/Projects/fintech-superapp',
    gitInitialized: true,
    gitBranch: 'main',
    gitCommit: 'a8f42c1',
    detectedStack: ['expo', 'firebase', 'opendesign'],
    recommendedMode: 'scrum',
    recommendedDesign: 'link',
    matchedDesignId: 'od-fintech'
  },
  {
    id: 'commerce',
    name: 'greenfield-ai-commerce',
    label: 'Greenfield AI Commerce',
    path: '~/Projects/greenfield-ai-commerce',
    gitInitialized: false,
    gitBranch: 'main',
    gitCommit: null,
    detectedStack: ['expo', 'opendesign'],
    recommendedMode: 'scrum',
    recommendedDesign: 'generate',
    matchedDesignId: 'od-commerce'
  },
  {
    id: 'settlement',
    name: 'quant-settlement-api',
    label: 'Quant Settlement API',
    path: '~/Projects/quant-settlement-api',
    gitInitialized: true,
    gitBranch: 'develop',
    gitCommit: '4d91e0b',
    detectedStack: ['firebase'],
    recommendedMode: 'slp',
    recommendedDesign: 'skip',
    matchedDesignId: 'od-factory'
  },
  {
    id: 'bio3d',
    name: 'protein-fold-studio',
    label: 'Protein Fold 3D Studio',
    path: '~/Projects/protein-fold-studio',
    gitInitialized: false,
    gitBranch: 'main',
    gitCommit: null,
    detectedStack: ['zcode', 'science'],
    recommendedMode: 'slp',
    recommendedDesign: 'generate',
    matchedDesignId: 'od-factory'
  }
];

const WIZ_STACK_CATALOG = {
  expo: { id: 'expo', badge: 'Expo / React Native detected', packId: 'Expo' },
  firebase: { id: 'firebase', badge: 'Firebase detected', packId: 'Firebase' },
  opendesign: { id: 'opendesign', badge: 'Existing Open Design folder detected', packId: null },
  zcode: { id: 'zcode', badge: '3D / ZCode detected', packId: '3D/ZCode' },
  science: { id: 'science', badge: 'Science & Bio detected', packId: 'Science' }
};

const WIZ_MODEL_CATALOG = {
  Codex: ['GPT-6.1', 'GPT-5.4 Pro', 'o4-mini-high'],
  Claude: ['Claude Opus 4.6', 'Claude Sonnet 4.5', 'Claude Haiku 4.5'],
  Pi: ['GLM-5.3', 'DeepSeek R2', 'Kimi K2.5'],
  OpenCode: ['Qwen 3 Coder', 'Llama 4 Maverick', 'Mistral Codestral']
};

const WIZ_THINKING_LEVELS = ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Max'];

const WIZ_SAVED_PROFILES = [
  {
    id: 'machine-default',
    name: 'Use Machine Default',
    tag: 'HOST DEFAULT',
    desc: 'Codex GPT-6.1 + Claude Sonnet 4.5 + Pi GLM-5.3.',
    slp: {
      supervisor: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      lead: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      dev: { provider: 'Pi', model: 'GLM-5.3', thinking: 'High' },
      watch: { provider: 'Pi', model: 'GLM-5.3', thinking: 'Medium' }
    },
    scrum: {
      supervisor: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      lead: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      pm: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      ux: { provider: 'Claude', model: 'Claude Sonnet 4.5', thinking: 'High' },
      architect: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      dev: { provider: 'Pi', model: 'GLM-5.3', thinking: 'High' },
      qa: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      watch: { provider: 'Pi', model: 'GLM-5.3', thinking: 'Medium' }
    }
  },
  {
    id: 'balanced',
    name: 'Balanced Default',
    tag: 'RECOMMENDED',
    desc: 'Best balance of reasoning speed, UI craft, and coding cost.',
    slp: {
      supervisor: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      lead: { provider: 'Claude', model: 'Claude Sonnet 4.5', thinking: 'High' },
      dev: { provider: 'Pi', model: 'GLM-5.3', thinking: 'High' },
      watch: { provider: 'Pi', model: 'GLM-5.3', thinking: 'Medium' }
    },
    scrum: {
      supervisor: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      lead: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      pm: { provider: 'Claude', model: 'Claude Sonnet 4.5', thinking: 'High' },
      ux: { provider: 'Claude', model: 'Claude Sonnet 4.5', thinking: 'High' },
      architect: { provider: 'Codex', model: 'GPT-6.1', thinking: 'Max' },
      dev: { provider: 'Pi', model: 'GLM-5.3', thinking: 'High' },
      qa: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' },
      watch: { provider: 'Pi', model: 'GLM-5.3', thinking: 'Medium' }
    }
  },
  {
    id: 'high-reasoning',
    name: 'High-Reasoning Opus + Codex',
    tag: 'DEEP ARCH',
    desc: 'Claude Opus 4.6 & GPT-6.1 with Max thinking for complex systems.',
    slp: {
      supervisor: { provider: 'Claude', model: 'Claude Opus 4.6', thinking: 'Max' },
      lead: { provider: 'Codex', model: 'GPT-6.1', thinking: 'Max' },
      dev: { provider: 'Claude', model: 'Claude Sonnet 4.5', thinking: 'High' },
      watch: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' }
    },
    scrum: {
      supervisor: { provider: 'Claude', model: 'Claude Opus 4.6', thinking: 'Max' },
      lead: { provider: 'Codex', model: 'GPT-6.1', thinking: 'Max' },
      pm: { provider: 'Claude', model: 'Claude Opus 4.6', thinking: 'High' },
      ux: { provider: 'Claude', model: 'Claude Opus 4.6', thinking: 'High' },
      architect: { provider: 'Codex', model: 'GPT-6.1', thinking: 'Max' },
      dev: { provider: 'Claude', model: 'Claude Sonnet 4.5', thinking: 'High' },
      qa: { provider: 'Codex', model: 'GPT-6.1', thinking: 'Max' },
      watch: { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' }
    }
  },
  {
    id: 'fast-economical',
    name: 'Fast & Economical',
    tag: 'LOW LATENCY',
    desc: 'GLM-5.3 & Qwen 3 Coder lanes for rapid iteration.',
    slp: {
      supervisor: { provider: 'Codex', model: 'o4-mini-high', thinking: 'Medium' },
      lead: { provider: 'Pi', model: 'GLM-5.3', thinking: 'Medium' },
      dev: { provider: 'OpenCode', model: 'Qwen 3 Coder', thinking: 'Medium' },
      watch: { provider: 'Pi', model: 'GLM-5.3', thinking: 'Low' }
    },
    scrum: {
      supervisor: { provider: 'Codex', model: 'o4-mini-high', thinking: 'Medium' },
      lead: { provider: 'Pi', model: 'GLM-5.3', thinking: 'Medium' },
      pm: { provider: 'Pi', model: 'GLM-5.3', thinking: 'Medium' },
      ux: { provider: 'Claude', model: 'Claude Haiku 4.5', thinking: 'Medium' },
      architect: { provider: 'Codex', model: 'o4-mini-high', thinking: 'High' },
      dev: { provider: 'OpenCode', model: 'Qwen 3 Coder', thinking: 'Medium' },
      qa: { provider: 'Pi', model: 'GLM-5.3', thinking: 'Medium' },
      watch: { provider: 'Pi', model: 'GLM-5.3', thinking: 'Low' }
    }
  }
];

const WIZ_OPEN_DESIGN_PROJECTS = [
  {
    id: 'od-fintech',
    name: 'Fintech SuperApp Design System',
    screens: 14,
    tokens: 'Graphite & Mint Tokens',
    updated: '12m ago',
    folder: '~/OpenDesign/projects/fintech-superapp-ui'
  },
  {
    id: 'od-factory',
    name: 'Factory Workspace Redesign',
    screens: 8,
    tokens: 'Cyan System · r3',
    updated: '2h ago',
    folder: '~/OpenDesign/projects/factory-workspace-r3'
  },
  {
    id: 'od-commerce',
    name: 'AI Commerce Mobile Kit',
    screens: 11,
    tokens: 'Dark Retail Tokens',
    updated: 'Yesterday',
    folder: '~/OpenDesign/projects/ai-commerce-kit'
  }
];

const WIZ_SKILL_PACKS = [
  {
    id: 'Expo',
    title: 'Expo & React Native (24 skills)',
    stackKey: 'expo',
    installedOnHost: true,
    short: 'Router, Native UI, Reanimated, EAS'
  },
  {
    id: 'Firebase',
    title: 'Firebase (13 skills)',
    stackKey: 'firebase',
    installedOnHost: true,
    short: 'Firestore, Security Rules, Auth'
  },
  {
    id: '3D/ZCode',
    title: '3D / ZCode (6 skills)',
    stackKey: 'zcode',
    installedOnHost: false,
    short: 'WebGL Shaders, Three.js, Mesh'
  },
  {
    id: 'Science',
    title: 'Science & Bio (28 skills)',
    stackKey: 'science',
    installedOnHost: false,
    short: 'AlphaFold, ChEMBL, RDKit, PyMOL'
  }
];

const WIZ_HELPER_MCPS = [
  { id: 'context7', name: 'context7', status: 'Connected', tone: 'green', defaultSynced: true },
  { id: 'exa', name: 'exa', status: 'Connected', tone: 'green', defaultSynced: true },
  { id: 'supabase', name: 'supabase', status: 'Auth Expired', tone: 'amber', defaultSynced: false },
  { id: 'chrome-devtools-mcp', name: 'chrome-devtools-mcp', status: 'Local on Host', tone: 'cyan', defaultSynced: true },
  { id: 'expo-mcp', name: 'expo-mcp', status: 'Connected', tone: 'green', defaultSynced: true }
];

state.projectDraft = null;
state.supervisorChats = state.supervisorChats || {};

function slugifyProjectName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'new-project';
}

function shortenHomePath(rawPath) {
  const clean = String(rawPath || '').trim().replace(/[\\/]+$/, '');
  if (!clean) return '~/Projects/new-project';
  return clean.replace(/^\/Users\/[^/]+/, '~').replace(/^C:\\Users\\[^\\]+/i, '~');
}

function wizCuteBadge(botId, spark = '✦') {
  const avatar = typeof botAvatar === 'function' ? botAvatar(botId) : icon('agents');
  return `<span class="wiz-cute-badge" aria-hidden="true">${avatar}<span class="wiz-cute-spark">${spark}</span></span>`;
}

function createInitialDraft(presetId = 'fintech') {
  const preset = WIZ_SAMPLE_FOLDERS.find(item => item.id === presetId) || WIZ_SAMPLE_FOLDERS[0];
  const preferredHost = fleetHost()?.status === 'online' ? fleetHost().id : 'mac-local';
  const defaultProfile = WIZ_SAVED_PROFILES[1];
  const packsInstalled = {};
  const packsEnabled = {};
  WIZ_SKILL_PACKS.forEach(pack => {
    packsInstalled[pack.id] = pack.installedOnHost || preset.detectedStack.includes(pack.stackKey);
    packsEnabled[pack.id] = preset.detectedStack.includes(pack.stackKey);
  });
  const mcpState = {};
  WIZ_HELPER_MCPS.forEach(mcp => {
    mcpState[mcp.id] = {
      status: mcp.status,
      tone: mcp.tone,
      synced: mcp.id === 'expo-mcp' ? preset.detectedStack.includes('expo') : mcp.defaultSynced
    };
  });

  return {
    step: 1,
    hostId: preferredHost,
    presetId: preset.id,
    localPath: preset.path,
    projectName: preset.label,
    projectSlug: preset.name,
    gitInitialized: preset.gitInitialized,
    gitBranch: preset.gitBranch || 'main',
    gitCommit: preset.gitCommit || 'a8f42c1',
    detectedStack: [...preset.detectedStack],
    mode: preset.recommendedMode,
    requireUIApproval: true,
    slpWaveDesign: true,
    modelSetupMode: 'preset', // 'preset' | 'custom'
    selectedProfileId: defaultProfile.id,
    roles: {
      slp: JSON.parse(JSON.stringify(defaultProfile.slp)),
      scrum: JSON.parse(JSON.stringify(defaultProfile.scrum))
    },
    newProfileName: '',
    profileSavedNotice: '',
    designScenario: preset.recommendedDesign, // 'link' | 'generate' | 'skip'
    linkedDesignId: preset.matchedDesignId || 'od-fintech',
    coreSkillsReady: true,
    packsInstalled,
    packsEnabled,
    mcpState,
    error: ''
  };
}

function applyPresetToDraft(d, preset) {
  d.presetId = preset.id;
  d.localPath = preset.path;
  d.projectName = preset.label;
  d.projectSlug = preset.name;
  d.gitInitialized = preset.gitInitialized;
  d.gitBranch = preset.gitBranch || 'main';
  d.gitCommit = preset.gitCommit || 'a8f42c1';
  d.detectedStack = [...preset.detectedStack];
  d.mode = preset.recommendedMode;
  d.designScenario = preset.recommendedDesign;
  d.linkedDesignId = preset.matchedDesignId || 'od-fintech';
  if (d.designScenario === 'generate' && d.mode === 'scrum') d.requireUIApproval = true;
  if (d.designScenario === 'skip') d.requireUIApproval = false;
  WIZ_SKILL_PACKS.forEach(pack => {
    const matched = d.detectedStack.includes(pack.stackKey);
    if (matched) d.packsInstalled[pack.id] = true;
    d.packsEnabled[pack.id] = matched;
  });
  if (d.mcpState['expo-mcp']) {
    d.mcpState['expo-mcp'].synced = d.detectedStack.includes('expo');
  }
  d.error = '';
}

function syncDraftFromPath(d, rawPath) {
  d.localPath = rawPath;
  const matchedPreset = WIZ_SAMPLE_FOLDERS.find(item => item.path.toLowerCase() === rawPath.trim().toLowerCase());
  if (matchedPreset) {
    applyPresetToDraft(d, matchedPreset);
    return;
  }
  d.presetId = 'custom';
  const leaf = rawPath.split(/[\\/]/).filter(Boolean).at(-1) || 'my-new-project';
  d.projectSlug = slugifyProjectName(leaf);
  d.projectName = leaf.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const lower = rawPath.toLowerCase();
  const isGreenfield = lower.includes('new') || lower.includes('greenfield') || lower.includes('init') || lower.includes('studio');
  d.gitInitialized = !isGreenfield;
  d.gitBranch = 'main';
  d.gitCommit = '9c3e1b4';
  const detected = [];
  if (lower.includes('expo') || lower.includes('mobile') || lower.includes('app')) detected.push('expo');
  if (lower.includes('fire') || lower.includes('supa') || lower.includes('fintech')) detected.push('firebase');
  if (lower.includes('3d') || lower.includes('zcode') || lower.includes('gl')) detected.push('zcode');
  if (lower.includes('bio') || lower.includes('protein') || lower.includes('science')) detected.push('science');
  if (!lower.includes('api') && !lower.includes('cli') && !lower.includes('backend')) detected.push('opendesign');
  d.detectedStack = detected.length ? detected : ['expo', 'opendesign'];
  WIZ_SKILL_PACKS.forEach(pack => {
    const has = d.detectedStack.includes(pack.stackKey);
    if (has) d.packsInstalled[pack.id] = true;
    d.packsEnabled[pack.id] = has;
  });
}

function wizActiveProfileName(d) {
  if (d.selectedProfileId === 'custom') return 'Custom Roster';
  const found = WIZ_SAVED_PROFILES.find(p => p.id === d.selectedProfileId);
  return found ? found.name : 'Balanced Default';
}

function wizEnabledPacksCount(d) {
  return WIZ_SKILL_PACKS.filter(p => d.packsEnabled[p.id]).length;
}

function wizSyncedMcpsCount(d) {
  return WIZ_HELPER_MCPS.filter(m => d.mcpState[m.id]?.synced).length;
}

function wizSyncTargetPath(d) {
  const shortRoot = shortenHomePath(d.localPath);
  return d.mode === 'slp'
    ? `${shortRoot}/design/`
    : `.scratch/init-${d.projectSlug.slice(0, 12)}/mockups/`;
}

/* STEP 1: Project Folder & Auto-Detection */
function renderWizStep1(d) {
  const shortPath = shortenHomePath(d.localPath);
  return `
    <div class="wiz-hero">
      <div class="wiz-hero-left">
        ${wizCuteBadge('pm', '✦')}
        <h3 class="wiz-hero-title">Project Folder</h3>
      </div>
    </div>

    <div class="wiz-folder-bar">
      <div class="wiz-path-box">
        ${icon('folder')}
        <label for="wiz-folder-path" class="sr-only">Project path</label>
        <input id="wiz-folder-path" value="${esc(d.localPath)}" placeholder="Paste path… (e.g. ~/Projects/my-app)" autocomplete="off" spellcheck="false">
      </div>
      <button type="button" class="btn primary" data-wiz-action="choose-folder">
        ${icon('folder')}
        <span>Choose Folder…</span>
      </button>
    </div>

    <div class="wiz-presets-row" role="group" aria-label="Sample folders">
      <span>Try sample:</span>
      ${WIZ_SAMPLE_FOLDERS.map(item => `
        <button type="button" class="wiz-preset-pill ${d.presetId === item.id ? 'active' : ''}" data-wiz-preset="${esc(item.id)}">
          ${icon(item.gitInitialized ? 'git' : 'plus')}
          <span>${esc(item.name)}</span>
        </button>
      `).join('')}
    </div>

    <section class="wiz-detect-panel" aria-label="Detected folder status">
      <div class="wiz-detect-row">
        <div class="wiz-proj-id">
          <span class="wiz-proj-icon">${esc(d.projectSlug.slice(0, 2).toUpperCase())}</span>
          <div>
            <div>
              <strong>${esc(d.projectName)}</strong>
              <span class="wiz-slug-tag">&lt;${esc(d.projectSlug)}&gt;</span>
            </div>
            <code class="wiz-proj-path">${esc(shortPath)}</code>
          </div>
        </div>
        <button type="button" class="btn ghost" data-wiz-action="toggle-git-sim" title="Switch between Git Repo and Greenfield state">
          ${icon('git')}
          <span>${d.gitInitialized ? 'Git Repo' : 'Greenfield'}</span>
        </button>
      </div>

      <div class="wiz-git-strip">
        <div class="wiz-git-strip-left">
          <span class="${d.gitInitialized ? 'green' : 'amber'}">${icon(d.gitInitialized ? 'git' : 'plus')}</span>
          ${d.gitInitialized ? `
            <span>Branch <code class="mono cyan">${esc(d.gitBranch)}</code> · HEAD <code class="mono">${esc(d.gitCommit)}</code></span>
          ` : `
            <span><strong>Greenfield folder — Auto-initialize Git repository on creation</strong></span>
          `}
        </div>
        ${d.gitInitialized ? badge('Git Ready', 'green', true) : badge('Auto-init Git', 'amber', true)}
      </div>

      <div class="wiz-stack-row" role="group" aria-label="Auto-detected stack">
        <span class="wiz-stack-label">Auto-detected:</span>
        ${Object.values(WIZ_STACK_CATALOG).map(st => {
          const on = d.detectedStack.includes(st.id);
          return `
            <button type="button" class="wiz-stack-pill ${on ? '' : 'off'}" data-wiz-toggle-stack="${esc(st.id)}" aria-pressed="${on}">
              ${icon(on ? 'check' : 'plus')}
              <span>${esc(st.badge)}</span>
            </button>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

/* STEP 2: Execution Mode (SLP vs. Agile Scrum) */
function renderWizStep2(d) {
  const isSlp = d.mode === 'slp';
  const isScrum = d.mode === 'scrum';
  return `
    <div class="wiz-hero">
      <div class="wiz-hero-left">
        ${wizCuteBadge('lead', '⚡')}
        <h3 class="wiz-hero-title">Execution Mode</h3>
      </div>
    </div>

    <div class="wiz-mode-cards" role="radiogroup" aria-label="Execution Mode">
      <!-- SLP -->
      <div class="wiz-mode-card ${isSlp ? 'selected' : ''}" role="radio" aria-checked="${isSlp}" tabindex="0" data-wiz-select-mode="slp">
        <div class="wiz-mode-head">
          <div class="wiz-mode-title">
            ${typeof botAvatar === 'function' ? botAvatar('supervisor') : icon('agents')}
            <div>
              <strong>SLP Loop</strong>
              <small>Supervisor – Lead – Peer Verification</small>
            </div>
          </div>
          <span class="wiz-check-circle">${isSlp ? icon('check') : ''}</span>
        </div>

        <p class="wiz-mode-summary">Serial waves in isolated worktrees with automated Mechanical Gate &amp; Watch verification.</p>

        <div class="wiz-topo" aria-label="SLP Topology">
          <div class="wiz-topo-tier">
            <span class="wiz-node-pill">Owner</span>
            <span class="wiz-topo-link">⇄</span>
            <span class="wiz-node-pill cyan">Supervisor</span>
            <span class="wiz-topo-link">⇄</span>
            <span class="wiz-node-pill cyan">Lead</span>
          </div>
          <div class="wiz-topo-link">⇅ Serial Waves (1..3 Worktrees)</div>
          <div class="wiz-topo-tier">
            <span class="wiz-node-pill green">Peer 1</span>
            <span class="wiz-node-pill green">Peer 2</span>
            <span class="wiz-node-pill green">Peer 3</span>
          </div>
          <div class="wiz-topo-link">↓ Mechanical Gate &amp; Watch</div>
        </div>
      </div>

      <!-- Agile Scrum -->
      <div class="wiz-mode-card ${isScrum ? 'selected' : ''}" role="radio" aria-checked="${isScrum}" tabindex="0" data-wiz-select-mode="scrum">
        <div class="wiz-mode-head">
          <div class="wiz-mode-title">
            ${typeof botAvatar === 'function' ? botAvatar('ux') : icon('flow')}
            <div>
              <strong>Agile Scrum</strong>
              <small>Autonomous Specialist Pipeline</small>
            </div>
          </div>
          <span class="wiz-check-circle">${isScrum ? icon('check') : ''}</span>
        </div>

        <p class="wiz-mode-summary">Full 5-stage specialist pipeline from PRD, UX Mockup &amp; Architecture to Senior Dev &amp; QA 4-Lens Audit.</p>

        <div class="wiz-topo" aria-label="Agile Scrum Topology">
          <div class="wiz-topo-tier">
            <span class="wiz-node-pill">Owner</span>
            <span class="wiz-topo-link">⇄</span>
            <span class="wiz-node-pill cyan">Supervisor</span>
            <span class="wiz-topo-link">⇄</span>
            <span class="wiz-node-pill cyan">Scrum Lead / PO</span>
          </div>
          <div class="wiz-topo-link">↓ 5-Stage Pipeline</div>
          <div class="wiz-scrum-mini-stages">
            <span><b>1. PM</b>Analyst</span>
            <span><b>2. UX∥AR</b>Design</span>
            <span class="gate"><b>3. GATE</b>UI Gate</span>
            <span><b>4. DEV</b>Build</span>
            <span><b>5. QA</b>4-Lens</span>
          </div>
          <div class="wiz-topo-link" style="color:var(--green)">↶ QA 4-Lens Audit &amp; Fix Loop</div>
        </div>
      </div>
    </div>

    ${isScrum ? `
      <div class="wiz-gate-toggle-row">
        <div class="wiz-gate-toggle-left">
          ${typeof botAvatar === 'function' ? botAvatar('gate') : icon('shield')}
          <div>
            <strong>Require UI Approval ${badge(d.requireUIApproval ? 'ON · Stage 3 Gate' : 'OFF', d.requireUIApproval ? 'amber' : '')}</strong>
            <small>Pause at Stage 3 so you can preview and approve UI mockups before Senior Dev codes.</small>
          </div>
        </div>
        <button type="button" class="switch ${d.requireUIApproval ? 'on' : ''}" role="switch" aria-checked="${d.requireUIApproval}" aria-label="Require UI Approval" data-wiz-action="toggle-ui-approval"></button>
      </div>
    ` : ''}
  `;
}

/* STEP 3: Model Roster & Profiles */
function renderWizStep3(d) {
  const isScrum = d.mode === 'scrum';
  const roleDefs = isScrum
    ? [
        ['supervisor', 'Supervisor', 'Authority'],
        ['lead', 'Scrum Lead / PO', 'Coordinator'],
        ['pm', 'PM / Analyst', 'Stage 1 · PRD'],
        ['ux', 'UX Designer', 'Stage 2 · UI'],
        ['architect', 'System Architect', 'Stage 2 · Arch'],
        ['dev', 'Senior Dev', 'Stage 4 · Code'],
        ['qa', 'QA / Test Architect', 'Stage 5 · Audit'],
        ['watch', 'Watch & Retro', 'Feedback']
      ]
    : [
        ['supervisor', 'Supervisor', 'Authority'],
        ['lead', 'Lead', 'Wave Coordinator'],
        ['dev', 'Default Worker', 'Working Peers'],
        ['watch', 'Watch & Retro', 'Gate & Retro']
      ];

  const activeRoster = d.roles[d.mode];

  return `
    <div class="wiz-hero">
      <div class="wiz-hero-left">
        ${wizCuteBadge('architect', '★')}
        <h3 class="wiz-hero-title">Model Roster</h3>
      </div>
      <div class="wiz-seg-tabs" role="group" aria-label="Model setup mode">
        <button type="button" class="${d.modelSetupMode === 'preset' ? 'selected' : ''}" data-wiz-model-mode="preset">Quick Preset</button>
        <button type="button" class="${d.modelSetupMode === 'custom' ? 'selected' : ''}" data-wiz-model-mode="custom">Customize per Role (${roleDefs.length})</button>
      </div>
    </div>

    ${d.modelSetupMode === 'preset' ? `
      <div class="wiz-preset-cards" role="radiogroup" aria-label="Saved Profiles">
        ${WIZ_SAVED_PROFILES.map(prof => {
          const selected = d.selectedProfileId === prof.id;
          return `
            <button type="button" class="wiz-preset-card ${selected ? 'selected' : ''}" role="radio" aria-checked="${selected}" data-wiz-apply-profile="${esc(prof.id)}">
              <div class="wiz-preset-card-top">
                ${badge(prof.tag, selected ? 'cyan' : '')}
                <span class="wiz-check-circle">${selected ? icon('check') : ''}</span>
              </div>
              <strong>${esc(prof.name)}</strong>
              <small>${esc(prof.desc)}</small>
            </button>
          `;
        }).join('')}
      </div>

      <div class="wiz-save-bar">
        <span class="tiny muted">Want to tweak individual providers, models, or thinking levels?</span>
        <button type="button" class="btn ghost" data-wiz-model-mode="custom">
          ${icon('settings')}
          <span>Customize ${roleDefs.length} roles →</span>
        </button>
      </div>
    ` : `
      <div class="wiz-role-list">
        ${roleDefs.map(([roleId, roleName, subtitle]) => {
          const cfg = activeRoster[roleId] || { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' };
          const providerModels = WIZ_MODEL_CATALOG[cfg.provider] || WIZ_MODEL_CATALOG.Codex;
          const modelsList = providerModels.includes(cfg.model) ? providerModels : [cfg.model, ...providerModels];
          return `
            <article class="wiz-role-item" aria-label="${esc(roleName)}">
              <div class="wiz-role-top">
                ${typeof botAvatar === 'function' ? botAvatar(roleId) : ''}
                <div class="od-fill">
                  <strong>${esc(roleName)}</strong>
                  <small>${esc(subtitle)}</small>
                </div>
              </div>
              <div class="wiz-role-selects">
                <select data-wiz-role="${esc(roleId)}" data-wiz-field="provider" aria-label="${esc(roleName)} Provider">
                  ${Object.keys(WIZ_MODEL_CATALOG).map(prov => `<option value="${esc(prov)}" ${cfg.provider === prov ? 'selected' : ''}>${esc(prov)}</option>`).join('')}
                </select>
                <select data-wiz-role="${esc(roleId)}" data-wiz-field="model" aria-label="${esc(roleName)} Model">
                  ${modelsList.map(m => `<option value="${esc(m)}" ${cfg.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
                </select>
                <select data-wiz-role="${esc(roleId)}" data-wiz-field="thinking" aria-label="${esc(roleName)} Thinking">
                  ${WIZ_THINKING_LEVELS.map(tl => `<option value="${esc(tl)}" ${cfg.thinking === tl ? 'selected' : ''}>${esc(tl)}</option>`).join('')}
                </select>
              </div>
            </article>
          `;
        }).join('')}
      </div>

      <div class="wiz-save-bar">
        <div class="od-row" style="flex-wrap:wrap;flex:1">
          <label for="wiz-new-profile-name" class="sr-only">New Profile Name</label>
          <input id="wiz-new-profile-name" value="${esc(d.newProfileName)}" placeholder="Profile name (e.g. Team Opus)…" autocomplete="off">
          <button type="button" class="btn ghost" data-wiz-action="save-new-profile">
            ${icon('plus')}
            <span>+ Save current setup as New Profile</span>
          </button>
        </div>
        ${d.profileSavedNotice ? `<span class="green tiny">${icon('check')} ${esc(d.profileSavedNotice)}</span>` : ''}
      </div>
    `}
  `;
}

/* STEP 4: Open Design Integration */
function renderWizStep4(d) {
  const isScrum = d.mode === 'scrum';
  const syncPath = wizSyncTargetPath(d);
  return `
    <div class="wiz-hero">
      <div class="wiz-hero-left">
        ${wizCuteBadge('ux', '♥')}
        <h3 class="wiz-hero-title">Open Design</h3>
      </div>
    </div>

    <div class="wiz-od-stack" role="radiogroup" aria-label="Open Design Integration">
      <!-- 1. Link Open Design Project -->
      <div class="wiz-od-item ${d.designScenario === 'link' ? 'selected' : ''}">
        <button type="button" class="wiz-od-head" role="radio" aria-checked="${d.designScenario === 'link'}" data-wiz-design-scenario="link">
          <span class="wiz-check-circle">${d.designScenario === 'link' ? icon('check') : ''}</span>
          <div class="od-fill">
            <strong>Link Open Design Project</strong>
            <small>Sync an existing design project from your Mac into <code>${esc(syncPath)}</code></small>
          </div>
          ${d.detectedStack.includes('opendesign') ? badge('Auto-detected', 'green') : ''}
        </button>

        ${d.designScenario === 'link' ? `
          <div class="wiz-od-detail">
            <div class="wiz-od-projects" role="listbox" aria-label="Open Design projects">
              ${WIZ_OPEN_DESIGN_PROJECTS.map(od => {
                const chosen = d.linkedDesignId === od.id;
                return `
                  <button type="button" class="wiz-od-proj-btn ${chosen ? 'selected' : ''}" role="option" aria-selected="${chosen}" data-wiz-select-od="${esc(od.id)}">
                    <div>
                      <strong>${esc(od.name)}</strong>
                      <small>${od.screens} screens · ${esc(od.tokens)} · ${esc(od.updated)}</small>
                    </div>
                    <span class="cyan">${chosen ? icon('check') : icon('chevron')}</span>
                  </button>
                `;
              }).join('')}
            </div>
            <div class="od-row" style="justify-content:space-between;flex-wrap:wrap">
              <span class="tiny muted">Auto-sync target: <code class="mono cyan">${esc(syncPath)}</code></span>
              <button type="button" class="btn ghost" data-wiz-action="choose-od-folder">
                ${icon('folder')}
                <span>Choose Open Design folder…</span>
              </button>
            </div>
          </div>
        ` : ''}
      </div>

      <!-- 2. Generate UI Mockups in Workflow -->
      <div class="wiz-od-item ${d.designScenario === 'generate' ? 'selected' : ''}">
        <button type="button" class="wiz-od-head" role="radio" aria-checked="${d.designScenario === 'generate'}" data-wiz-design-scenario="generate">
          <span class="wiz-check-circle">${d.designScenario === 'generate' ? icon('check') : ''}</span>
          <div class="od-fill">
            <strong>Generate UI Mockups in Workflow</strong>
            <small>Have AI agents generate <code>DESIGN.md</code>, <code>EXPERIENCE.md</code> &amp; interactive mockups</small>
          </div>
          ${badge('AI Mockups', 'amber')}
        </button>

        ${d.designScenario === 'generate' ? `
          <div class="wiz-od-detail">
            ${isScrum ? `
              <div class="od-row" style="justify-content:space-between;flex-wrap:wrap">
                <span class="tiny" style="color:#ffd88e">Stage 2 UX Designer generates <code>mockups/index.html</code> and pauses at Stage 3 for your review.</span>
                ${badge('Require UI Approval = ON', 'amber', true)}
              </div>
            ` : `
              <div class="od-row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
                <span class="tiny muted">Lead can run Wave 1 for UI system design, or switch to Agile Scrum for full UI Gate review.</span>
                <button type="button" class="btn ghost" data-wiz-action="switch-to-scrum-for-ui">
                  ${icon('flow')}
                  <span>Switch to Agile Scrum</span>
                </button>
              </div>
            `}
          </div>
        ` : ''}
      </div>

      <!-- 3. Skip -->
      <div class="wiz-od-item ${d.designScenario === 'skip' ? 'selected' : ''}">
        <button type="button" class="wiz-od-head" role="radio" aria-checked="${d.designScenario === 'skip'}" data-wiz-design-scenario="skip">
          <span class="wiz-check-circle">${d.designScenario === 'skip' ? icon('check') : ''}</span>
          <div class="od-fill">
            <strong>Skip — Backend / CLI / API Project</strong>
            <small>No UI design connection${isScrum ? ' · Automatically sets Require UI Approval = OFF' : ''}</small>
          </div>
          ${badge('Headless', '')}
        </button>
      </div>
    </div>
  `;
}

/* STEP 5: Project Skill Packs, Helper MCPs & Launch */
function renderWizStep5(d) {
  const selectedOd = WIZ_OPEN_DESIGN_PROJECTS.find(o => o.id === d.linkedDesignId) || WIZ_OPEN_DESIGN_PROJECTS[0];
  return `
    <div class="wiz-hero">
      <div class="wiz-hero-left">
        ${wizCuteBadge('dev', '✦')}
        <h3 class="wiz-hero-title">Skills &amp; MCPs</h3>
      </div>
      ${badge(`${wizEnabledPacksCount(d)} Packs · ${wizSyncedMcpsCount(d)} MCPs`, 'green', true)}
    </div>

    <!-- Core Factory Skills -->
    <div class="wiz-core-bar ${d.coreSkillsReady ? '' : 'missing'}">
      <div class="od-row">
        <span class="${d.coreSkillsReady ? 'green' : 'amber'}">${icon('shield')}</span>
        <div>
          <strong style="font-size:12.5px">Core Factory Skills (<code>factory-skills-pack</code>)</strong>
          ${d.coreSkillsReady ? badge('Ready', 'green', true) : badge('Missing', 'amber', true)}
        </div>
      </div>
      ${d.coreSkillsReady ? `
        <button type="button" class="btn ghost" data-wiz-action="toggle-core-skills-sim">Simulate Missing</button>
      ` : `
        <button type="button" class="btn primary" data-wiz-action="install-core-skills">
          ${icon('plus')}
          <span>Install Required Core Skills</span>
        </button>
      `}
    </div>

    <!-- Project Skill Packs -->
    <div class="wiz-section-caption">
      <span>PROJECT SKILL PACKS</span>
      <span class="tiny muted">Auto-detected from Step 1</span>
    </div>
    <div class="wiz-packs-grid">
      ${WIZ_SKILL_PACKS.map(pack => {
        const autoDetected = d.detectedStack.includes(pack.stackKey);
        const installed = Boolean(d.packsInstalled[pack.id]);
        const enabled = Boolean(d.packsEnabled[pack.id]);
        return `
          <div class="wiz-pack-item ${enabled ? 'enabled' : ''}">
            <div class="od-fill">
              <div class="od-row" style="gap:6px;flex-wrap:wrap">
                <strong>${esc(pack.title)}</strong>
                ${autoDetected ? badge('Auto-detected', 'cyan') : ''}
              </div>
              <small>${esc(pack.short)}</small>
            </div>
            ${installed ? `
              <button type="button" class="switch ${enabled ? 'on' : ''}" role="switch" aria-checked="${enabled}" aria-label="Toggle ${esc(pack.title)}" data-wiz-toggle-pack="${esc(pack.id)}"></button>
            ` : `
              <button type="button" class="btn primary" data-wiz-install-pack="${esc(pack.id)}">Install Pack</button>
            `}
          </div>
        `;
      }).join('')}
    </div>

    <!-- Helper MCP Servers -->
    <div class="wiz-section-caption">
      <span>HELPER MCP SERVERS FOR WORKING PEERS</span>
    </div>
    <div class="wiz-mcp-grid">
      ${WIZ_HELPER_MCPS.map(mcp => {
        const st = d.mcpState[mcp.id] || { status: mcp.status, tone: mcp.tone, synced: mcp.defaultSynced };
        return `
          <div class="wiz-mcp-item ${st.synced ? 'synced' : ''}">
            <div class="wiz-mcp-info">
              <strong>${esc(mcp.name)}</strong>
              <div class="wiz-mcp-submeta">
                ${badge(st.status, st.tone, true)}
                <span class="wiz-mcp-tag">stdio</span>
              </div>
            </div>
            <button type="button" class="btn ${st.synced ? 'primary' : 'ghost'}" data-wiz-sync-mcp="${esc(mcp.id)}" aria-pressed="${st.synced}">
              <span>${st.synced ? 'Synced' : '+ Sync to Peer'}</span>
            </button>
          </div>
        `;
      }).join('')}
    </div>

    <!-- Compact Review Strip -->
    <div class="wiz-summary-strip" aria-label="Project Summary">
      ${typeof botAvatar === 'function' ? botAvatar('supervisor') : icon('agents')}
      <div class="wiz-summary-pills">
        <strong>${esc(d.projectName)}</strong>
        <span class="muted">·</span>
        ${badge(d.mode === 'scrum' ? `Agile Scrum${d.requireUIApproval ? ' · UI Gate ON' : ''}` : 'SLP Loop', 'cyan')}
        ${badge(wizActiveProfileName(d), '')}
        ${badge(d.designScenario === 'link' ? `Design: ${selectedOd.name}` : d.designScenario === 'generate' ? 'AI Mockups' : 'No UI', '')}
      </div>
    </div>
  `;
}

function renderWizardBody() {
  const d = state.projectDraft;
  if (!d) return '';

  const stageHtml =
    d.step === 1 ? renderWizStep1(d) :
    d.step === 2 ? renderWizStep2(d) :
    d.step === 3 ? renderWizStep3(d) :
    d.step === 4 ? renderWizStep4(d) :
    renderWizStep5(d);

  return `
    <div class="wiz-stage" id="wiz-stage-scroll">
      ${stageHtml}
      ${d.error ? `<p class="error" role="alert">${esc(d.error)}</p>` : ''}
    </div>

    <footer class="wiz-footer">
      <div class="wiz-footer-left">
        ${d.step === 1 ? `
          <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        ` : `
          <button type="button" class="btn ghost" data-wiz-action="prev-step">← Back</button>
        `}
      </div>

      <div class="wiz-footer-right">
        ${d.step < 5 ? `
          <button type="button" class="btn wiz-btn-next" data-wiz-action="next-step">
            <span>Next →</span>
          </button>
        ` : `
          <button type="button" class="btn wiz-btn-board" data-wiz-action="create-open-board">
            ${icon('flow')}
            <span>Create Project &amp; Open Board</span>
          </button>
          <button type="button" class="btn wiz-btn-next" data-wiz-action="create-open-supervisor">
            <span>Create Project &amp; Open Supervisor Chat ↗</span>
          </button>
        `}
      </div>
    </footer>
  `;
}

function paintOnboardingWizard(resetScroll = false) {
  const d = state.projectDraft;
  const modal = $('#modal');
  if (!d || !modal) return;
  modal.classList.add('onboarding-dialog');
  modal.classList.remove('wide');

  const steps = [
    [1, 'Folder'],
    [2, 'Mode'],
    [3, 'Models'],
    [4, 'Design'],
    [5, 'Skills & Launch']
  ];

  const headTitle = $('#modal-title');
  if (headTitle) {
    headTitle.innerHTML = `
      <div class="wiz-top-bar">
        <span class="wiz-brand-pill">
          ${typeof botAvatar === 'function' ? botAvatar('supervisor') : icon('plus')}
          <span>New Project</span>
        </span>
        <nav class="wiz-steps-rail" aria-label="Onboarding steps">
          ${steps.map(([num, label]) => {
            const active = d.step === num;
            const done = num < d.step;
            return `
              <button type="button" class="wiz-step-dot ${active ? 'active' : ''} ${done ? 'done' : ''}" data-wiz-goto="${num}" aria-current="${active ? 'step' : 'false'}">
                <b>${done ? '✓' : num}</b>
                <span>${esc(label)}</span>
              </button>
            `;
          }).join('')}
        </nav>
      </div>
    `;
  }

  const prevScroll = $('#wiz-stage-scroll')?.scrollTop || 0;
  $('#modal-body').innerHTML = renderWizardBody();
  refreshIcons($('#modal'));
  const nextScroll = $('#wiz-stage-scroll');
  if (nextScroll) nextScroll.scrollTop = resetScroll ? 0 : prevScroll;
}

fleetAddProject = function (presetId = 'fintech') {
  state.projectDraft = createInitialDraft(presetId);
  const modal = $('#modal');
  returnFocus = document.activeElement;
  paintOnboardingWizard(true);
  if (!modal.open) modal.showModal();
  const firstInput = $('#wiz-folder-path') || $('button', $('#modal-body'));
  firstInput?.focus({ preventScroll: true });
};

/* Commit Project Creation & Launch either Supervisor Chat or Board */
function finalizeProjectOnboarding(openSupervisorChat = true) {
  const d = state.projectDraft;
  if (!d) return;

  const pathClean = String(d.localPath || '').trim().replace(/[\\/]+$/, '');
  if (!pathClean) {
    d.error = 'Please choose a project folder or enter a path in Step 1.';
    d.step = 1;
    paintOnboardingWizard(true);
    $('#wiz-folder-path')?.focus();
    return;
  }

  const hostId = d.hostId || 'mac-local';
  let slug = d.projectSlug || slugifyProjectName(pathClean.split(/[\\/]/).at(-1));
  if (state.projects.some(p => p.hostId === hostId && p.name === slug)) {
    slug = `${slug}-${Math.floor(100 + Math.random() * 899)}`;
  }

  const selectedOd = WIZ_OPEN_DESIGN_PROJECTS.find(o => o.id === d.linkedDesignId) || WIZ_OPEN_DESIGN_PROJECTS[0];
  const enabledPacks = WIZ_SKILL_PACKS.filter(p => d.packsEnabled[p.id]).map(p => p.id);
  const syncedMcpList = WIZ_HELPER_MCPS.map(m => ({
    name: m.name,
    transport: 'stdio',
    synced: Boolean(d.mcpState[m.id]?.synced),
    health: d.mcpState[m.id]?.status === 'Connected' ? 'Sample connected' : d.mcpState[m.id]?.status || 'Not checked',
    targets: ['Pi', 'Claude', 'Codex', 'OpenCode'],
    vault: false
  }));

  const newProj = {
    name: slug,
    label: d.projectName || slug,
    path: shortenHomePath(pathClean),
    hostId,
    mode: d.mode,
    snapshot: true,
    source: 'local',
    gitBranch: d.gitBranch || 'main',
    gitCommit: d.gitInitialized ? d.gitCommit : 'init-001',
    gitGreenfieldInit: !d.gitInitialized,
    detectedStack: [...d.detectedStack],
    designScenario: d.designScenario,
    linkedDesignName: d.designScenario === 'link' ? selectedOd.name : null,
    syncTargetPath: wizSyncTargetPath(d)
  };

  state.projects.unshift(newProj);
  const key = scopeKey(newProj.name, newProj.hostId);

  const projState = fleetCopy(fleetDefaults);
  projState.approval = d.mode === 'scrum' ? Boolean(d.requireUIApproval) : false;
  projState.linkedDesign = d.designScenario !== 'skip';
  projState.linkedPacks = enabledPacks;
  projState.profile = wizActiveProfileName(d);
  projState.designDecision = d.designScenario === 'skip' ? 'waive' : null;
  state.fleetProjectState[key] = projState;

  const activeRoles = d.roles[d.mode] || {};
  Object.entries(activeRoles).forEach(([roleId, cfg]) => {
    state.nextModels[`${key}:${d.mode}:${roleId}`] = { ...cfg };
  });

  if (state.fleetHostState[hostId]) {
    state.fleetHostState[hostId].mcps = syncedMcpList;
  }
  state.mcps = syncedMcpList;
  state.linkedPacks = enabledPacks;
  state.approval = projState.approval;
  state.linkedDesign = projState.linkedDesign;
  state.profile = projState.profile;

  if (d.mode === 'scrum') {
    state.tasks.unshift(
      {
        id: 'SCR-101',
        project: newProj.name,
        hostId: newProj.hostId,
        mode: 'scrum',
        role: 'PM',
        title: `Draft PRD & Sprint Backlog for ${newProj.label}`,
        status: 'running',
        agent: 'pm',
        cost: 0.18,
        attempts: ['open'],
        artifact: 'prd.md · sprint-backlog.md'
      },
      {
        id: 'SCR-102',
        project: newProj.name,
        hostId: newProj.hostId,
        mode: 'scrum',
        role: 'UX',
        title: d.designScenario === 'link'
          ? `Sync ${selectedOd.name} into ${wizSyncTargetPath(d)}`
          : 'Generate DESIGN.md, EXPERIENCE.md & mockups/index.html',
        status: d.designScenario === 'skip' ? 'accepted' : 'queued',
        agent: 'ux',
        cost: 0,
        attempts: d.designScenario === 'skip' ? ['green'] : [],
        artifact: 'DESIGN.md · mockups/index.html'
      },
      {
        id: 'SCR-103',
        project: newProj.name,
        hostId: newProj.hostId,
        mode: 'scrum',
        role: 'Arch',
        title: 'Define system architecture & contracts',
        status: 'queued',
        agent: 'architect',
        cost: 0,
        attempts: [],
        artifact: 'architecture.md'
      }
    );
  } else {
    state.tasks.unshift(
      {
        id: 'SLP-101',
        project: newProj.name,
        hostId: newProj.hostId,
        mode: 'slp',
        role: 'Peer',
        title: `Wave 1: Core foundation & Mechanical Gate for ${newProj.label}`,
        status: 'running',
        agent: 'peer-1',
        cost: 0.14,
        attempts: ['open'],
        artifact: 'packages/core/ · contract-wave-1.md'
      },
      {
        id: 'SLP-102',
        project: newProj.name,
        hostId: newProj.hostId,
        mode: 'slp',
        role: 'Peer',
        title: 'Set up automated verification suite & Skill Packs',
        status: 'queued',
        agent: 'peer-2',
        cost: 0,
        attempts: [],
        artifact: 'tests/verification.spec.ts'
      }
    );
  }

  const supCfg = activeRoles.supervisor || { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' };
  state.supervisorChats[key] = [
    {
      sender: 'agent',
      time: 'Just now',
      text: `**${newProj.label}** (\`${newProj.path}\`) is ready! Configured with **${d.mode === 'scrum' ? 'Agile Scrum' : 'SLP'}**, **${wizActiveProfileName(d)}**, ${enabledPacks.length} Skill Packs, and ${syncedMcpList.filter(m => m.synced).length} synced MCPs. What would you like to build first?`
    }
  ];

  if (!state.pinnedProjects.includes(key)) {
    state.pinnedProjects.unshift(key);
  }

  state.projectDraft = null;
  $('#modal')?.classList.remove('onboarding-dialog');
  selectFleetProject(newProj.hostId, newProj.name, 'flow');

  if (openSupervisorChat) {
    openAgentDrawer('supervisor');
    setTimeout(() => {
      $('#sup-chat-input')?.focus({ preventScroll: true });
    }, 60);
    notify(`Created "${newProj.label}" and opened Supervisor Chat (${supCfg.model}).`);
  } else {
    notify(`Created "${newProj.label}" and opened the Workspace Board.`);
  }
}

/* Interactive Supervisor Chat inside the Agent Drawer */
function renderSupervisorLiveChatBox() {
  const key = scopeKey();
  const p = project();
  if (!p) return '';
  if (!state.supervisorChats[key]) {
    state.supervisorChats[key] = [
      {
        sender: 'agent',
        time: 'Ready',
        text: `Hi Owner! I'm the **Supervisor** for **${fleetProjectName(p)}** (${mode() === 'scrum' ? 'Agile Scrum' : 'SLP'}). Send your first prompt below to dispatch the team.`
      }
    ];
  }
  const messages = state.supervisorChats[key];
  const supModel = laneConfig('supervisor');
  return `
    <section class="sup-chat-panel" aria-label="Supervisor Live Chat">
      <div class="sup-chat-head">
        <strong>${icon('agents')} <span>Supervisor Chat</span></strong>
        ${badge(`${supModel.provider} · ${supModel.model}`, 'cyan')}
      </div>
      <div class="sup-chat-messages" id="sup-chat-messages">
        ${messages.map(m => `
          <div class="sup-msg ${m.sender === 'owner' ? 'owner' : 'agent'}">
            <small>${m.sender === 'owner' ? 'You (Owner)' : 'Supervisor'} · ${esc(m.time)}</small>
            <div>${esc(m.text)}</div>
          </div>
        `).join('')}
      </div>
      <div class="sup-chat-chips">
        <button type="button" class="sup-chat-chip" data-sup-quick="Scaffold the core app routes and authentication flow">+ Scaffold auth &amp; routes</button>
        <button type="button" class="sup-chat-chip" data-sup-quick="Generate UI mockups for the main screens and pause for approval">+ Generate UI mockups</button>
        <button type="button" class="sup-chat-chip" data-sup-quick="Run verification gates and summarize status">+ Check Gate status</button>
      </div>
      <div class="sup-chat-compose">
        <label for="sup-chat-input" class="sr-only">Message Supervisor</label>
        <input id="sup-chat-input" placeholder="Message Supervisor (Press Enter)…" autocomplete="off">
        <button type="button" class="btn primary" data-wiz-action="send-sup-msg">${icon('arrow')}<span>Send</span></button>
      </div>
    </section>
  `;
}

function installSupervisorChatHooks() {
  if (window.__supChatHooksInstalled) return;
  window.__supChatHooksInstalled = true;

  const finalDrawerMarkup = typeof drawerMarkup === 'function' ? drawerMarkup : null;
  if (finalDrawerMarkup) {
    drawerMarkup = function (id) {
      const html = finalDrawerMarkup(id);
      const isFeaturePanel = (mode() === 'slp' && typeof slpActivePanel === 'function' && slpActivePanel()) ||
                             (mode() === 'scrum' && state.scrumPanel?.scope === scopeKey() && state.scrumPanel?.id);
      if (id === 'supervisor' && !isFeaturePanel) {
        return html.replace(/(<div class="agent-drawer-body"[^>]*>)/, `$1${renderSupervisorLiveChatBox()}`);
      }
      return html;
    };
  }

  const finalOpenAgent = typeof openAgent === 'function' ? openAgent : null;
  openAgent = function (id) {
    if (id === 'supervisor' && state.project !== 'all') {
      if (state.scrumPanel) state.scrumPanel = null;
      if (state.slpDrawerPanel) state.slpDrawerPanel = null;
      openAgentDrawer('supervisor');
      setTimeout(() => $('#sup-chat-input')?.focus({ preventScroll: true }), 50);
      return;
    }
    if (finalOpenAgent) return finalOpenAgent(id);
  };
}

function sendSupervisorChatMessage(rawText) {
  const text = String(rawText || $('#sup-chat-input')?.value || '').trim();
  if (!text) return;
  const key = scopeKey();
  state.supervisorChats[key] = state.supervisorChats[key] || [];
  state.supervisorChats[key].push({ sender: 'owner', time: 'Just now', text });
  const reply = mode() === 'scrum'
    ? `Got it: "${text}". Dispatched to Scrum Lead / PO to update the backlog and coordinate specialist stages.`
    : `Got it: "${text}". Dispatched to Lead to package a bounded Contract for the active Peer wave.`;
  state.supervisorChats[key].push({ sender: 'agent', time: 'Just now', text: reply });
  log(`Owner directive to Supervisor: ${text}`, '', 'cyan', 'agents');
  mountAgentDrawer();
  const box = $('#sup-chat-messages');
  if (box) box.scrollTop = box.scrollHeight;
  $('#sup-chat-input')?.focus({ preventScroll: true });
}

const wizCloseModalBefore = closeModal;
closeModal = function () {
  state.projectDraft = null;
  $('#modal')?.classList.remove('onboarding-dialog');
  wizCloseModalBefore();
};

const wizOpenModalBefore = openModal;
openModal = function (...args) {
  state.projectDraft = null;
  $('#modal')?.classList.remove('onboarding-dialog');
  return wizOpenModalBefore(...args);
};

/* Event Delegation */
document.addEventListener('click', event => {
  const btn = event.target.closest('[data-wiz-goto],[data-wiz-preset],[data-wiz-toggle-stack],[data-wiz-select-mode],[data-wiz-model-mode],[data-wiz-apply-profile],[data-wiz-design-scenario],[data-wiz-select-od],[data-wiz-toggle-pack],[data-wiz-install-pack],[data-wiz-sync-mcp],[data-wiz-action],[data-sup-quick]');
  if (!btn) return;

  if (btn.dataset.supQuick) {
    sendSupervisorChatMessage(btn.dataset.supQuick);
    return;
  }
  if (btn.dataset.wizAction === 'send-sup-msg') {
    sendSupervisorChatMessage();
    return;
  }

  const d = state.projectDraft;
  if (!d) return;

  if (btn.dataset.wizGoto) {
    d.step = Number(btn.dataset.wizGoto);
    d.error = '';
    paintOnboardingWizard(true);
    return;
  }

  if (btn.dataset.wizPreset) {
    const preset = WIZ_SAMPLE_FOLDERS.find(item => item.id === btn.dataset.wizPreset);
    if (preset) {
      applyPresetToDraft(d, preset);
      paintOnboardingWizard(false);
    }
    return;
  }

  if (btn.dataset.wizToggleStack) {
    const stackId = btn.dataset.wizToggleStack;
    if (d.detectedStack.includes(stackId)) {
      d.detectedStack = d.detectedStack.filter(x => x !== stackId);
    } else {
      d.detectedStack.push(stackId);
    }
    const pack = WIZ_SKILL_PACKS.find(p => p.stackKey === stackId);
    if (pack) {
      const has = d.detectedStack.includes(stackId);
      if (has) d.packsInstalled[pack.id] = true;
      d.packsEnabled[pack.id] = has;
    }
    paintOnboardingWizard(false);
    return;
  }

  if (btn.dataset.wizSelectMode) {
    d.mode = btn.dataset.wizSelectMode === 'scrum' ? 'scrum' : 'slp';
    if (d.mode === 'scrum' && d.designScenario === 'generate') {
      d.requireUIApproval = true;
    }
    paintOnboardingWizard(false);
    return;
  }

  if (btn.dataset.wizModelMode) {
    d.modelSetupMode = btn.dataset.wizModelMode;
    paintOnboardingWizard(true);
    return;
  }

  if (btn.dataset.wizApplyProfile) {
    const prof = WIZ_SAVED_PROFILES.find(p => p.id === btn.dataset.wizApplyProfile);
    if (prof) {
      d.selectedProfileId = prof.id;
      d.roles.slp = JSON.parse(JSON.stringify(prof.slp));
      d.roles.scrum = JSON.parse(JSON.stringify(prof.scrum));
      d.profileSavedNotice = '';
      paintOnboardingWizard(false);
    }
    return;
  }

  if (btn.dataset.wizDesignScenario) {
    const sc = btn.dataset.wizDesignScenario;
    d.designScenario = sc;
    if (sc === 'generate' && d.mode === 'scrum') {
      d.requireUIApproval = true;
    } else if (sc === 'skip') {
      d.requireUIApproval = false;
    }
    paintOnboardingWizard(false);
    return;
  }

  if (btn.dataset.wizSelectOd) {
    d.linkedDesignId = btn.dataset.wizSelectOd;
    paintOnboardingWizard(false);
    return;
  }

  if (btn.dataset.wizTogglePack) {
    const packId = btn.dataset.wizTogglePack;
    d.packsEnabled[packId] = !d.packsEnabled[packId];
    paintOnboardingWizard(false);
    return;
  }

  if (btn.dataset.wizInstallPack) {
    const packId = btn.dataset.wizInstallPack;
    d.packsInstalled[packId] = true;
    d.packsEnabled[packId] = true;
    paintOnboardingWizard(false);
    notify(`Installed and enabled "${packId}" skill pack.`);
    return;
  }

  if (btn.dataset.wizSyncMcp) {
    const mcpId = btn.dataset.wizSyncMcp;
    const cur = d.mcpState[mcpId];
    if (cur) {
      cur.synced = !cur.synced;
      if (cur.synced && cur.status === 'Auth Expired') {
        cur.status = 'Connected';
        cur.tone = 'green';
      }
      paintOnboardingWizard(false);
    }
    return;
  }

  const action = btn.dataset.wizAction;
  if (!action) return;

  if (action === 'next-step') {
    d.step = Math.min(5, d.step + 1);
    d.error = '';
    paintOnboardingWizard(true);
  } else if (action === 'prev-step') {
    d.step = Math.max(1, d.step - 1);
    d.error = '';
    paintOnboardingWizard(true);
  } else if (action === 'toggle-git-sim') {
    d.gitInitialized = !d.gitInitialized;
    paintOnboardingWizard(false);
  } else if (action === 'choose-folder') {
    const idx = WIZ_SAMPLE_FOLDERS.findIndex(f => f.id === d.presetId);
    const nextPreset = WIZ_SAMPLE_FOLDERS[(idx + 1) % WIZ_SAMPLE_FOLDERS.length];
    applyPresetToDraft(d, nextPreset);
    paintOnboardingWizard(false);
    notify(`Selected folder: ${nextPreset.path}`);
  } else if (action === 'toggle-ui-approval') {
    d.requireUIApproval = !d.requireUIApproval;
    paintOnboardingWizard(false);
  } else if (action === 'save-new-profile') {
    const rawName = ($('#wiz-new-profile-name')?.value || d.newProfileName || '').trim() || `Custom ${d.mode.toUpperCase()} Profile`;
    const newId = 'custom-' + Date.now().toString(36);
    const newProf = {
      id: newId,
      name: rawName,
      tag: 'SAVED CUSTOM',
      desc: `Custom ${d.mode === 'scrum' ? '8-role Scrum' : '4-role SLP'} roster.`,
      slp: JSON.parse(JSON.stringify(d.roles.slp)),
      scrum: JSON.parse(JSON.stringify(d.roles.scrum))
    };
    WIZ_SAVED_PROFILES.push(newProf);
    state.profiles.push({
      name: rawName,
      mode: d.mode,
      config: Object.fromEntries(Object.entries(d.roles[d.mode]).map(([k, v]) => [`${d.mode}:${k}`, { ...v }]))
    });
    d.selectedProfileId = newId;
    d.newProfileName = '';
    d.profileSavedNotice = `Saved "${rawName}"`;
    paintOnboardingWizard(false);
  } else if (action === 'choose-od-folder') {
    const nextIndex = (WIZ_OPEN_DESIGN_PROJECTS.findIndex(o => o.id === d.linkedDesignId) + 1) % WIZ_OPEN_DESIGN_PROJECTS.length;
    d.linkedDesignId = WIZ_OPEN_DESIGN_PROJECTS[nextIndex].id;
    paintOnboardingWizard(false);
    notify(`Linked Open Design folder: ${WIZ_OPEN_DESIGN_PROJECTS[nextIndex].folder}`);
  } else if (action === 'switch-to-scrum-for-ui') {
    d.mode = 'scrum';
    d.requireUIApproval = true;
    paintOnboardingWizard(false);
    notify('Switched to Agile Scrum with Require UI Approval = ON.');
  } else if (action === 'install-core-skills') {
    d.coreSkillsReady = true;
    paintOnboardingWizard(false);
    notify('Installed factory-skills-pack (Ready).');
  } else if (action === 'toggle-core-skills-sim') {
    d.coreSkillsReady = false;
    paintOnboardingWizard(false);
  } else if (action === 'create-open-supervisor') {
    finalizeProjectOnboarding(true);
  } else if (action === 'create-open-board') {
    finalizeProjectOnboarding(false);
  }
});

document.addEventListener('input', event => {
  const d = state.projectDraft;
  if (!d || !$('#modal')?.open) return;
  if (event.target.id === 'wiz-folder-path') {
    const pos = event.target.selectionStart;
    syncDraftFromPath(d, event.target.value);
    paintOnboardingWizard(false);
    const input = $('#wiz-folder-path');
    if (input) {
      input.focus({ preventScroll: true });
      try { input.setSelectionRange(pos, pos); } catch {}
    }
  } else if (event.target.id === 'wiz-new-profile-name') {
    d.newProfileName = event.target.value;
  }
});

document.addEventListener('change', event => {
  const d = state.projectDraft;
  if (!d || !$('#modal')?.open) return;
  const roleId = event.target.dataset?.wizRole;
  const field = event.target.dataset?.wizField;
  if (roleId && field) {
    const roster = d.roles[d.mode];
    if (!roster[roleId]) roster[roleId] = { provider: 'Codex', model: 'GPT-6.1', thinking: 'High' };
    roster[roleId][field] = event.target.value;
    if (field === 'provider') {
      roster[roleId].model = (WIZ_MODEL_CATALOG[event.target.value] || ['GPT-6.1'])[0];
    }
    d.selectedProfileId = 'custom';
    paintOnboardingWizard(false);
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target?.id === 'sup-chat-input') {
    event.preventDefault();
    sendSupervisorChatMessage();
    return;
  }
  const card = event.target.closest?.('[data-wiz-select-mode]');
  if (card && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    card.click();
  }
});

window.addEventListener('DOMContentLoaded', () => {
  installSupervisorChatHooks();
  setTimeout(() => {
    installSupervisorChatHooks();
  }, 80);
});
