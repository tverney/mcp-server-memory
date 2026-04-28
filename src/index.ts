#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, readdir, appendFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFile } from 'node:child_process';

const MEMORY_DIR = resolve(process.env.MEMORY_DIRECTORY ?? join(homedir(), '.agent-memory', 'memory'));
const SESSION_DIR = resolve(process.env.SESSION_DIRECTORY ?? join(homedir(), '.agent-memory', 'sessions'));

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) await mkdir(path, { recursive: true });
}

async function readIndex(): Promise<string> {
  const indexPath = join(MEMORY_DIR, 'MEMORY.md');
  if (!existsSync(indexPath)) return '(no memories yet)';
  return readFile(indexPath, 'utf-8');
}

async function readTopics(topics: string[]): Promise<string> {
  const parts: string[] = [];
  for (const topic of topics) {
    const safe = topic.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!safe) continue;
    const path = join(MEMORY_DIR, safe.endsWith('.md') ? safe : `${safe}.md`);
    if (existsSync(path)) {
      parts.push(`# ${safe}\n\n${await readFile(path, 'utf-8')}`);
    }
  }
  return parts.join('\n\n---\n\n') || '(no matching topic files)';
}

async function appendSession(content: string, source?: string): Promise<string> {
  await ensureDir(SESSION_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = (source ?? 'mcp').replace(/[^a-zA-Z0-9_-]/g, '');
  const filename = `${ts}-${tag}.md`;
  const path = join(SESSION_DIR, filename);
  const frontmatter = `---\nsource: ${tag}\ntimestamp: ${new Date().toISOString()}\n---\n\n`;
  await appendFile(path, frontmatter + content, 'utf-8');
  return filename;
}

async function searchMemory(query: string): Promise<string> {
  if (!existsSync(MEMORY_DIR)) return '(memory directory does not exist)';
  const q = query.toLowerCase();
  const files = (await readdir(MEMORY_DIR)).filter((f) => f.endsWith('.md'));
  const hits: string[] = [];
  for (const file of files) {
    const content = await readFile(join(MEMORY_DIR, file), 'utf-8');
    if (content.toLowerCase().includes(q)) {
      const snippet = content.split('\n').filter((l) => l.toLowerCase().includes(q)).slice(0, 3).join('\n');
      hits.push(`## ${file}\n${snippet}`);
    }
  }
  return hits.join('\n\n') || `(no matches for "${query}")`;
}

const DAEMON_LABEL = 'com.agent-memory-daemon';

function daemonStatus(): Promise<string> {
  if (platform() !== 'darwin') {
    return Promise.resolve('The memory daemon is not available in your configuration (macOS LaunchAgent only).');
  }
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
  if (!existsSync(plist)) {
    return Promise.resolve('The memory daemon is not installed in your configuration. Set it up with: mcp-agent-memory --setup');
  }
  return new Promise((res) => {
    execFile('launchctl', ['list', DAEMON_LABEL], (err, stdout) => {
      if (err) return res(`Daemon is installed but not running.\nPlist: ${plist}`);
      const pid = stdout.match(/"PID"\s*=\s*(\d+)/)?.[1] ?? 'unknown';
      const status = stdout.match(/"LastExitStatus"\s*=\s*(\d+)/)?.[1] ?? 'unknown';
      res(`Daemon is running.\nPID: ${pid}\nLast exit status: ${status}\nPlist: ${plist}`);
    });
  });
}

const server = new Server(
  { name: 'mcp-server-memory', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_read',
      description: 'Read the agent memory index (MEMORY.md) and optionally specific topic files. Call with no arguments to load only the lightweight index (cheap). Pass `topics` only when you need the full content of a specific topic file.',
      inputSchema: {
        type: 'object',
        properties: {
          topics: { type: 'array', items: { type: 'string' }, description: 'Optional topic file names to load in full (e.g., ["preferences", "projects"]). Omit to return the index only.' },
        },
      },
    },
    {
      name: 'memory_append_session',
      description: 'Append a session summary to the sessions directory. The daemon will later extract durable memories from it. Call this at the end of meaningful exchanges. Keep summaries focused on durable findings and decisions (target 300-800 tokens), not play-by-play — longer summaries cost more during consolidation.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Markdown-formatted session summary. Use structured headers and bullets for better extraction; avoid verbose prose.' },
          source: { type: 'string', description: 'Origin tag, e.g., "kiro", "claude-desktop"' },
        },
        required: ['content'],
      },
    },
    {
      name: 'memory_search',
      description: 'Search memory files for a substring. Use this to recall specific facts without loading everything.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Substring to search for across all memory files (case-insensitive)' } },
        required: ['query'],
      },
    },
    {
      name: 'memory_daemon_status',
      description: 'Check whether the memory consolidation daemon is running. Reports if the daemon is not installed or not available on this platform.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === 'memory_read') {
      const topics = (args?.topics as string[] | undefined) ?? [];
      const index = await readIndex();
      const topicContent = topics.length > 0 ? `\n\n---\n\n${await readTopics(topics)}` : '';
      return { content: [{ type: 'text', text: index + topicContent }] };
    }
    if (name === 'memory_append_session') {
      const content = String(args?.content ?? '');
      if (!content.trim()) throw new Error('content is required');
      const filename = await appendSession(content, args?.source as string | undefined);
      return { content: [{ type: 'text', text: `Wrote session: ${filename}` }] };
    }
    if (name === 'memory_search') {
      const query = String(args?.query ?? '');
      if (!query.trim()) throw new Error('query is required');
      return { content: [{ type: 'text', text: await searchMemory(query) }] };
    }
    if (name === 'memory_daemon_status') {
      return { content: [{ type: 'text', text: await daemonStatus() }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
});

async function main() {
  const flag = process.argv[2];
  if (flag === '--setup' || flag === '--configure' || flag === '--remove' || flag === '--daemon') {
    const { runSetup, runConfigure, runRemove, runDaemon } = await import('./setup.js');
    if (flag === '--setup') await runSetup();
    else if (flag === '--configure') await runConfigure();
    else if (flag === '--remove') await runRemove();
    else await runDaemon(process.argv[3] ?? '');
    return;
  }

  await ensureDir(MEMORY_DIR);
  await ensureDir(SESSION_DIR);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => process.exit(0);
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('disconnect', shutdown);
}

main().catch((err) => {
  console.error('mcp-server-memory fatal:', err);
  process.exit(1);
});
