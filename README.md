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
self-managing, multi-agent system. Eight extensions, loaded from
`~/.pi/agent/extensions/`:

1. **subagent** — the agent spawns, steers, and scopes subagents that work for it.
2. **bash-timeout** — commands can't hang the agent forever.
3. **playwright-browser** — the agent (and its subagents) drive a real browser.
4. **agent-tasks** — a plain-markdown task board per session.
5. **command-code-provider** — Command Code's OpenAI/Anthropic-compatible provider endpoint.
6. **codemode-default** — `codemode` is active in every session by default.
7. **agent-mode** — pick TOKEN MAXING (delegate to subagents) or SINGLE AGENT at startup and after compaction.
8. **tool-loadout** — pick the active tools at the start of each session (or with `/tools`); core tools toggle one by one, extension tools as a unit.
9. **codemode prompt patch** — the codemode tool prompt tells the model to prefer codemode over single tool calls.
10. **system-prompt-view** — `/system` shows the live system prompt in gray TUI text plus an approximate token count.
11. **web-search** — `web_search` / `web_fetch` backed by DeepSeek's Search & Fetch API or EXA.
12. **pi-docs-section** — pi's `<docs>` system-prompt section only when the session works under a `.pi` path.
13. **bgjobs** — long shell commands run in the background and call the agent back when they finish.

Each extension auto-loads on pi start (or `/reload`); every tool below is
available to the main agent, and subagents get the browser + bash-timeout
tools too.

## Design: async-first, work as much as possible

This harness is built to be **long-running and high-throughput**: the agent
should never idle waiting on something while it can still be doing work.
Everything that takes time is pushed to the background and reports back
automatically:

- `subagent_spawn` — delegate and move on; **every spawn is asynchronous** and the
  completion **auto-bubbles** as a real message with the subagent's full final response.
  Do not sleep or poll for subagents; the harness wakes the agent when each finishes.
- `subagent_interrupt` — steering is immediate: it kills the subagent's in-flight turn
  and restarts it with your message; keep working and get pinged when it finishes.
- `bgjob_start` — run a long command in the background (build, test suite, dev server);
  the tool returns immediately and the completion **auto-bubbles** as a real message with
  the exit code and the tail of the output. Do not sleep or poll for a job.
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
each owning a private pi session file (or an OpenCode session, on the opencode
backend). Every turn runs a one-shot pi/opencode process against that session,
so steering truly continues its work with full history.

The extension is a folder project (`subagent/`): `index.ts` (wiring), `tools.ts`,
`command.ts`, `runtime.ts` (process registry, notify, resume), `config.ts` +
`constants.ts` + `types.ts`, `models.ts` (backend inference, thinking levels),
`records.ts` / `scope.ts` / `state.ts` (persistence + enforcement), `prompts.ts`,
`usage.ts`, `child.ts` (in-subagent hooks), `backends/pi.ts` + `backends/opencode.ts`
(process spawners, ACP probe), and `ui/` (settings panel, pickers).

| Tool | Purpose |
|------|---------|
| `subagent_spawn { task?, name?, tasks?, backend?, prefillReads?, scope? }` | Spawn one background subagent (always async), or pass `tasks: [{ task, name, scope? }]` for parallel subagents. Provide **exactly one** of `task`/`tasks`, and a unique `name` for every subagent. `backend: "opencode"` runs on the OpenCode CLI; everything else (model, thinking level/effort, cwd, tools, system prompt) comes from the user's configuration |
| `subagent_interrupt { name, message }` | Steer a subagent now: kills its in-flight turn (or starts a fresh turn if idle) and immediately restarts it with the message (full context preserved) |
| `subagent_scope { name, scope?, clear?, allowTmp? }` | Change a subagent's edit scope — **live**, even while it is running; `clear: true` restores unrestricted writes |
| `subagent_list` | Running/finished subagents: name, model, usage, latest output |
| `subagent_result { name }` | Full transcript: task, steering messages, tool activity, outputs |
| `subagent_forget { name }` | Interrupt a subagent, then delete it and its session (no error is reported back) |
| `subagent_config` | Effective config: backend, model, thinking level, OpenCode model/effort, system prompt, cwd, tools, per-pool limits + live usage |
| `subagent_message { message }` | Bubble-up tool (only inside subagents): send progress, findings, questions, or blockers to the main agent |

