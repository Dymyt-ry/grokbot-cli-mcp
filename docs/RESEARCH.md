# Research: foundation for grokbot-cli-mcp

Goal: one tool that is both a Grok CLI for humans and an MCP server Claude Code can call.

## Candidates (GitHub, 2026-10-24)

| Repo | ★ | Lang | Verdict |
|---|---|---|---|
| superagent-ai/grok-cli | 3.5k | TS/Bun, MIT | **Chosen base.** Full agent (bash/file/LSP tools), headless `-p --format json`, sessions, X + web search, image/video gen, vision, sub-agents, MCP *client*, schedules, Telegram. Active. Missing: an MCP *server*. |
| PointAntStorm/grok-self | 532 | JS | Chat-only CLI, no agent/tools. |
| Moore-developers/grok-cli | 52 | Rust | OAuth-first, small. |
| merterbak/Grok-MCP | 55 | Python | Good MCP tool set (search, vision, image/video), but no CLI agent. Used as tool-list reference. |
| LKbaba/Grok-mcp, wynandw87/claude-code-grok-mcp | 151 / 7 | TS / Py | MCP-only wrappers around chat/search. |
| howardpen9/grok-mcp | 11 | TS | MCP that shells out to a Grok CLI — same idea as our `grok_agent` tool. |
| zachdunn/grok-plugin-claude-code | 32 | JS | Claude Code plugin delegating to a Grok CLI. |

## Decision

Fork superagent-ai/grok-cli (keeps `upstream` remote for syncing) and add `grokbot mcp`:
a stdio MCP server that exposes Grok's own capabilities to Claude Code.

- Fast tools run in-process, reusing the fork's code: chat (+vision), web search, X search, image, video, model list.
- `grok_agent` runs the full Grok agent as a headless subprocess (`-p --format json -d <dir>`): per-call working
  directory, concurrency and crash isolation for free, and Grok's own MCP servers (e.g. mail) come along.

## Pivot (same day): pi as the base

New requirements: a really polished TUI, published on npm, working on Linux, macOS and Windows.
grok-cli needs Bun (`bun:sqlite`, native OpenTUI), so it can't ship as a plain cross-platform npm package.

[earendil-works/pi](https://github.com/earendil-works/pi) (117k ★, MIT): best-in-class terminal UI, plain Node ≥ 22.19,
Windows support, built-in xAI provider with API key *and* SuperGrok / X Premium OAuth, MCP client, skills, extensions.

Instead of forking pi's 11-package monorepo, grokbot depends on the published `@earendil-works/pi-coding-agent`
(pinned) and calls its exported `main(args, { extensionFactories })` with a built-in grok extension:

- extension: `web_search`, `x_search`, `generate_image`, `generate_video` tools + grokbot header (`setHeader`)
- launcher: own config dir (`~/.grokbot/agent` via `PI_CODING_AGENT_DIR`), Grok as default model
- `grokbot mcp`: the MCP server, ported from the grok-cli version

Upgrading pi = bump one pinned version and run the tests. Known limit: pi's `--help` text still says "pi"
(the name comes from pi's own package.json; changing it needs a source fork).
