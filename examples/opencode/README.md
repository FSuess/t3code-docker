# DeepSeek through OpenCode

T3 Code has no DeepSeek driver. Its providers are Claude, Codex, Cursor, Grok,
OpenCode and Antigravity. OpenCode can use any OpenAI-compatible endpoint, and
T3 Code can drive OpenCode, so DeepSeek works through OpenCode.

## Install

```bash
docker compose exec -u t3 t3code sh -c \
  'mkdir -p ~/.config/opencode &&
   cp /opt/examples/opencode/opencode.deepseek.json ~/.config/opencode/opencode.json'
```

If you already have an `opencode.json`, merge the `provider.deepseek` block into
it instead. Then set the key and restart:

```bash
# in .env
DEEPSEEK_API_KEY=sk-...
```

```bash
docker compose up -d
```

In T3 Code, turn the OpenCode provider on under **Settings → Providers**, then
pick a DeepSeek model in the composer. To see which models OpenCode found:

```bash
docker compose exec -u t3 t3code opencode models | grep -i deepseek
```

## Model IDs change

The IDs in the example config are DeepSeek's stable aliases. DeepSeek releases
new models more often than this repository is updated, so check
<https://api-docs.deepseek.com/quick_start/pricing> for the models your key can
use and add them under `models`. An unknown ID fails when a request is made,
not at startup, so a wrong name shows up as a failing thread rather than a
config error.

## Without OpenCode

In T3 Code, each provider instance can have its own environment variables. A
second Claude or Codex instance pointed at a DeepSeek-compatible base URL works
without OpenCode. Set the variables under **Settings → Providers → (instance) →
Environment variables**, not under **Launch arguments**.