Key behaviors:

- **Never sleep for subagents** — `subagent_spawn` returns immediately and the
  harness auto-bubbles the completion; the tool description and guidelines
  explicitly tell the agent not to sleep, poll, or wait for subagents. When the
  next step depends on a result, the agent is told to **end its turn** with a
  short summary of what is in flight: the completion message wakes it up and it
  continues from there. Sleeping or polling would only burn the main context.
- **Forget is quiet** — `subagent_forget` (and `/subagent forget`) interrupts a
  running subagent first (its in-flight turn is aborted over the RPC channel)
  and deletes the files afterwards. The run is marked as intentionally stopped
  before the process goes down, so no error notification bubbles up to the main
  agent and the forgotten record does not come back from the dead.
- **Per-task edit scope** — Every spawn can supply its own file or directory scope. The harness blocks `write` and `edit` calls outside the assigned scope, preventing parallel subagents from colliding.
- **Cheaper children, better cache hits** — four things make a batch of
  subagents cheaper and more cache-friendly:
  1. **A child gets no management tools.** A subagent cannot spawn subagents, so
     the seven `subagent_*` tools are not registered inside a child: their
     descriptions would only add ~6k characters to the child's system prompt.
     The child keeps `subagent_message` (its bubble channel).
  2. **Auto prefill.** The files the main agent just read are injected into the
     child's first message (the `<shared-context-prefill>` block), so the child
     does not spend tokens reading them again — and every child of the batch
     gets the *same* prefix, which is what the provider cache keys on. Turn it
     off with `/subagent config autoPrefill no`; name files explicitly with
     `prefillReads` to override it.
  3. **One cache key per batch.** Every child of a main session is started with
     `PI_PROMPT_CACHE_KEY` (a key derived from the main session), so the
     provider routes them to the same cache slot instead of one slot per child.
     This needs the `PI_PROMPT_CACHE_KEY` patch from section 9.
  4. **Long cache retention.** Children run with `PI_CACHE_RETENTION=long`, so
     the shared prefix stays cached (24h on providers that support it) instead
     of expiring in minutes. Set `PI_CACHE_RETENTION` yourself to override.
- **Session-scoped listing** — Subagent records and `subagent_list` are isolated to the current main session; one session cannot see another session's agents.
- **Edit scope** — `scope` limits a subagent's writes to a directory or file
  list (reads stay unrestricted). Enforced *inside* the subagent process via a
  `tool_call` hook: `write`/`edit` targeting out-of-scope paths are blocked
  with a clear reason, so parallel subagents never collide.
- **Live scope changes** — the scope is mirrored to a small side file (`<id>.scope`)
  that the child re-reads before every `write`/`edit`. `subagent_scope` updates it,
  so the main agent can widen or narrow a running subagent's scope **without a
  restart** (e.g. hand a collided subagent an extra shared file, then lock it back
  down). `clear: true` removes the scope and restores unrestricted writes.
- **Interrupt & steer** — subagent processes run pi in **RPC mode**, so
  `subagent_interrupt` issues pi's real `abort` command: the in-flight tool call
  (including a running bash command) and streaming are cancelled, then the
  `[emergency] <message>` is submitted as the next prompt to the **same process**
  (full in-process context preserved; no restart). The run's normal completion
  handler then finalizes and announces the new turn's result. If the process has
  no live control channel (or abort fails), it falls back to SIGTERM/SIGKILL and a
  fresh turn; orphaned processes are stopped by pid first.
- **RPC transport** — each turn's child is launched as `pi --mode rpc` and the
  prompt is sent as a `prompt` command on stdin (the event stream parsed is the
  same as `--mode json`, so usage/output/bubbles are unchanged). The control
  channel is what makes graceful abort-and-continue possible; the child is shut
  down by closing stdin once a turn settles with no continuation queued.
