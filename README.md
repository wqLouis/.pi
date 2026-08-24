# pi agent harness

## Setup

```bash
# one-line install: clone all extensions straight into pi's extension dir
git clone --depth 1 https://github.com/wqLouis/.pi.git ~/.pi/agent/extensions
```

Then start pi (or `/reload`) and the tools are live (playwright and chromium
are installed automatically by `/playwright-setup` inside pi). Commands run in
pi's TUI: `/subagent`, `/playwright-setup`.

## Extensions

A set of extensions that turn the [pi coding agent](https://github.com/earendil-works/pi) into a
self-managing, multi-agent system. Five extensions, loaded from
`~/.pi/agent/extensions/`:

1. **subagent** — the agent spawns, steers, and scopes subagents that work for it.
2. **bash-timeout** — commands can't hang the agent forever.
3. **playwright-browser** — the agent (and its subagents) drive a real browser.
4. **agent-tasks** — a plain-markdown task board per session.
5. **command-code-provider** — Command Code's OpenAI/Anthropic-compatible provider endpoint.

Each extension auto-loads on pi start (or `/reload`); every tool below is
available to the main agent, and subagents get the browser + bash-timeout
tools too.

## Design: async-first, work as much as possible

This harness is built to be **long-running and high-throughput**: the agent
should never idle waiting on something while it can still be doing work.
Everything that takes time is pushed to the background and reports back
automatically:

- `subagent_spawn { await: false }` / `subagent_dispatch` — delegate and move on; the completion
  **auto-bubbles** as a real message with the subagent's full final response.
- `subagent_send` — steering is **always async**: push the message, keep
  working, get pinged when it finishes.
- **Idle timers** re-deliver anything that was missed (reloads, busy turns)
  at session start / turn end / every 30s — no notification is ever lost.
- Busy-safe pushes: every notification passes `deliverAs: "steer"`, so it
  lands in the chat thread immediately.

The default posture is: start it, forget it, get pinged. Subagents themselves
run the same way, so the whole tree fans out into background work and results
flow back to the top.

---

## 1. subagent — spawn, steer, scope

One generic subagent type (model chosen by the user via `/subagent model`),
each owning a private pi session file. Every turn runs a one-shot pi process
against that session, so steering truly continues its work with full history.

| Tool | Purpose |
|------|---------|
| `subagent_dispatch { exploreScope, tasks: [{ task, scope }], ... }` | Always runs asynchronously: explore once, then fork scoped task agents from the shared exploration session; skips exploration for a single task |
| `subagent_spawn { task, model?, cwd?, tools?, scope?, await? }` | Spawn one direct subagent. `await: false` returns immediately (background) |
| `subagent_send { subagentId, message }` | Push a message / steer — **always async**: returns immediately, the complete completion auto-bubbles |
| `subagent_list` | Running/finished subagents: id, model, usage, latest output |
| `subagent_result { subagentId }` | Full transcript: task, steering messages, tool activity, outputs |
| `subagent_forget { subagentId }` | Delete a subagent and its session |
| `subagent_config` | Effective config: model, system prompt, cwd, tools |
| `subagent_message` / `subagent_request` | Bubble-up tools (only inside subagents): send progress/requests to the main agent |

Key behaviors:

- **Shared exploration** — `subagent_dispatch` accepts one `exploreScope` and an array of `{ task, scope }` assignments and always returns immediately. With multiple tasks it runs one read-only exploration pass in the background, then uses Pi's session fork API to create each scoped task agent from the explorer's complete session, preserving the shared context and cacheable prefix. With one task it uses a direct fast path and does not create an explorer.
- **Per-task edit scope** — Every dispatched task supplies its own file or directory scope. The harness blocks that task agent's `write` and `edit` calls outside the assigned scope, preventing parallel tasks from colliding.
- **Session-scoped listing** — Subagent records and `subagent_list` are isolated to the current main session; one session cannot see another session's agents.
- **Edit scope** — `scope` limits a subagent's writes to a directory or file
  list (reads stay unrestricted). Enforced *inside* the subagent process via a
  `tool_call` hook: `write`/`edit` targeting out-of-scope paths are blocked
  with a clear reason, so parallel subagents never collide.
- **Multi-layer nesting** — subagents can spawn their own sub-subagents up to
  the configured `maxDepth` layers (default 3), and at most `maxSubagents`
  subagents run concurrently across all layers (default 4). Both limits are
  user-configurable (`/subagent config maxDepth N` / `maxSubagents N`, or
  `maxDepth` / `maxSubagents` in `subagent-config.json`).
- **Limits visible to every agent** — `subagent_config` and `subagent_list`
  report how many subagents are running right now vs the `maxSubagents` limit,
  and the nesting depth; `subagent_spawn` refuses to exceed either limit with
  a clear reason.
- **Auto-bubbled completions** — when a background subagent finishes, a **real
  user message** (`sendUserMessage`) auto-bubbles into the agent's final turn
  (and triggers one even when idle). If a push was missed (e.g. extension
  reloaded mid-run), a flusher re-delivers it at session start / turn end /
  every 30s.
- **`/subagent` command** — manage direct subagents with `list`, `result <id>`, `send <id> <msg>`,
  `forget <id>`, `model [provider/id]` (pi's built-in model selector), `config`.

## 2. bash-timeout — no more hung commands

pi's bash tool has no default timeout; when the agent forgets one, a command
can hang forever. This extension:

- **Enforces** a default `timeout: 10` on every bash call that omits one
  (a `tool_call` hook mutates the input before the bash tool runs). Explicit
  timeouts are respected. Override the default with `PI_BASH_DEFAULT_TIMEOUT`.
- **Reminds** the agent via a `before_agent_start` guideline appended to the
  system prompt ("always pass an explicit timeout… a default of 10s is applied
  when you omit it"), idempotently.

## 3. playwright-browser — real browser automation

The browser lives in a **detached daemon process** (`browser-server.mjs`), so
browser state survives pi restarts and one-shot subagent turns — a subagent can
navigate on turn 1 and keep clicking on turn 2. Each client (main agent or
subagent) gets its own session/page, so parallel subagents don't collide.

| Tool | Purpose |
|------|---------|
| `browser_open { url }` | Navigate (http/https/file), returns URL + title |
| `browser_click { selector }` | Click by CSS selector (waits up to 15s for visibility) |
| `browser_type { selector, text, submit? }` | Fill an input, optional Enter to submit |
| `browser_content { selector? }` | Extract visible text (page or element) |
| `browser_eval { script }` | Run JS in the page, get stringified result |
| `browser_screenshot { name? }` | PNG to `~/.pi/agent/browser/shots/` — returns the path to read |
| `browser_status` | Sessions + current URL/title |
| `browser_close` | Close this session's page (daemon stays up) |

Plus **`/playwright-setup`** — a user command that installs playwright +
chromium (`bun add -g playwright && playwright install chromium`, with a
verified headless launch) and reports status, with a `force` flag.

---

## 4. agent-tasks — a plain-markdown task board

The task extension provides one plain-text `TASK.md` board per main session.
Agents always use the logical path `TASK.md`; the extension wraps the built-in
`read`, `write`, and `edit` tools and transparently redirects that path
to the session's backing file, so session IDs and other metadata never enter
the model context.

All subagents inherit the same board through `PI_TASK_BASE`; they do not get
nested task files. Keep only substantial, multi-step work on the board—do not
add routine commits, quick checks, or tasks that fit in one or two turns.
`/task` shows the board (or `/task init` recreates it). Override the backing root
with `PI_TASK_DIR` (default `/tmp`).

## 5. command-code-provider — Command Code models

`command-code-provider.ts` registers Command Code as the `command-code` provider:

- OpenAI-compatible models use `https://api.commandcode.ai/provider/v1/chat/completions`.
- Claude models use the Anthropic-compatible `/messages` endpoint automatically.
- The model catalog is refreshed from `https://api.commandcode.ai/provider/v1/models`.

Set `CMD_API_KEY` before starting pi, then select a model such as
`command-code/gpt-5.6-luna` with `/model`. The provider also honors
`CMD_ZDR=1` by sending the `x-cmd-zdr: 1` request header. API keys are never
stored in this repository.

## Environment variables

| Variable | Effect |
|----------|--------|
| `CMD_API_KEY` | Command Code Provider API key |
| `CMD_ZDR` | Set to `1` to request zero-data retention from Command Code |
| `PI_BASH_DEFAULT_TIMEOUT` | Default bash timeout in seconds (default `10`) |
| `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_ID` / `PI_SUBAGENT_SCOPE` / `PI_TASK_BASE` | Set on subagent processes (depth guard, browser session id, edit scope, shared task board) |
| `PI_SUBAGENT_MAX_DEPTH` / `PI_SUBAGENT_MAX_SUBAGENTS` | Override nesting depth / concurrency limits |
| `PI_SUBAGENT_SCOPE_BLOCK_TMP` | `1` = block scoped subagents from writing to the temp dir (default: allowed) |
| `PI_TASK_DIR` | Task-board root (default `/tmp`) |
| `PI_PLAYWRIGHT_IMPORT` | Absolute path to a playwright entry file (override) |
| `PI_BROWSER_DAEMON_FILE` | Absolute path to `browser-server.mjs` |
| `PI_PLAYWRIGHT_GLOBAL_DIR` | Extra global node_modules dir to scan for playwright |

## Architecture notes

- **Async-first, never blocked** — spawns and steering
  all return immediately; completions auto-bubble as real messages (idle timers
  guarantee delivery). Completion messages contain the subagent's full final response.
- **Nothing destructive** — memory drops rewrite only the LLM context; the
  session files (main and subagent) always hold the full history.
- **State survives** — memory drops and subagent records
  persist, so they survive restarts, `/reload`, and branching.
- **Isolated enforcement** — edit scope lives in the subagent process itself;
  the browser lives in its own daemon with per-client sessions.
- **Realtime by design** — completion/bubble notifications and memory nudges
  are pushed into the running agent (`sendUserMessage` + `steer`, so they
  interrupt the current stream and trigger a turn when idle) — not queued
  behind the next user input.
