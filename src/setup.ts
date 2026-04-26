import { createInterface } from 'node:readline/promises';
import { stdin, stdout, platform } from 'node:process';
import { readFile, writeFile, mkdir, copyFile, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Config {
  baseDir: string;
  backend: 'bedrock' | 'openai' | 'kiro';
  bedrock?: { region: string; profile: string; model: string };
  openai?: { apiKey: string; model: string };
  kiro?: Record<string, never>;
  minHours: number;
  minSessions: number;
  extractionIntervalMs: number;
  maxExtractionSessionChars: number;
  runMode: 'standalone' | 'launchagent';
  logsDir: string;
  logTtlDays: number;
  clients: string[];
}

const DEFAULTS: Omit<Config, 'baseDir' | 'backend' | 'clients' | 'logsDir' | 'logTtlDays'> = {
  bedrock: { region: 'us-east-1', profile: 'default', model: 'us.anthropic.claude-sonnet-4-20250514-v1:0' },
  openai: { apiKey: '', model: 'gpt-4o' },
  minHours: 24,
  minSessions: 5,
  extractionIntervalMs: 60000,
  maxExtractionSessionChars: 5000,
  runMode: 'standalone',
};

async function ask(rl: ReturnType<typeof createInterface>, question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || '';
}

async function choose(rl: ReturnType<typeof createInterface>, question: string, options: string[], fallback?: string): Promise<string> {
  const display = options.map((o, i) => `  ${i + 1}) ${o}`).join('\n');
  const defaultIdx = fallback ? options.indexOf(fallback) + 1 : undefined;
  const suffix = defaultIdx ? ` [${defaultIdx}]` : '';
  console.log(`\n${question}\n${display}`);
  const answer = (await rl.question(`Choice${suffix}: `)).trim();
  const idx = parseInt(answer, 10);
  if (!answer && fallback) return fallback;
  if (idx >= 1 && idx <= options.length) return options[idx - 1];
  return fallback || options[0];
}

async function yesNo(rl: ReturnType<typeof createInterface>, question: string, fallback = true): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith('y');
}

function buildToml(cfg: Config): string {
  const lines: string[] = [
    `# mcp-agent-memory setup: logs_dir=${cfg.logsDir} log_ttl_days=${cfg.logTtlDays}`,
    `memory_directory = "${join(cfg.baseDir, 'memory')}"`,
    `session_directory = "${join(cfg.baseDir, 'sessions')}"`,
    '',
    `min_hours = ${cfg.minHours}`,
    `min_sessions = ${cfg.minSessions}`,
    '',
    'extraction_enabled = true',
    `extraction_interval_ms = ${cfg.extractionIntervalMs}`,
    `max_extraction_session_chars = ${cfg.maxExtractionSessionChars}`,
    '',
    '[llm_backend]',
  ];

  if (cfg.backend === 'bedrock') {
    lines.push(`name = "bedrock"`);
    lines.push(`region = "${cfg.bedrock!.region}"`);
    lines.push(`profile = "${cfg.bedrock!.profile}"`);
    lines.push(`model = "${cfg.bedrock!.model}"`);
  } else if (cfg.backend === 'openai') {
    lines.push(`name = "openai"`);
    lines.push(`model = "${cfg.openai!.model}"`);
    if (cfg.openai!.apiKey) lines.push(`api_key = "${cfg.openai!.apiKey}"`);
  } else {
    lines.push(`name = "kiro"`);
  }

  return lines.join('\n') + '\n';
}

function mcpServerBlock(cfg: Config): Record<string, unknown> {
  return {
    command: 'npx',
    args: ['-y', 'mcp-agent-memory'],
    env: {
      MEMORY_DIRECTORY: join(cfg.baseDir, 'memory'),
      SESSION_DIRECTORY: join(cfg.baseDir, 'sessions'),
    },
  };
}

async function mergeJsonConfig(path: string, serverBlock: Record<string, unknown>): Promise<void> {
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { existing = JSON.parse(await readFile(path, 'utf-8')); } catch { /* start fresh */ }
  }
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  servers.memory = serverBlock;
  existing.mcpServers = servers;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

function clientConfigPath(client: string): string {
  const home = homedir();
  switch (client) {
    case 'kiro': return join(home, '.kiro', 'settings', 'mcp.json');
    case 'claude': return platform === 'win32'
      ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'cursor': return join(home, '.cursor', 'mcp.json');
    default: return '';
  }
}

