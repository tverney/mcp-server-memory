# mcp-server-memory

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
# or just use npx — Kiro/Claude will spawn it for you
```

### Optional: install the daemon

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

### Use Kiro as the LLM backend (Amazon employees)

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

## Configure Kiro (CLI and IDE)

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

## Configure Claude Desktop

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

## Configure Cursor

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
At the start of every session, call memory_read to load my preferences and context.
When you learn something durable about me, my projects, or my preferences, call
memory_append_session with a concise markdown summary.
```

## License

MIT
