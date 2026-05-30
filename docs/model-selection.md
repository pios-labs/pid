# Model Selection in pid

How pid services specify which LLM provider and model to use, and how pi's model-switching capabilities compose with pid's supervision.

This document focuses on model selection. For the full set of Pi configuration fields available in the service YAML (tools, extensions, skills, system prompt, etc.), see the [service file schema](./v0-spec.md#service-file-schema-yaml).

## The short version

Add a `model:` section to your service YAML:

```yaml
name: inbox-watcher
cwd: ~/inbox
prompt: |
  Check ~/inbox/ for new files...

model:
  provider: zai
  id: glm-5.1

budget:
  daily_usd: 1.00
```

pid translates this to CLI flags when spawning the pi subprocess: `pi --mode rpc --provider zai --model glm-5.1 --session-id inbox-watcher`. If you omit `model:`, pi uses whatever model it resolves from its own settings (`~/.pi/agent/settings.json`, env vars, `models.json`).

## How pi handles models (background)

Pi has a rich model system that pid inherits for free. Understanding it helps you decide where to configure model selection for your services.

### Three layers of model control

**1. Launch-time (CLI flags)** — what pid uses when spawning a subprocess:

```bash
pi --mode rpc --provider zai --model glm-5.1
pi --mode rpc --model zai/glm-5.1              # provider/id shorthand
pi --mode rpc --model sonnet:high              # model + thinking level
pi --mode rpc --models "claude-*,gpt-4o"       # scoped model set for cycling
pi --mode rpc --thinking high                  # thinking level
```

**2. Mid-session via RPC commands** — any RPC client (including pid) can send to stdin:

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
{"type": "cycle_model"}
{"type": "get_available_models"}
{"type": "set_thinking_level", "level": "high"}
```

**3. From inside pi via extensions** — extensions can change models programmatically:

```ts
// Switch model based on task type
pi.on("agent_start", async (_event, ctx) => {
  const model = ctx.modelRegistry.find("zai", "glm-5.1");
  if (model) await pi.setModel(model);
});

// Register an entirely new provider
pi.registerProvider("local-llm", {
  baseUrl: "http://localhost:11434/v1",
  api: "openai-completions",
  apiKey: "ollama",
  models: [{ id: "llama3.1:8b" }],
});
```

All three layers emit `model_select` events visible to pid on the event stream. Pi's docs cover these in detail: [RPC mode](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md), [extensions](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md), [custom models](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md).

### Pi's model resolution order

When pi starts, it resolves a model from (highest priority first):

1. `--model` / `--provider` CLI flags
2. Scoped models from `--models` flag or settings
3. Saved default from `settings.json`
4. First available model with a configured API key

pid's `model:` section maps to #1, giving it top priority.

### Available providers and models

Pi ships with built-in support for 30+ providers. Each has a default model. A sample:

| Provider | Default model | Env var |
|-|-|-|
| `anthropic` | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-5.4` | `OPENAI_API_KEY` |
| `zai` | `glm-5.1` | `ZAI_API_KEY` |
| `google` | `gemini-3.1-pro-preview` | `GEMINI_API_KEY` |
| `deepseek` | `deepseek-v4-pro` | `DEEPSEEK_API_KEY` |
| `openrouter` | `moonshotai/kimi-k2.6` | `OPENROUTER_API_KEY` |

Full list: [pi providers docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md).

Custom/local providers (Ollama, LM Studio, vLLM) are configured via `~/.pi/agent/models.json` or via pi extensions using `pi.registerProvider()`. See [pi custom models docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md).

## Service YAML reference

### `model` section

All fields are optional. If the entire `model:` section is omitted, pi resolves the model from its own settings.

```yaml
model:
  provider: string           # pi provider name (e.g., "anthropic", "zai", "openai")
  id: string                 # model ID within that provider (e.g., "glm-5.1", "claude-sonnet-4-5")
  thinking: string           # thinking level: off | minimal | low | medium | high | xhigh
  scoped: [string]           # models available for cycling (maps to --models flag)
```

### How pid maps `model:` to CLI args

| YAML field | CLI flag | Notes |
|-|-|-|
| `model.provider` | `--provider` | Only used when `model.id` is also set |
| `model.id` | `--model` | Can include `provider/id` shorthand or `model:thinking` |
| `model.thinking` | `--thinking` | Overridden if thinking is embedded in `model.id` |
| `model.scoped` | `--models` | Comma-separated list of model patterns |

If `model.provider` is omitted but `model.id` includes a `/`, pi parses the provider from it (e.g., `zai/glm-5.1` → provider `zai`, model `glm-5.1`).

### Examples

**Simple — one provider, one model:**

```yaml
name: inbox-watcher
model:
  provider: zai
  id: glm-5.1
```

**With thinking level:**

```yaml
name: code-reviewer
model:
  provider: anthropic
  id: claude-sonnet-4-5
  thinking: high
```

**Provider/id shorthand (no separate provider field):**

```yaml
name: summariser
model:
  id: zai/glm-5.1
```

**Scoped models for cycling:**

```yaml
name: multi-model-agent
model:
  id: zai/glm-5.1
  scoped:
    - "zai/glm-5.1"
    - "anthropic/claude-sonnet-4-5"
    - "openai/gpt-5.4"
```

**No model section — inherits from pi settings:**

```yaml
name: default-model-agent
cwd: ~/projects/work
prompt: Use whatever model pi is configured with
```

## Dynamic model switching

pid services can change models during a session. This is one of pi's strengths and it works transparently under pid.

### Via pi extensions (recommended for complex logic)

Write a pi extension, place it in your service's `.pi/extensions/` directory. The extension runs inside the pi subprocess and has full access to the model registry.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Switch to a cheaper model after the first turn
  let turnCount = 0;
  pi.on("turn_end", async (_event, ctx) => {
    turnCount++;
    if (turnCount === 1) {
      const cheap = ctx.modelRegistry.find("zai", "glm-4.7");
      if (cheap) await pi.setModel(cheap);
    }
  });
}
```

Use cases: per-task model routing, fallback on rate limits, cost-aware model stepping, time-of-day pricing optimisation.

### Via pid RPC (future — operator-initiated)

pid owns the subprocess stdin. A future `pid set-model <service> <provider/model>` command could send `set_model` directly to a running service. This enables:

- Operator pushes a model change without restarting the service
- Cost governor switches to a cheaper model before pausing (budget-aware model stepping)
- Fleet-wide model migration via scripting

This is not implemented in v0 but the protocol supports it today.

### Via raw `args` (escape hatch)

For edge cases where the `model:` section isn't expressive enough, use the `args` field directly:

```yaml
name: custom-args-agent
args: ["--provider", "anthropic", "--model", "claude-sonnet-4-5:high", "--models", "claude-*"]
```

pid always injects `--mode rpc --session-id <name>` — you don't need to include those.

**Important:** you cannot use both. If you set `model.id` in the YAML *and* put `--model` in `args`, pid rejects the service file with a clear error. Pick one approach per flag — YAML field or `args` — not both. This rule applies to all Pi configuration fields (`tools`, `extensions`, `skills`, etc.), not just `model`.

## How cost tracking works across model switches

pid's cost governor reads `event.message.usage.cost.total` from every `message_end` event. This field is populated by pi per-message, using whatever model produced that message. So:

- If turn 1 uses Claude Opus ($0.15) and turn 2 uses GLM 5.1 ($0.02), pid accumulates $0.17
- Model switches mid-session are transparent to the cost governor
- The budget tracks actual spend, not estimated spend based on the declared model

This is a key design property: **pid doesn't need to know which model is active to track cost accurately.** It reads cost from the event stream, not from the service config.

## Decision heuristic: where to configure models

| Scenario | Configure where | Why |
|-|-|-|
| "This service always uses GLM 5.1" | `model:` in service YAML | Simple, declarative, visible in config |
| "Use Claude for planning, GLM for execution" | pi extension with `pi.setModel()` | Dynamic logic belongs in extension code |
| "Operator needs to hot-swap a model on a running service" | `pid set-model` (future) | No restart, no config change |
| "Use Ollama locally for dev, Anthropic in prod" | `env:` in service YAML + pi `models.json` | Environment-driven resolution |
| "Fall back to cheaper model on rate limits" | pi extension with `after_provider_response` hook | Extension can detect 429 and switch |
| "Register a custom/local provider" | pi extension with `pi.registerProvider()` | Dynamic provider setup |

## API key handling

pid never reads or manages API keys. Keys are resolved by pi at subprocess startup from:

1. `--api-key` CLI flag (via `args:` in service YAML)
2. `~/.pi/agent/auth.json`
3. Environment variables (which can be set per-service via `env:` in the YAML)

Per-service API key isolation via env vars:

```yaml
name: production-agent
model:
  provider: anthropic
  id: claude-sonnet-4-5
env:
  ANTHROPIC_API_KEY: "sk-ant-prod-..."

name: dev-agent
model:
  provider: anthropic
  id: claude-sonnet-4-5
env:
  ANTHROPIC_API_KEY: "sk-ant-dev-..."
```

## Related reading

- [pi providers](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md) — all supported providers and auth setup
- [pi custom models](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md) — `models.json` for Ollama, vLLM, proxies
- [pi custom providers](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md) — extension-based provider registration
- [pi RPC mode](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) — `set_model`, `cycle_model`, `get_available_models` commands
- [pi extensions](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) — `pi.setModel()`, `pi.registerProvider()`, model events
- [pid v0 spec](./v0-spec.md) — service file schema, event consumer, cost governor
