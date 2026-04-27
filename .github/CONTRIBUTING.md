# Contributing to mcp-agent-memory

Thanks for your interest in contributing! This is a small MCP server that
bridges agents to [`agent-memory-daemon`](https://github.com/tverney/agent-memory-daemon)
through the filesystem.

## Getting started

1. Fork the repo and clone your fork
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Run locally with a client (Kiro, Claude Desktop, Cursor) pointed at
   `node /path/to/dist/index.js`

## Making changes

- Open an issue first for anything non-trivial so we can align on direction
- Keep pull requests focused — one logical change per PR
- Match the existing TypeScript style and keep dependencies minimal
- Update `README.md` if you change user-facing behavior
- Run `npm run build` and confirm the MCP server still starts before submitting

## Reporting bugs

Use [GitHub Issues](https://github.com/tverney/mcp-agent-memory/issues) and include:

- What you expected to happen
- What actually happened
- Node version, OS, and which MCP client you're using
- Minimal steps to reproduce

## Security issues

Do **not** file public issues for security vulnerabilities. See
[SECURITY.md](./SECURITY.md) for the disclosure process.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