async function promptBackend(rl: ReturnType<typeof createInterface>, current?: string): Promise<Pick<Config, 'backend' | 'bedrock' | 'openai' | 'kiro'>> {
  const backend = await choose(rl, 'LLM backend for the daemon:', ['bedrock', 'openai', 'kiro'], current || 'bedrock') as Config['backend'];
  const result: Pick<Config, 'backend' | 'bedrock' | 'openai' | 'kiro'> = { backend };

  if (backend === 'bedrock') {
    result.bedrock = {
      region: await ask(rl, 'AWS region', DEFAULTS.bedrock!.region),
      profile: await ask(rl, 'AWS profile', DEFAULTS.bedrock!.profile),
      model: await ask(rl, 'Model ID', DEFAULTS.bedrock!.model),
    };
  } else if (backend === 'openai') {
    result.openai = {
      model: await ask(rl, 'Model', DEFAULTS.openai!.model),
      apiKey: await ask(rl, 'API key (leave blank to use OPENAI_API_KEY env var)', ''),
    };
  } else {
    // Kiro backend uses kiro-cli's default session model — nothing to prompt for.
    console.log('Kiro backend selected (uses kiro-cli session, no model/region config needed).');
    result.kiro = {};
  }
  return result;
}

async function promptConsolidation(rl: ReturnType<typeof createInterface>, defaults = DEFAULTS): Promise<Pick<Config, 'minHours' | 'minSessions' | 'extractionIntervalMs' | 'maxExtractionSessionChars'>> {
  console.log('\n── Consolidation settings ──');
  return {
    minHours: parseInt(await ask(rl, 'Min hours between consolidations', String(defaults.minHours)), 10) || defaults.minHours,
    minSessions: parseInt(await ask(rl, 'Min sessions before consolidation', String(defaults.minSessions)), 10) || defaults.minSessions,
    extractionIntervalMs: parseInt(await ask(rl, 'Extraction check interval (ms)', String(defaults.extractionIntervalMs)), 10) || defaults.extractionIntervalMs,
    maxExtractionSessionChars: parseInt(await ask(rl, 'Max chars per session extraction', String(defaults.maxExtractionSessionChars)), 10) || defaults.maxExtractionSessionChars,
  };
}

async function promptRunMode(rl: ReturnType<typeof createInterface>, current?: string): Promise<'standalone' | 'launchagent'> {
  if (platform !== 'darwin') {
    console.log('\nLaunchAgent is macOS-only. Daemon will run standalone.');
    return 'standalone';
  }
  return await choose(rl, 'How should the daemon run?', ['standalone', 'launchagent'], current || 'standalone') as 'standalone' | 'launchagent';
}

async function promptLogs(rl: ReturnType<typeof createInterface>, baseDir: string, currentLogsDir?: string, currentTtl?: number): Promise<{ logsDir: string; logTtlDays: number }> {
  console.log('\n── Log settings ──');
  const logsDir = resolve(await ask(rl, 'Logs directory', currentLogsDir || join(baseDir, 'logs')));
  const ttlAnswer = await ask(rl, 'Log TTL in days (0 = keep forever)', String(currentTtl ?? 0));
  const logTtlDays = Math.max(0, parseInt(ttlAnswer, 10) || 0);
  return { logsDir, logTtlDays };
}

async function promptClients(rl: ReturnType<typeof createInterface>): Promise<string[]> {
  console.log('\n── Register MCP server in client configs ──');
  const clients: string[] = [];
  if (await yesNo(rl, 'Register in Kiro?', true)) clients.push('kiro');
  if (await yesNo(rl, 'Register in Claude Desktop?', false)) clients.push('claude');
  if (await yesNo(rl, 'Register in Cursor?', false)) clients.push('cursor');
  return clients;
}

async function installLaunchAgent(baseDir: string, logsDir: string, logTtlDays: number): Promise<void> {
  const { execSync } = await import('node:child_process');

  // Check if agent-memory-daemon is installed
  let daemonFound = false;
  try {
    execSync('command -v agent-memory-daemon', { stdio: 'ignore' });
    daemonFound = true;
  } catch { /* not installed */ }

  if (!daemonFound) {
    console.log('\n⚠ agent-memory-daemon is not installed (required for LaunchAgent mode).');
    const rl = createInterface({ input: stdin, output: stdout });
    const install = await yesNo(rl, 'Install it now (npm i -g agent-memory-daemon)?', true);
    rl.close();
    if (!install) {
      console.log('  Skipping LaunchAgent install. Install manually, then run --configure.');
      return;
    }
    try {
      execSync('npm install -g agent-memory-daemon', { stdio: 'inherit' });
    } catch {
      console.log('⚠ npm install failed. Try manually: npm install -g agent-memory-daemon');
      return;
    }
  }

  const scriptsDir = resolve(__dirname, '..', 'scripts');
  const daemonSh = join(scriptsDir, 'daemon.sh');
  if (!existsSync(daemonSh)) {
    console.log('⚠ scripts/daemon.sh not found (running from npx?). Skipping LaunchAgent install.');
    console.log('  To install manually: clone the repo and run ./scripts/daemon.sh start');
    return;
  }
  const configPath = join(baseDir, 'memconsolidate.toml');
  try {
    execSync(`bash "${daemonSh}" start "${configPath}"`, {
      stdio: 'inherit',
      env: { ...process.env, LOG_DIR: logsDir, LOG_TTL_DAYS: String(logTtlDays) },
    });
  } catch {
    console.log('⚠ Failed to install LaunchAgent. You can retry with: ./scripts/daemon.sh start');
  }
}

