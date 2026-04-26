import { createInterface } from 'node:readline/promises';
import { stdin, stdout, platform } from 'node:process';
import { readFile, writeFile, mkdir, copyFile, rm, rename, readdir, stat } from 'node:fs/promises';
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

function mcpServerBlock(cfg: { baseDir: string }): Record<string, unknown> {
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
  console.log('The MCP server provides memory read/write/search tools to AI clients.');
  console.log('The optional daemon consolidates sessions into durable memories using an LLM.\n');

  try {
    // 1. Base directory
    const baseDir = resolve(await ask(rl, 'Memory directory', join(homedir(), '.agent-memory')));

    // 2. Daemon opt-in
    const useDaemon = await yesNo(rl, 'Install the consolidation daemon? (needed to auto-extract memories)', true);

    // 3+. Daemon-only prompts
    const backendCfg = useDaemon ? await promptBackend(rl) : undefined;
    const consolCfg = useDaemon ? await promptConsolidation(rl) : undefined;
    const runMode = useDaemon ? await promptRunMode(rl) : 'standalone';
    const logCfg = useDaemon ? await promptLogs(rl, baseDir) : { logsDir: join(baseDir, 'logs'), logTtlDays: 0 };

    // Client registration (always)
    const clients = await promptClients(rl);

    rl.close();

    // Create memory dirs regardless — the MCP reads/writes these even without the daemon.
    await mkdir(baseDir, { recursive: true });
    await mkdir(join(baseDir, 'memory'), { recursive: true });
    await mkdir(join(baseDir, 'sessions'), { recursive: true });

    // Write daemon config + start it only when opted in.
    let tomlPath: string | undefined;
    if (useDaemon && backendCfg && consolCfg) {
      const cfg: Config = { baseDir, ...backendCfg, ...consolCfg, runMode, ...logCfg, clients };
      await mkdir(cfg.logsDir, { recursive: true });
      tomlPath = join(baseDir, 'memconsolidate.toml');
      await writeFile(tomlPath, buildToml(cfg), 'utf-8');
      console.log(`\n✓ Daemon config written → ${tomlPath}`);

      if (cfg.backend === 'kiro') await installKiroAgent();
      if (runMode === 'launchagent') await installLaunchAgent(baseDir, cfg.logsDir, cfg.logTtlDays);
    }

    // Register clients — uses the memory/session dirs, not the daemon config.
    const block = mcpServerBlock({ baseDir });
    for (const client of clients) {
      const path = clientConfigPath(client);
      if (!path) continue;
      await mergeJsonConfig(path, block);
      console.log(`✓ Registered in ${client} → ${path}`);
    }

    console.log('\n✅ Setup complete!');
    if (!useDaemon) {
      console.log('\nMCP-only mode: agents can read/write/search memory, but sessions won\'t be');
      console.log('auto-consolidated into durable memories. Run --configure later to add the daemon.');
    } else if (runMode === 'standalone' && tomlPath) {
      console.log(`\nTo start the daemon manually:\n  agent-memory-daemon start ${tomlPath}`);
      console.log(`  (redirect logs: >> ${logCfg.logsDir}/daemon.out.log 2>> ${logCfg.logsDir}/daemon.err.log)`);
    }
    console.log('Restart your MCP client to pick up the new config.\n');
  } catch (err) {
    rl.close();
    throw err;
  }
}