- **OpenCode backend** — pass `backend: "opencode"` (or a model id like
  `opencode/big-pickle`) to run a subagent on the **OpenCode CLI** instead of pi.
  The child is launched as `opencode acp` and driven over the Agent Client
  Protocol (newline-delimited JSON-RPC on stdio): `initialize` → `session/new`
  (or `session/load`) → `session/set_config_option` (model, effort, mode) →
  `session/prompt`, streaming `session/update` chunks back. This is how pi uses
  OpenCode's **free models**, which the inference endpoint rejects for any client
  that is not OpenCode itself. OpenCode runs its own agent loop and tools, so give
  it a self-contained task; pi receives the final text. The OpenCode session id is
  stored on the record, so `subagent_interrupt` (idle path) and auto-resume
  reload the same conversation via `session/load`, and a mid-run
  `subagent_interrupt` aborts the in-flight turn with `session/cancel` and
  continues on the same session. Edit scope is conveyed to OpenCode in the
  first-turn preamble (OpenCode enforces its own permissions). The OpenCode
  model and effort are user configuration: set them in `/subagent config`
  (backend, OpenCode model + effort, probed live from the CLI) or with
  `/subagent config backend opencode`, `/subagent config opencodeModel <id>`,
  and `/subagent config opencodeEffort <variant|default>` (default model:
  `opencode/big-pickle`). A spawn only chooses the backend — pass
  `backend: "opencode"`. Models from pi's own `opencode-go` provider stay on the
  pi backend.