async function installKiroAgent(): Promise<void> {
  const src = resolve(__dirname, '..', 'examples', 'kiro-agent-memconsolidate.json');
  const dest = join(homedir(), '.kiro', 'agents', 'memconsolidate.json');
  if (!existsSync(src)) {
    console.log('⚠ examples/kiro-agent-memconsolidate.json not found. Skipping lean agent install.');
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  console.log(`✓ Installed lean Kiro agent → ${dest}`);
}

export async function runSetup(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log('\n🧠 mcp-agent-memory setup\n');

  try {
    // 1. Base directory
    const baseDir = resolve(await ask(rl, 'Memory directory', join(homedir(), '.agent-memory')));

    // 2. Backend
    const backendCfg = await promptBackend(rl);

    // 3. Consolidation
    const consolCfg = await promptConsolidation(rl);

    // 4. Run mode
    const runMode = await promptRunMode(rl);

    // 5. Log settings
    const logCfg = await promptLogs(rl, baseDir);

    // 6. Client registration
    const clients = await promptClients(rl);

    rl.close();

    const cfg: Config = { baseDir, ...backendCfg, ...consolCfg, runMode, ...logCfg, clients };

    // Write config
    await mkdir(baseDir, { recursive: true });
    await mkdir(join(baseDir, 'memory'), { recursive: true });
    await mkdir(join(baseDir, 'sessions'), { recursive: true });
    await mkdir(cfg.logsDir, { recursive: true });
    const tomlPath = join(baseDir, 'memconsolidate.toml');
    await writeFile(tomlPath, buildToml(cfg), 'utf-8');
    console.log(`\n✓ Config written → ${tomlPath}`);

    // Register clients
    const block = mcpServerBlock(cfg);
    for (const client of clients) {
      const path = clientConfigPath(client);
      if (!path) continue;
      await mergeJsonConfig(path, block);
      console.log(`✓ Registered in ${client} → ${path}`);
    }

    // Kiro lean agent
    if (cfg.backend === 'kiro') {
      await installKiroAgent();
    }

    // LaunchAgent
    if (runMode === 'launchagent') {
      await installLaunchAgent(baseDir, cfg.logsDir, cfg.logTtlDays);
    }

    console.log('\n✅ Setup complete!');
    if (runMode === 'standalone') {
      console.log(`\nTo start the daemon manually:\n  agent-memory-daemon start ${tomlPath}`);
      console.log(`  (redirect logs: >> ${cfg.logsDir}/daemon.out.log 2>> ${cfg.logsDir}/daemon.err.log)`);
    }
    console.log('Restart your MCP client to pick up the new config.\n');
  } catch (err) {
    rl.close();
    throw err;
  }
}

export async function runConfigure(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log('\n🔧 mcp-agent-memory reconfigure\n');

  try {
    // Find existing config
    const defaultBase = join(homedir(), '.agent-memory');
    const tomlPath = join(defaultBase, 'memconsolidate.toml');
    if (!existsSync(tomlPath)) {
      console.log(`No existing config found at ${tomlPath}. Run --setup first.`);
      rl.close();
      return;
    }

    const existing = await readFile(tomlPath, 'utf-8');
    const currentBackend = existing.match(/^name\s*=\s*"(\w+)"/m)?.[1] || 'bedrock';

    console.log(`Using memory directory: ${defaultBase}`);
    console.log(`Current backend: ${currentBackend}\n`);

    // 1. Backend
    const backendCfg = await promptBackend(rl, currentBackend);

    // 2. Consolidation — parse current values as defaults
    const parseNum = (key: string, fallback: number) => {
      const m = existing.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, 'm'));
      return m ? parseInt(m[1], 10) : fallback;
    };
    const consolCfg = await promptConsolidation(rl, {
      ...DEFAULTS,
      minHours: parseNum('min_hours', DEFAULTS.minHours),
      minSessions: parseNum('min_sessions', DEFAULTS.minSessions),
      extractionIntervalMs: parseNum('extraction_interval_ms', DEFAULTS.extractionIntervalMs),
      maxExtractionSessionChars: parseNum('max_extraction_session_chars', DEFAULTS.maxExtractionSessionChars),
    });

    // 3. Run mode
    const currentRunMode = existsSync(join(homedir(), 'Library', 'LaunchAgents', 'com.agent-memory-daemon.plist')) ? 'launchagent' : 'standalone';
    const runMode = await promptRunMode(rl, currentRunMode);

    // 4. Log settings (parse current values from the comment line)
    const logsMatch = existing.match(/^#\s*mcp-agent-memory setup:\s*logs_dir=(\S+)\s+log_ttl_days=(\d+)/m);
    const logCfg = await promptLogs(rl, defaultBase, logsMatch?.[1], logsMatch ? parseInt(logsMatch[2], 10) : 0);

    // 5. Client registration
    const clients = await promptClients(rl);

    rl.close();

    const cfg: Config = { baseDir: defaultBase, ...backendCfg, ...consolCfg, runMode, ...logCfg, clients };

    // Write config
    await mkdir(cfg.logsDir, { recursive: true });
    await writeFile(tomlPath, buildToml(cfg), 'utf-8');
    console.log(`\n✓ Config updated → ${tomlPath}`);

    // Register clients
    const block = mcpServerBlock(cfg);
    for (const client of clients) {
      const path = clientConfigPath(client);
      if (!path) continue;
      await mergeJsonConfig(path, block);
      console.log(`✓ Registered in ${client} → ${path}`);
    }

    // Kiro lean agent
    if (cfg.backend === 'kiro') {
      await installKiroAgent();
    }

    // LaunchAgent
    if (runMode === 'launchagent') {
      await installLaunchAgent(defaultBase, cfg.logsDir, cfg.logTtlDays);
    }

    console.log('\n✅ Reconfiguration complete!');
    if (runMode === 'standalone') {
      console.log(`\nRestart the daemon:\n  agent-memory-daemon start ${tomlPath}`);
      console.log(`  (redirect logs: >> ${cfg.logsDir}/daemon.out.log 2>> ${cfg.logsDir}/daemon.err.log)`);
    }
    console.log('Restart your MCP client to pick up any changes.\n');
  } catch (err) {
    rl.close();
    throw err;
  }
}

