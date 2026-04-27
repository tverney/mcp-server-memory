# mcp-agent-memory

[![mcp-agent-memory MCP server](https://glama.ai/mcp/servers/tverney/mcp-agent-memory/badges/card.svg)](https://glama.ai/mcp/servers/tverney/mcp-agent-memory)

MCP server that exposes [`agent-memory-daemon`](https://github.com/tverney/agent-memory-daemon) to any MCP-compatible client — **Kiro (CLI & IDE), Claude Desktop, Cursor**, and others.

The daemon does the thinking (consolidation + extraction); this server is a thin filesystem bridge so agents can **read**, **append**, and **search** memory through the Model Context Protocol.

## How it fits together

```
 ┌──────────────┐     MCP/stdio     ┌────────────────────┐     filesystem      ┌────────────────────────┐
 │ Kiro / Claude│ ◄───────────────► │ mcp-server-memory  │ ◄─────────────────► │ agent-memory-daemon    │
 │   / Cursor   │                   │  (this package)    │   ~/.agent-memory/   │  (runs in background)  │
 └──────────────┘                   └────────────────────┘                     └────────────────────────┘
```

- The **MCP server** reads/writes files under `~/.agent-memory/`
- The **daemon** watches the same directory and runs consolidation + extraction passes
- They never talk to each other directly — the filesystem is the contract

## Tools exposed

| Tool | Purpose |
|---|---|
| `memory_read` | Load `MEMORY.md` index (and optional topic files) into the agent's context |
| `memory_append_session` | Write a session summary for the daemon to later extract memories from |
| `memory_search` | Substring search across memory files |

## Install

```bash
npm install -g mcp-agent-memory
```

## Quick start (interactive wizard)

The fastest way to set everything up — memory directory, daemon, client configs, logs, and LaunchAgent — is the setup wizard:

```bash
mcp-agent-memory --setup
```

It asks six questions:

1. **Memory directory** — where `.agent-memory/` lives (default `~/.agent-memory`)
2. **Install the consolidation daemon?** — say "no" for MCP-only mode (agents can read/write/search memory, but no automatic consolidation)
3. **LLM backend** — `bedrock`, `openai`, or `kiro` (skipped if you declined the daemon)
4. **Consolidation settings** — `min_hours`, `min_sessions`, extraction interval, max chars
5. **Run mode** — `standalone` (start manually) or `launchagent` (auto-start at login, macOS only)
6. **Logs directory + TTL** — where to put logs, and how many days to keep them (`0` = forever)
7. **Client registration** — auto-register the MCP server in Kiro, Claude Desktop, and/or Cursor configs (existing MCP entries are preserved)

When you select the `kiro` backend, the wizard also copies a lean agent to `~/.kiro/agents/memconsolidate.json` that cuts token usage by ~7× (see [Kiro backend](#use-kiro-as-the-llm-backend)).

When you select `launchagent`, the wizard checks that `agent-memory-daemon` is installed (and offers to `npm install -g` it if not), then registers and starts the plist.

## CLI reference

```bash
mcp-agent-memory                       # run as an MCP server (normal mode — clients spawn it)
mcp-agent-memory --setup               # first-time interactive setup
mcp-agent-memory --configure           # re-run most steps; can add/remove the daemon later
mcp-agent-memory --remove              # interactive uninstall (backup memory, clean configs)

# macOS LaunchAgent control:
mcp-agent-memory --daemon status       # is the daemon running?
mcp-agent-memory --daemon start        # load and start
mcp-agent-memory --daemon stop         # unload (keeps the plist)
mcp-agent-memory --daemon restart      # stop + start
mcp-agent-memory --daemon remove       # unload and delete the plist
```

`--remove` preserves other entries in client MCP configs — only the `memory` key is deleted. By default it backs up `~/.agent-memory/` to a timestamped `.bak-*` directory so you can restore your consolidated memories.

## Manual install

If you'd rather skip the wizard, here's how to do it by hand.

### Install the daemon (optional)

The MCP server works standalone — it just reads and writes files under `~/.agent-memory/`. Memories persist, but they won't be consolidated or extracted from sessions until you add the daemon.

```bash
npm install -g agent-memory-daemon

# copy the example config
mkdir -p ~/.agent-memory
cp examples/memconsolidate.toml ~/.agent-memory/memconsolidate.toml

# start the daemon
agent-memory-daemon start ~/.agent-memory/memconsolidate.toml
```

See [`examples/memconsolidate.toml`](./examples/memconsolidate.toml) for a ready-to-use config that matches the directory layout this MCP server expects.

#### Run the daemon at login (macOS)

Instead of starting the daemon manually, register it as a LaunchAgent:

```bash
./scripts/daemon.sh start          # install plist, load it, start at login
./scripts/daemon.sh status         # check if it's running
./scripts/daemon.sh stop           # unload (keeps the plist)
./scripts/daemon.sh remove         # unload and delete the plist
```

Pass a custom config path as a second arg: `./scripts/daemon.sh start /path/to/config.toml`. Logs land in `~/.agent-memory/logs/daemon.{out,err}.log`. `remove` leaves your config and memory files untouched.

### Use Kiro as the LLM backend

If you have Kiro credits, you can run the daemon through `kiro-cli` instead of paying for Bedrock or OpenAI API calls. This requires `agent-memory-daemon` **≥ 2.7** (branch `feat/kiro-backend`) which adds a `kiro` backend.

```toml
[llm_backend]
name = "kiro"
# optional overrides:
# binary = "/custom/path/to/kiro-cli"
# agent = "memconsolidate"          # set to "" to use Kiro's default session context (not recommended)
# model = "claude-sonnet-4-20250514"
# timeoutMs = 300000
```

**Use a lean agent to cut token usage by ~7×.** By default, every `kiro-cli chat` call loads Kiro's full system prompt plus every MCP tool schema from your global config — roughly 12–18K extra input tokens per call. Create a minimal agent that skips all of that:

```bash
cp examples/kiro-agent-memconsolidate.json ~/.kiro/agents/memconsolidate.json
```

The Kiro backend passes `--agent memconsolidate` automatically, so no further config is needed. Measured on a trivial prompt: **0.01 credits with the lean agent vs. 0.07 credits with the default** (same output quality).

See [`examples/kiro-agent-memconsolidate.json`](./examples/kiro-agent-memconsolidate.json) — the agent has `mcpServers: {}`, `tools: []`, and `useLegacyMcpJson: false` so it doesn't inherit anything from your global Kiro config.

## Configure clients manually

> The `--setup` and `--configure` wizards handle this for you. This section is for users who want to wire things up by hand.

### Kiro (CLI and IDE)

Edit `~/.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "mcp-agent-memory"],
      "env": {
        "MEMORY_DIRECTORY": "~/.agent-memory/memory",
        "SESSION_DIRECTORY": "~/.agent-memory/sessions"
      },
      "disabled": false,
      "timeout": 30000
    }
  }
}
```

Then ask Kiro: *"Read my memory index."* or *"Remember this: I prefer pnpm over npm."*

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "mcp-agent-memory"],
      "env": {
        "MEMORY_DIRECTORY": "~/.agent-memory/memory",
        "SESSION_DIRECTORY": "~/.agent-memory/sessions"
      }
    }
  }
}
```

Restart Claude Desktop. The three `memory_*` tools will appear.

### Cursor

Add to `~/.cursor/mcp.json` with the same server block.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MEMORY_DIRECTORY` | `~/.agent-memory/memory` | Where the daemon stores consolidated memory files |
| `SESSION_DIRECTORY` | `~/.agent-memory/sessions` | Where agent-written session summaries land |

Both paths must match what your `agent-memory-daemon` config uses.

## Recommended agent prompt

Tell your agent to call `memory_read` at the start of a conversation and `memory_append_session` at the end. Example steering rule for Kiro (`~/.kiro/steering/memory.md`):

```
At the start of every session, call memory_read (no arguments) to load my memory
index. Only pass `topics` when the task genuinely needs the full content of a
specific topic file.

When you learn something durable about me, my projects, or my preferences, call
memory_append_session with a concise markdown summary. Target 300-800 tokens,
use structured headers and bullets (not prose), and focus on durable findings
and decisions — not play-by-play. Verbose summaries cost more during the
daemon's consolidation pass.
```

## Token usage tips

Each of the three tools has a different cost profile. A few practices keep inference + consolidation bills low:

- **`memory_read` with no arguments** returns only the `MEMORY.md` index (typically <1 KB). Prefer this over `topics` unless you need full content.
- **`memory_search`** is substring-based and returns ≤3 matching lines per file — cheaper than loading whole topic files.
- **`memory_append_session`** costs nothing at call time, but every session gets processed by the daemon's LLM during consolidation. Keep summaries concise and structured.
- Consolidate or prune old topic files occasionally. Run `mcp-agent-memory --configure` — it now warns if your memory directory exceeds 25 files or 200 KB.
- **Session pruning after extraction** is handled by the daemon, not the MCP server. See `agent-memory-daemon`'s config for options that archive or delete sessions after they're processed (prevents the daemon from re-scanning old sessions forever).

## License

MIT