- **Thinking levels & efforts are user-configured** — the spawn tool does not
  take model/thinking/effort parameters; it only takes tasks and, optionally,
  the backend. For pi subagents, `/subagent config` sets the **thinking level**
  (`off` … `max`, passed to the child as `--thinking`); the panel lists only the
  levels the selected model supports (`getSupportedThinkingLevels` from
  `@earendil-works/pi-ai`). For opencode subagents it sets the model's **effort**
  (`thought_level` variants probed over ACP, selected alongside the model in the
  panel's picker and applied with `session/set_config_option`); `default` leaves
  the model default.
- **Multi-layer isolation** — nested subagents are rejected (`Nested subagents
  are not supported.`), and the two backends run in **independent concurrency
  pools**: at most `maxSubagents` pi subagents (default 4) and at most
  `maxOpencodeSubagents` opencode subagents (default 2) at the same time, so
  running opencode work never blocks pi work. Configure with
  `/subagent config maxSubagents N` / `maxOpencodeSubagents N` (or the matching
  keys in `subagent-config.json`).
- **Limits visible to every agent** — `subagent_config` and `subagent_list`
  report each pool's live usage vs its limit (`maxSubagents` / `maxOpencodeSubagents`);
  `subagent_spawn` refuses to exceed a pool with a clear reason.
- **Named subagents** — every spawn requires a short, unique `name` (single `name` or `tasks[].name`); it is the only handle used by users and agents, in listings, completion notifications, and `subagent_interrupt` / `subagent_result` / `subagent_forget` (exact name or unique prefix). The internal id is never shown and exists only for session-file management.
- **Bubble channel** — `subagent_message` inside a child is
  emitted as `{"type":"subagent_bubble",...}` JSON lines on the child's
  **stderr**. Pi takes over `process.stdout` in non-interactive modes (`json`,
  `print`, `rpc`) and redirects extension writes to stderr, so writes to stdout
  never reach the parent. The parent parses both stdout and stderr; keep the
  child bubble write on stderr.
- **Auto-bubbled completions** — when a background subagent finishes, a **real
  user message** (`sendUserMessage`) auto-bubbles into the agent's final turn
  (and triggers one even when idle). If a push was missed (e.g. extension
  reloaded mid-run), a flusher re-delivers it at session start / turn end /
  every 30s.
- **`/subagent` command + settings panel** — a management-only command: `list`,
  `view [name]` (live, markdown-rendered transcript overlay with scrolling,
  tool-call cards, follow mode, and Esc to close), `result <name>`,
  `interrupt <name> <msg>`, `scope <name> <path|none>`, `forget <name>`,
  `model [provider/id]` (pi's built-in model selector; also accepts `opencode/<id>`),
  and `config`. `/subagent config` with no arguments opens an interactive panel
  where every change **saves immediately** (no Ctrl+S): backend (`auto|pi|opencode`),
  pi model picker (Tab toggles scoped models), thinking level for the selected model,
  OpenCode model + effort (probed live from the CLI), a **Subagent tools**
  checklist, `maxSubagents`, `maxOpencodeSubagents` (the opencode pool),
  `allowTmp`, `autoPrefill`, `autoResume`, `maxAutoResumes`, plus the current
  cwd/scope. The
  same keys are settable non-interactively: `backend`, `opencodeModel`,
  `opencodeEffort`, `thinkingLevel`, `tools`, `maxSubagents`,
  `maxOpencodeSubagents`, `autoPrefill`, `autoResume`, `maxAutoResumes`,
  `scope`, `allowTmp`.
  Subagents are spawned by the agent through the `subagent_spawn` tool, not from this
  command.
- **Per-subagent tools** — `/subagent config` includes a **Subagent tools**
  checklist (also `/subagent config tools read,bash,edit`, `tools all`, or
  `tools reset`). Core tools toggle one by one; an extension's tools are one
  unit, so a child gets all of an extension's tools or none. The
  comma-separated list is stored as `tools` in `subagent-config.json`, passed to
  pi-backed children as `--tools`, and reported by `subagent_config`. Unset
  means the child inherits its normal default tools. Changes apply to newly
  spawned subagents. OpenCode has its own tool names, so the list is sent there
  as a preference in the first-turn preamble rather than as a hard allowlist.
- **Session-based context + auto-resume** — each subagent's private pi session file is
  the durable store of its context. Records are scoped to the owning main session and
  record that session's file, so when the main session is resumed (`--continue`/`--resume`
  or `/reload`) every subagent that was interrupted by a quit is **automatically resumed**
  from its session file with a "continue where you left off" prompt. Bounded by
  `maxAutoResumes` (default `3`); disable with `/subagent config autoResume no`. If pi was
  hard-killed and left an orphan child, the live pid is detected, stopped, and replaced on
  resume.

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

The browser lives in a **detached daemon process** (`browser-server.mjs`). Each
client (main agent or subagent) gets its own session/page, so parallel
subagents don't collide.

**The browser dies with pi.** The daemon is told which pi process owns it
(`--owner-pid`, the *main* pi process, so a finished subagent turn does not kill
the main agent's browser) and watches it every few seconds. When that process
goes away — a clean quit, a session switch, or a hard kill that never runs the
shutdown hooks — the daemon closes every browser it holds, removes its state
file and exits. `session_shutdown` (quit, `/reload`, `/new`, `/resume`,
`/fork`) also stops the daemon directly. A stale daemon from an older version
is killed and replaced on the next browser call.

| Tool | Purpose |
|------|---------|
| `browser_open { url }` | Navigate (http/https/file), returns URL + title |
| `browser_eval { script }` | Run JS in the page, get stringified result — the main way to drive a page (read text, query the DOM, click, fill inputs, scroll) |
| `browser_close` | Close this session's page (daemon stays up) |

Only these three tools are exposed: the browser is a shared daemon, so the
agent drives pages through `browser_eval` instead of a family of narrow tools.
The daemon itself was trimmed to the routes these tools need (`/open`,
`/eval`, `/close`, plus `/status` for the health check).

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

## 5. commandcode — Command Code models

`commandcode/index.ts` registers Command Code as the `commandcode` provider:

- OpenAI-compatible models use `https://api.commandcode.ai/provider/v1/chat/completions`.
- Claude models use the Anthropic-compatible `https://api.commandcode.ai/provider/v1/messages`
  endpoint automatically.
- The bundled catalog (`commandcode/models.ts`) is refreshed at runtime from
  `https://api.commandcode.ai/provider/v1/models`, so newly published models
  appear without an update.

Set `COMMAND_CODE_API_KEY` before starting pi (or use `/login`), then select a
model such as `commandcode/claude-sonnet-5-5` or
`commandcode/gpt-5.6-luna` with `/model`. API keys are never stored in this
repository.

**Prompt caching.** Claude models declare a `promptCache` lifetime
(5 minutes short, 1 hour long) and receive Anthropic `cache_control` markers,
so pi's cache warmer can keep their prefix alive between requests. On the
OpenAI-compatible path, long retention sends `prompt_cache_retention: "24h"`
and, via the `PI_PROMPT_CACHE_KEY` patch in section 9, the `prompt_cache_key`
that lets a subagent batch share one cached prefix; those models keep
provider-side prefix caching rather than declaring a lifetime, because their
cache lifetime is unpublished and a one-token replay is not safe for every
reasoning model. Cache warming only spends tokens when pi expects to save at
least $0.05; disable it with `"cacheWarming": "off"` in settings.

## 6. codemode-default — codemode on by default, and recommended

pi registers `codemode` inactive. `codemode-default.ts` activates it on every
`session_start` (including `/reload`), so scripts can call the other tools,
run calls in parallel, and reach classifier/image models without extra flags.
It is idempotent, respects explicit `--tools`/`--no-tools` selections and plain `defaultTools` lists that omit it, and can be disabled for one process with `PI_CODEMODE_DEFAULT=0`.

The canonical setting is also present in `~/.pi/agent/settings.json`:

```json
{ "defaultTools": ["+codemode"] }
```

**Codemode is not part of the tool selection.** It is the harness's scripting
layer, so it never appears in the loadout checklist and is always active:
`/tools none` leaves `codemode` as the only active tool, and `/tools codemode`
answers that it is always on.

**The system prompt says so.** The extension adds a `codemode` section to the
structured system prompt:

> Use the codemode tool for all tool work. Do not call tools directly.
> - Never call a tool directly. Write one codemode script per step instead: it runs the calls (independent ones with `Promise.allSettled`), chains them, and returns only the part you need.
> - A direct tool call is a mistake, not a shortcut: even a single step belongs in a script.
> - The script output is what reaches you, so filter large results inside the script instead of pulling everything into the conversation.

The tool's own description says the same (see section 9).

## 7. agent-mode — system-prompt templates at session/compaction boundaries

`agent-mode.ts` asks which system prompt the main agent should use:

| Mode | Behavior |
|---|---|
| **TOKEN MAXING** | The main agent decomposes the request, dispatches subagents with narrow scopes, requires patches under `/tmp/pi-patches/<name>/`, reviews every diff, and merges only reviewed work. It must not explore or implement on its own. |
| **SINGLE AGENT** | pi's normal system prompt, unchanged. |

The picker appears when a new session starts (`startup`, `/new`, or fork) and
after every compaction (manual, threshold, or overflow recovery). Resuming a
session restores the persisted choice without asking. The choice is stored as
an `agent-mode` custom session entry, so it follows the active branch.

Commands:

```text
/mode                    # picker
/mode token-maxing       # alias: tokenmax, token, max, tm
/mode single-agent       # alias: single, agent, normal, sa
/mode status
```

The footer shows `mode:token-maxing` or `mode:single`.

## 8. tool-loadout — per-session tool selection without cache churn

`tool-loadout.ts` opens a checklist at the start of each new session (startup,
`/new`, or fork), just like the agent-mode picker. Enter applies the checked
set; Escape keeps the restored/default set. Resuming or reloading a session
restores the persisted choice without asking. `/tools` changes it later.

**The selection is remembered across sessions.** Every choice is also written to
`~/.pi/agent/tool-loadout.json`, so the next session starts from the last
selection instead of the default tool set (the checklist opens with it
pre-checked). `codemode` is not part of the selection: it is always active and
is left out of the checklist and of the remembered list.

**Selection unit.** Core tools (`read`, `bash`, `edit`, `write`, `grep`,
`find`, `ls`, `powershell`) toggle one by one — turning off `write` while
keeping `read` is a normal wish. Everything an **extension** registers is one
unit: the browser tools, the subagent tools and pi's built-in `codemode` /
`tool_search` extensions are enabled or disabled as a whole, because half an
extension is rarely useful. The unit id is the extension's file path, so a new
tool added to an extension joins the unit automatically.

```text
/tools                         # interactive checklist
/tools read,bash,edit          # replace the selection with these
/tools +subagent               # add a unit (or a single core tool)
/tools -write                  # remove a unit (or a single core tool)
/tools all | none              # every unit / only codemode (always on)
/tools show                    # current selection + available units
```

Note: `codemode` does not bypass the loadout. A script can only call tools
that are callable — a `direct` tool must be active. With `codemode` alone the
sandbox has no `tools.read`/`tools.bash` (only MCP tools with `codemode`
exposure stay reachable).

**Cache safety and interruptions.** Changing tools with
`pi.setActiveTools()` makes pi record a system-prompt *patch*
(`toolsAdded` / `toolsRemoved`) in the transcript; it does not replace the
already-cached prompt prefix. The extension never returns a replacement
`systemPrompt`. When the selection changes while the agent is streaming,
`/tools` aborts the in-flight turn, waits for idle, and starts a new turn with
a compact tool-loadout message injected into the conversation — the same
interrupt-then-continue idea as `subagent_interrupt`. When the agent is idle,
the message is injected with the next prompt. The selected set is persisted per
session branch and re-applied before every run.

## 9. codemode prompt patch — prefer codemode over single tool calls

`tools/patch-codemode-prompt.mjs` edits the installed pi package so the
codemode tool's own prompt tells the model to prefer codemode over one tool
call at a time:

- the tool description (what the model reads when it picks a tool) gains
  *"Prefer this tool over separate tool calls: put the steps of a task into one
  script and return only the part you need."*
- the codemode system-prompt guideline gains the same preference.

It also patches the provider adapters (`@earendil-works/pi-ai` and pi's
bundled copies) so the prompt-cache key can be overridden with
`PI_PROMPT_CACHE_KEY`. pi derives that key from the session id, so every
subagent would land in its own cache slot; the subagent extension passes one
shared key per batch instead (see section 1).

Both copies are patched: `dist/extensions/codemode/tool.js` and the bundled
CLI chunk. pi is installed globally, so an update overwrites the patch — rerun
the script afterwards:

```bash
node tools/patch-codemode-prompt.mjs            # apply (idempotent)
node tools/patch-codemode-prompt.mjs --revert   # undo
```

The script finds the package through the `pi` binary on `PATH`, or takes an
explicit package directory as its first argument.

## 10. system-prompt-view — see the live system prompt

`system-prompt-view.ts` shows the system prompt the agent is actually running
with, as gray text above the editor, together with an approximate token count
(characters / 4).

```text
/system            # toggle the widget
/system on|off     # show or hide it
/system tokens     # notify the approximate token count
/system full       # write the whole prompt to a temp file and report the path
```

The prompt is refreshed before every run, so the widget always matches the next
request. The widget shows a short preview (first lines); `/system full` writes
the complete prompt to `/tmp/pi-system-prompt-<timestamp>.md`.

## 11. web-search — search and fetch the live web

`web-search.ts` registers two tools backed by the same providers:

| Tool | Purpose |
|---|---|
| `web_search { query, count?, provider?, includeContent?, context? }` | Ranked web results with title, url, snippet, optional page content |
| `web_fetch { url, provider? }` | One page as Markdown |

**Providers**

- **deepseek** — DeepSeek's own [Search & Fetch API](https://api-docs.deepseek.com/guides/search/):
  `POST /v1/tools/search` and `POST /v1/tools/fetch`. The key comes from the
  `deepseek` provider configured in pi, `DEEPSEEK_API_KEY`, or an `exa`/`deepseek`
  entry in `~/.pi/agent/auth.json`. The search query supports the DeepSeek
  operators `site:`, `-site:`, `lang:`, `after:`, `before:`, `"exact phrase"`
  and `-`; `context` passes the original question for better query
  understanding.
- **exa** — EXA's search API (`POST https://api.exa.ai/search`) and contents
  API (`POST https://api.exa.ai/contents`). The key comes from `EXA_API_KEY` or
  an `exa` entry in `~/.pi/agent/auth.json`.

```text
/web-search                      # provider status (which keys are found)
/web-search provider auto|deepseek|exa
/web-search test <query>         # run a search and list the hits
```

The pinned provider is stored in `~/.pi/agent/web-search.json`; `auto` (the
default) uses the first provider with a key, deepseek before exa.

## 12. pi-docs-section — pi docs only where they belong

pi's system prompt always carries a `<docs>` section pointing at pi's own
documentation (README, `docs/`, `examples/`). In an ordinary project that is
noise, so `pi-docs-section.ts` removes it from the request unless the working
directory is under a `.pi` path (`~/.pi/agent/extensions`, a project with a
`.pi/` directory, …).

```text
/pi-docs                # status: shown / hidden, mode, cwd
/pi-docs always|never|auto
```

`auto` (the default) means "show it under a `.pi` path". `PI_DOCS_SECTION=always|never|auto`
overrides it from the environment; the command stores the choice in
`~/.pi/agent/pi-docs.json`.

**How it works.** The extension transforms the request in the
`context_with_system` hook and drops the `docs` entry from the system message's
section map. The transcript keeps pi's structured sections untouched, so the
tool-patch mechanism and the prompt cache keep working.

This is also why the other extensions no longer force a system prompt: a
forced prompt (`return { systemPrompt }`) replaces the whole header and would
bring the docs section back. They now contribute structured parts instead:

| Extension | Contribution |
|---|---|
| `bash-timeout` | a rule in the `rules` section (`systemPromptOptions.promptGuidelines`) |
| `agent-tasks` | a `task_board` section |
| `agent-mode` | a `token_maxing` section |

## 13. bgjobs — background jobs that call back

`bgjobs/` runs shell commands in the background and **calls the agent back**
when they finish: the completion arrives as a real user message with the exit
code and the tail of the output, so the agent never has to poll a long command.

| Tool | Purpose |
|---|---|
| `bgjob_start { command, name?, cwd?, timeout? }` | Start a background job; returns immediately with a job id. The harness notifies the agent when it ends |
| `bgjob_list {}` | The session's jobs: name, id, state, exit code, runtime |
| `bgjob_output { job, lines? }` | The tail of a job's log (stdout + stderr), also while it runs |
| `bgjob_kill { job }` | Stop a running job (its whole process group) |

```text
/bgjobs              # list all jobs
/bgjobs show <job>   # show a job's output
/bgjobs kill <job>   # stop a running job
/bgjobs kill-all     # stop every running job
```

Key behaviors:

- **Never poll** — `bgjob_start` returns immediately; the completion callback
  carries the exit code and the output tail. A missed callback (reload, busy
  turn) is re-delivered by the idle timer, so no result is ever lost.
- **Jobs outlive pi** — each job runs in its own process group with stdout and
  stderr redirected straight into its log file, so it keeps running (and keeps
  logging) when pi quits. A later session **adopts** the jobs that are still
  running and reports them when they end.
- **Exit codes survive** — the job runs through a small wrapper script that
  records the command's exit code in a file, so even a job that outlived its
  pi process reports *how* it ended (the agent sees `failed (exit code 3)`).
- **Session-scoped** — records, logs and exit files live in
  `~/.pi/agent/bgjobs/<session>/`; one session never sees another's jobs.
- **Safety nets** — an optional `timeout` kills a job that never ends
  (`timed out after 60s`), and `bgjob_kill` stops a whole process group.

## Environment variables

| Variable | Effect |
|----------|--------|
| `COMMAND_CODE_API_KEY` | Command Code Provider API key |
| `PI_BASH_DEFAULT_TIMEOUT` | Default bash timeout in seconds (default `10`) |
| `PI_CODEMODE_DEFAULT` | `0`/`false`/`no` disables automatic `codemode` activation |
| `DEEPSEEK_API_KEY` | Key for the DeepSeek Search & Fetch API (falls back to the configured `deepseek` provider) |
| `EXA_API_KEY` | Key for the EXA search and contents APIs |
| `PI_DOCS_SECTION` | `always`/`never`/`auto` — when to include pi's docs section in the system prompt |
| `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_ID` / `PI_SUBAGENT_SCOPE` / `PI_TASK_BASE` | Set on subagent processes (depth guard, browser session id, edit scope, shared task board) |
| `PI_SUBAGENT_MAX_SUBAGENTS` | Override the pi subagent concurrency limit (default `4`) |
| `PI_SUBAGENT_MAX_OPENCODE_SUBAGENTS` | Override the opencode subagent concurrency limit (default `2`, independent pool) |
| `PI_SUBAGENT_SCOPE_BLOCK_TMP` | `1` = block scoped subagents from writing to the temp dir (default: allowed) |
| `PI_SUBAGENT_TOOLS_SET` | Set by the parent when a subagent has an explicit tools list; skips default `codemode` activation in the child |
| `PI_CACHE_RETENTION` | Prompt-cache retention for child processes: the harness sets `long` so a batch's shared prefix stays cached |
| `PI_PROMPT_CACHE_KEY` | Prompt-cache key for child processes: the harness sets one key per main session so a batch shares a cache slot (needs the patch from section 9) |
| `PI_OPENCODE_BIN` | Path to the `opencode` CLI for opencode-backed subagents (default: `opencode` on `PATH`) |
| `PI_TASK_DIR` | Task-board root (default `/tmp`) |
| `PI_BGJOBS_DIR` | Root directory for background-job records, logs and exit files (default `~/.pi/agent/bgjobs`) |
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
