# Command Code provider for pi

Connects [pi](https://github.com/earendil-works/pi) to Command Code's
[Provider API](https://commandcode.ai/docs/provider). Command Code exposes its
model catalog — Claude, GPT, Gemini, DeepSeek, GLM, Kimi, Qwen, Grok, and more —
through standard OpenAI- and Anthropic-compatible endpoints, so this extension is
a thin provider definition: endpoint, auth, and per-model metadata. Request
conversion, streaming, tool calls, usage accounting, and cancellation are handled
by pi-ai's built-in `anthropic-messages` and `openai-completions` implementations.

## Setup

Create an API key in Command Code Studio, then either:

**Environment variable**

```bash
export COMMAND_CODE_API_KEY=cmd_...
```

**Or `/login`**

```
/login commandcode
```

Paste the key when prompted. It is stored in `~/.pi/agent/auth.json` like any
other provider credential.

## Use

```
/model commandcode/claude-sonnet-5-5
/model commandcode/deepseek/deepseek-v4.1-flash
```

The model picker also groups every model under the **Command Code** provider once
authentication is configured.

## How it maps to the API

| Model family | Endpoint | pi `api` | Base URL |
|---|---|---|---|
| Claude models | `POST /provider/v1/messages` | `anthropic-messages` | `https://api.commandcode.ai/provider` |
| Everything else | `POST /provider/v1/chat/completions` | `openai-completions` | `https://api.commandcode.ai/provider/v1` |

The base URLs differ because the Anthropic SDK appends `/v1/messages` while the
OpenAI SDK appends `/chat/completions`.

OpenAI-compatible models are sent with `max_tokens` (not `max_completion_tokens`),
`reasoning_effort` for thinking levels, and `system` messages instead of
`developer` messages, matching what Command Code's proxy expects.

Claude models use Anthropic **adaptive thinking** (`thinking.type: "adaptive"`
plus `output_config.effort`). The legacy budget-based `thinking.type: "enabled"`
is rejected by the upstream for these models.

## Model catalog

`models.ts` bundles a snapshot of the catalog (87 models) so the provider works
offline and on first start. At runtime `refreshModels()` refreshes it from
`GET /provider/v1/models` and applies bundled metadata for known models. Any newly
published model is added automatically.

Bundled metadata (context window, output cap, reasoning levels, input
modalities, and per-million-token pricing) is derived from Command Code's own
model catalog and pricing tables.

## Notes

- Cost figures are per million tokens and mirror Command Code's published
  underlying rates. Actual Command Code plan credits are metered separately.
- Thinking levels are clamped to the levels each model supports. Models with no
  reasoning effort stay on `off`.
- Unsupported thinking levels are reported as `null` in each model's
  `thinkingLevelMap`, so pi clamps rather than sending an invalid effort.

## Files

- `index.ts` — provider registration, auth, and live model discovery
- `models.ts` — bundled model catalog and API constants
