# pi agent harness

A set of extensions that turn the [pi coding agent](https://github.com/earendil-works/pi) into a
self-managing, multi-agent system. Four extensions, loaded from
`~/.pi/agent/extensions/`:

1. **agent-memory** — the agent manages its own conversation memory (not just compaction).
2. **subagent** — the agent spawns, steers, waits on, and scopes subagents that work for it.
3. **bash-timeout** — commands can't hang the agent forever.
4. **playwright-browser** — the agent (and its subagents) drive a real browser.
5. **agent-tasks** — a plain-markdown task board per session.
6. **agent-bash-jobs** — background bash commands with realtime completion.

Each extension auto-loads on pi start (or `/reload`); every tool below is
available to the main agent, and subagents get the browser + bash-timeout
tools too.

---

## 1. agent-memory — self-managed conversation memory

pi compacts context by summarizing everything. This harness lets the agent
decide, turn by turn, what to keep in full detail and what to compress to a
"first few lines" stub — **without deleting anything**. The session file stays
intact; drops only rewrite what is sent to the model, so they can always be
undone.

| Tool | Purpose |
|------|---------|
| `memory_index` | List every turn: first lines of the turn start/end, message count, token estimate |
| `memory_drop { turnIds, lines? }` | Compress chosen turns to first-N-line stubs (nothing is deleted) |
| `memory_restore { turnIds? }` | Bring full detail back |
| `memory_status` | What's dropped, token savings, live context usage |

Plus a `/memory [index | status | drop <ids> | restore [ids]]` command for
humans (renders the index as a scrollable panel in the TUI).

The agent is **nudged proactively**: when live context usage crosses the
30% / 50% / 70% bands ("context is at X% — consider calling memory_drop…"), a
**real user steering message** is pushed (`sendUserMessage`, so it always
triggers a turn and is visible in the chat) — once per band, only when
droppable turns exist. It fires after each turn settles, at session start, and
from an idle timer. Band state persists in the session, so it doesn't re-nag.

## 2. subagent — spawn, steer, wait, scope

One generic subagent type (model chosen by the user via `/subagent model`),
each owning a private pi session file. Every turn runs a one-shot pi process
against that session, so steering truly continues its work with full history.

| Tool | Purpose |
|------|---------|
| `subagent_spawn { task, model?, cwd?, tools?, scope?, await? }` | Spawn a subagent. `await: false` returns immediately (background) |
| `subagent_send { subagentId, message }` | Push a message / steer — resumes its session with full context |
| `subagent_wait { subagentId \| all: true }` | Block until one (or all) finish, streaming live `done/total` progress |
| `subagent_list` | Running/finished subagents: id, model, usage, latest output |
| `subagent_result { subagentId }` | Full transcript: task, steering messages, tool activity, outputs |
| `subagent_forget { subagentId }` | Delete a subagent and its session |
| `subagent_config` | Effective config: model, system prompt, cwd, tools |
| `subagent_message` / `subagent_request` | Bubble-up tools (only inside subagents): send progress/requests to the main agent |

Key behaviors:

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
- **Realtime notifications** — background completions and bubbles deliver
  immediately (`followUp` + `triggerTurn`), so an idle main agent wakes up and
  acts without the user prompting.
- **`/subagent` command** — spawn, `list`, `result <id>`, `send <id> <msg>`,
  `forget <id>`, `model [provider/id]` (interactive model picker), `config`.

## 3. bash-timeout — no more hung commands

pi's bash tool has no default timeout; when the agent forgets one, a command
can hang forever. This extension:

- **Enforces** a default `timeout: 10` on every bash call that omits one
  (a `tool_call` hook mutates the input before the bash tool runs). Explicit
  timeouts are respected. Override the default with `PI_BASH_DEFAULT_TIMEOUT`.
- **Reminds** the agent via a `before_agent_start` guideline appended to the
  system prompt ("always pass an explicit timeout… a default of 10s is applied
  when you omit it"), idempotently.

## 4. playwright-browser — real browser automation

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

## 5. agent-tasks — a plain-markdown task board

No tool-based task system — just a `TASK.md` file per session that the agent
reads with `read` and updates directly with the `edit` tool (fully
transparent, plain text). The extension only initializes the file and tells
the agent where it lives via a system-prompt guideline.

- **Main agent:** `/tmp/<session_id>/TASK.md`
- **Subagents:** nested under their parent — `/tmp/<session_id>/<subagent_id>/TASK.md`
  (and deeper layers nest further). The parent session id and chain are passed
  to subagent processes via `PI_TASK_BASE`.

`/task` shows the board (or `/task init` recreates it). Override the root dir
with `PI_TASK_DIR` (default `/tmp`).

## 6. agent-bash-jobs — run commands in the background

Long commands no longer block the agent: `bash_job_start { command }` returns a
job id immediately, the job runs in the background, and when it finishes a
message is pushed to the agent in realtime (`followUp` + `triggerTurn`). The
agent can do other work, or block with `bash_job_wait` (which streams progress
and suppresses the duplicate push).

| Tool | Purpose |
|------|---------|
| `bash_job_start { command, timeout?, cwd? }` | Start a background job, returns `jobId` immediately |
| `bash_job_wait { jobId, timeoutMs? }` | Block until done, streaming output; suppresses the completion push |
| `bash_job_list` | Running/finished jobs: status, duration, command |
| `bash_job_result { jobId }` | Full output + exit code of a finished job |
| `bash_job_cancel { jobId }` | Kill a running job (no completion push) |

Job records persist in `~/.pi/agent/bash-jobs/` (survive restarts; jobs
orphaned by a restart are marked `lost`). Optional `timeout` kills runaway
commands. `/bash-jobs` lists them for humans.

## Setup

```bash
# extensions auto-load from ~/.pi/agent/extensions/ — symlink or copy them there
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)"/agent-memory.ts ~/.pi/agent/extensions/
ln -s "$(pwd)"/subagent.ts ~/.pi/agent/extensions/
ln -s "$(pwd)"/bash-timeout.ts ~/.pi/agent/extensions/
ln -s "$(pwd)"/playwright-browser.ts ~/.pi/agent/extensions/
ln -s "$(pwd)"/browser-server.mjs ~/.pi/agent/extensions/

# browser tools need playwright + chromium (or run /playwright-setup inside pi)
bun add -g playwright && playwright install chromium
```

Then start pi (or `/reload`) and the tools are live. Commands run in pi's TUI:
`/memory`, `/subagent`, `/playwright-setup`.

## Environment variables

| Variable | Effect |
|----------|--------|
| `PI_BASH_DEFAULT_TIMEOUT` | Default bash timeout in seconds (default `10`) |
| `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_ID` / `PI_SUBAGENT_SCOPE` | Set on subagent processes (depth guard, browser session id, edit scope) |
| `PI_PLAYWRIGHT_IMPORT` | Absolute path to a playwright entry file (override) |
| `PI_BROWSER_DAEMON_FILE` | Absolute path to `browser-server.mjs` |
| `PI_PLAYWRIGHT_GLOBAL_DIR` | Extra global node_modules dir to scan for playwright |

## Architecture notes

- **Nothing destructive** — memory drops rewrite only the LLM context; the
  session files (main and subagent) always hold the full history.
- **State survives** — memory drops and subagent records persist as session
  entries, so they survive restarts, `/reload`, and branching.
- **Isolated enforcement** — edit scope lives in the subagent process itself;
  the browser lives in its own daemon with per-client sessions.
- **Realtime by design** — completion/bubble notifications and memory nudges
  are injected into the running agent (`triggerTurn` / `before_agent_start`),
  not queued behind the next user input.
