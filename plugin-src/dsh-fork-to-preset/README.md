# dsh-fork-to-preset

![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/github/v/release/bpc-oss/dsh-fork-to-preset)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds a **"Fork preset"** pill to the composer tool row, right beside the model select (same visual spec). Pick any agent preset from the roster and fork the current session into a fresh independent child session running under that preset — inheriting the parent's completed turns.

## How it works

- Click the **Fork preset** pill in the composer bar (left of the model select)
- The menu lists **names only**; hovering a row (or moving focus with arrow keys) fills the detail pane at the menu's bottom edge with the full preset identity (id + complete description + default badge)
- Clicking a preset forks immediately → a new session opens, mounted on the chosen preset, with the parent's completed-turn history
- Keyboard: ↓/↑ cycles, Enter forks, Escape closes — the same interaction contract as the model-select menu

## Distribution

**GitHub-only.** Not published to npm. Install by mounting the package directory with a `cordis.patch.yml` bundle declaration.

Requires a platform that has the `session.fork({ agentPreset })` API (DeepSeek Harness rc.8+).

## Install

### 1. Link the package into the harness install

```bat
:: Windows
mklink /J "<plugin-dir>\node_modules" "<harness>\resources\host\node_modules"
```

```sh
# POSIX (Linux/macOS)
ln -s "<harness>/resources/host/node_modules" "<plugin-dir>/node_modules"
```

### 2. Add the bundle to a profile

```json
{
  "dependencies": { "dsh-fork-to-preset": "link:<plugin-dir>" },
  "dsh": { "profile": { "bundles": ["...", "dsh-fork-to-preset"] } }
}
```

## License

MIT