async function removeClientConfig(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    if (!parsed.mcpServers?.memory) return false;
    delete parsed.mcpServers.memory;
    await writeFile(path, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export async function runRemove(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log('\n🗑  mcp-agent-memory remove\n');

  try {
    const baseDir = resolve(await ask(rl, 'Memory directory to remove', join(homedir(), '.agent-memory')));
    const backup = await yesNo(rl, 'Back up memory directory before deleting?', true);
    const removeKiroAgent = await yesNo(rl, 'Remove lean Kiro agent (~/.kiro/agents/memconsolidate.json)?', true);
    const unregister = await yesNo(rl, 'Unregister MCP server from client configs (Kiro/Claude/Cursor)?', true);
    const removeLaunchAgent = platform === 'darwin' && await yesNo(rl, 'Unload and delete LaunchAgent plist?', true);

    rl.close();

    // LaunchAgent first (unload before deleting its target)
    if (removeLaunchAgent) {
      const scriptsDir = resolve(__dirname, '..', 'scripts');
      const daemonSh = join(scriptsDir, 'daemon.sh');
      if (existsSync(daemonSh)) {
        const { execSync } = await import('node:child_process');
        try { execSync(`bash "${daemonSh}" remove`, { stdio: 'inherit' }); } catch { /* non-fatal */ }
      } else {
        const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.agent-memory-daemon.plist');
        if (existsSync(plist)) {
          const { execSync } = await import('node:child_process');
          try { execSync(`launchctl unload "${plist}"`, { stdio: 'ignore' }); } catch { /* may already be unloaded */ }
          await rm(plist, { force: true });
          console.log(`✓ Removed ${plist}`);
        }
      }
    }

    // Memory directory
    if (existsSync(baseDir)) {
      if (backup) {
        const bak = `${baseDir}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await rename(baseDir, bak);
        console.log(`✓ Backed up → ${bak}`);
      } else {
        await rm(baseDir, { recursive: true, force: true });
        console.log(`✓ Removed ${baseDir}`);
      }
    }

    // Kiro agent
    if (removeKiroAgent) {
      const agent = join(homedir(), '.kiro', 'agents', 'memconsolidate.json');
      if (existsSync(agent)) {
        await rm(agent, { force: true });
        console.log(`✓ Removed ${agent}`);
      }
    }

    // Client configs
    if (unregister) {
      for (const client of ['kiro', 'claude', 'cursor']) {
        const path = clientConfigPath(client);
        if (await removeClientConfig(path)) {
          console.log(`✓ Unregistered from ${client} → ${path}`);
        }
      }
    }

    console.log('\n✅ Removal complete.');
    console.log('(The globally installed packages mcp-agent-memory and agent-memory-daemon were not uninstalled.)');
    console.log('To remove them: npm uninstall -g mcp-agent-memory agent-memory-daemon\n');
  } catch (err) {
    rl.close();
    throw err;
  }
}
