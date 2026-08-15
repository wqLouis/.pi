# pi extensions

Custom extensions for the pi coding agent, loaded from
`~/.pi/agent/extensions/`.

## Contents

- **`agent-memory.ts`** — agent-managed conversation memory:
  `memory_index` / `memory_drop` / `memory_restore` / `memory_status`, a
  context-usage nudge at 30% / 50% / 70% bands, and a `/memory` command.
- **`subagent.ts`** — subagent management: `subagent_spawn` (sync or
  background), `subagent_send` (steer), `subagent_wait`, `subagent_list`,
  `subagent_result`, `subagent_forget`, `subagent_config`; edit-scope
  enforcement (`scope` param), bubble-up tools (`subagent_message` /
  `subagent_request`), and a `/subagent` command with an interactive model
  picker.
- **`bash-timeout.ts`** — enforces a default 10s timeout on bash tool calls
  (`PI_BASH_DEFAULT_TIMEOUT` to override) and reminds the agent via a system
  prompt guideline.
- **`playwright-browser.ts`** + **`browser-server.mjs`** — browser tools:
  `browser_open`, `browser_click`, `browser_type`, `browser_content`,
  `browser_eval`, `browser_screenshot`, `browser_status`, `browser_close`,
  backed by a persistent detached daemon (per-client sessions); plus a
  `/playwright-setup` command for users to install playwright + chromium.

## Setup

- Extensions auto-load from `~/.pi/agent/extensions/` on pi start (or
  `/reload`).
- To install this repo's extensions, symlink (or copy) the files into
  `~/.pi/agent/extensions/`.
- Browser tools need: `bun add -g playwright && playwright install chromium`
  (or run `/playwright-setup` inside pi).