async function checkMemorySize(baseDir: string): Promise<void> {
  const memDir = join(baseDir, 'memory');
  if (!existsSync(memDir)) return;
  const files = (await readdir(memDir)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  let totalBytes = 0;
  for (const f of files) totalBytes += (await stat(join(memDir, f))).size;
  const totalKb = Math.round(totalBytes / 1024);
  const WARN_FILES = 25;
  const WARN_KB = 200;
  if (files.length > WARN_FILES || totalKb > WARN_KB) {
    console.log(`\n⚠ Memory directory is getting large: ${files.length} topic files, ~${totalKb} KB total.`);
    console.log(`  Consider consolidating older topics or deleting stale ones — every memory_read`);
    console.log(`  with topics pulls these files into the agent's context.`);
  }
}

export async function runConfigure(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log('\n🔧 mcp-agent-memory reconfigure\n');

  try {
    // Find existing config
    const defaultBase = join(homedir(), '.agent-memory');
    const tomlPath = join(defaultBase, 'memconsolidate.toml');
    const daemonConfigured = existsSync(tomlPath);
    const existing = daemonConfigured ? await readFile(tomlPath, 'utf-8') : '';
    const currentBackend = existing.match(/^name\s*=\s*"(\w+)"/m)?.[1] || 'bedrock';

    console.log(`Using memory directory: ${defaultBase}`);
    if (daemonConfigured) console.log(`Current backend: ${currentBackend}`);
    else console.log('No daemon config found — running in MCP-only mode.');
    await checkMemorySize(defaultBase);
    console.log('');

    // Daemon toggle
    const useDaemon = await yesNo(rl, daemonConfigured ? 'Keep the consolidation daemon?' : 'Add the consolidation daemon?', daemonConfigured);

    let backendCfg: Awaited<ReturnType<typeof promptBackend>> | undefined;
    let consolCfg: Awaited<ReturnType<typeof promptConsolidation>> | undefined;
    let runMode: 'standalone' | 'launchagent' = 'standalone';
    let logCfg = { logsDir: join(defaultBase, 'logs'), logTtlDays: 0 };
    const currentRunMode = existsSync(join(homedir(), 'Library', 'LaunchAgents', 'com.agent-memory-daemon.plist')) ? 'launchagent' : 'standalone';

    if (useDaemon) {
      backendCfg = await promptBackend(rl, daemonConfigured ? currentBackend : undefined);

      const parseNum = (key: string, fallback: number) => {
        const m = existing.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, 'm'));
        return m ? parseInt(m[1], 10) : fallback;
      };
      consolCfg = await promptConsolidation(rl, {
        ...DEFAULTS,
        minHours: parseNum('min_hours', DEFAULTS.minHours),
        minSessions: parseNum('min_sessions', DEFAULTS.minSessions),
        extractionIntervalMs: parseNum('extraction_interval_ms', DEFAULTS.extractionIntervalMs),
        maxExtractionSessionChars: parseNum('max_extraction_session_chars', DEFAULTS.maxExtractionSessionChars),
      });

      runMode = await promptRunMode(rl, currentRunMode);

      const logsMatch = existing.match(/^#\s*mcp-agent-memory setup:\s*logs_dir=(\S+)\s+log_ttl_days=(\d+)/m);
      logCfg = await promptLogs(rl, defaultBase, logsMatch?.[1], logsMatch ? parseInt(logsMatch[2], 10) : 0);
    }

    const clients = await promptClients(rl);

    rl.close();

    // Daemon config + install
    if (useDaemon && backendCfg && consolCfg) {
      const cfg: Config = { baseDir: defaultBase, ...backendCfg, ...consolCfg, runMode, ...logCfg, clients };
      await mkdir(cfg.logsDir, { recursive: true });
      await writeFile(tomlPath, buildToml(cfg), 'utf-8');
      console.log(`\n✓ Config updated → ${tomlPath}`);

      if (cfg.backend === 'kiro') await installKiroAgent();
      if (runMode === 'launchagent') {
        await installLaunchAgent(defaultBase, cfg.logsDir, cfg.logTtlDays);
      } else if (currentRunMode === 'launchagent') {
        const { execSync } = await import('node:child_process');
        const daemonSh = resolve(__dirname, '..', 'scripts', 'daemon.sh');
        if (existsSync(daemonSh)) {
          try { execSync(`bash "${daemonSh}" stop`, { stdio: 'inherit' }); } catch { /* not running */ }
        }
      }
    } else if (currentRunMode === 'launchagent') {
      // User disabled the daemon entirely — unload the LaunchAgent.
      const { execSync } = await import('node:child_process');
      const daemonSh = resolve(__dirname, '..', 'scripts', 'daemon.sh');
      if (existsSync(daemonSh)) {
        try { execSync(`bash "${daemonSh}" stop`, { stdio: 'inherit' }); } catch { /* not running */ }
      }
    }

    // Register clients
    const block = mcpServerBlock({ baseDir: defaultBase });
    for (const client of clients) {
      const path = clientConfigPath(client);
      if (!path) continue;
      await mergeJsonConfig(path, block);
      console.log(`✓ Registered in ${client} → ${path}`);
    }

    console.log('\n✅ Reconfiguration complete!');
    if (useDaemon && runMode === 'standalone') {
      console.log(`\nRestart the daemon:\n  agent-memory-daemon start ${tomlPath}`);
      console.log(`  (redirect logs: >> ${logCfg.logsDir}/daemon.out.log 2>> ${logCfg.logsDir}/daemon.err.log)`);
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

export async function runDaemon(action: string): Promise<void> {
  const valid = ['start', 'stop', 'remove', 'status', 'restart'];
  if (!valid.includes(action)) {
    console.error(`usage: mcp-agent-memory --daemon {${valid.join('|')}}`);
    process.exit(1);
  }
  if (platform !== 'darwin') {
    console.error('--daemon is macOS-only (manages a LaunchAgent).');
    process.exit(1);
  }

  const scriptsDir = resolve(__dirname, '..', 'scripts');
  const daemonSh = join(scriptsDir, 'daemon.sh');
  if (!existsSync(daemonSh)) {
    console.error('scripts/daemon.sh not found. Is the package installed correctly?');
    process.exit(1);
  }

  const configPath = join(homedir(), '.agent-memory', 'memconsolidate.toml');
  const { execSync } = await import('node:child_process');

  // Pull log settings from config comment so `start` restarts with the saved values.
  let env = { ...process.env };
  if (existsSync(configPath)) {
    const content = await readFile(configPath, 'utf-8');
    const m = content.match(/^#\s*mcp-agent-memory setup:\s*logs_dir=(\S+)\s+log_ttl_days=(\d+)/m);
    if (m) env = { ...env, LOG_DIR: m[1], LOG_TTL_DAYS: m[2] };
  }

  const run = (cmd: string) => execSync(`bash "${daemonSh}" ${cmd} "${configPath}"`, { stdio: 'inherit', env });

  if (action === 'restart') {
    try { run('stop'); } catch { /* may not be running */ }
    run('start');
  } else {
    run(action);
  }
}
