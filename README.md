# dsh-tgrep

[![npm version](https://img.shields.io/npm/v/dsh-tgrep.svg)](https://www.npmjs.com/package/dsh-tgrep)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/huuthuan-nguyen/dsh-tgrep)](https://github.com/huuthuan-nguyen/dsh-tgrep/releases)

Shadow the built-in `grep` tool in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with [Microsoft tgrep](https://github.com/microsoft/tgrep) (trigram-indexed fast regex search).

Provides orders-of-magnitude faster code searches on medium-to-large repositories while retaining full compatibility with DeepSeek Harness's interactive Web GUI search cards and Programmatic Tool Calling (PTC) mode.

---

## Features

- **Trigram-indexed search**: Instant query latency across millions of lines of code using `tgrep`.
- **Full Web GUI integration**: Generates structured search metadata so DeepSeek Harness renders native expandable file groups, match counters, and quick jumps.
- **Graceful degradation**: Searches directly if no index is built yet; automatically utilizes `tgrep serve` background daemon if running.
- **PTC & agent-plane shadowing**: Scoped to each agent so it cleanly replaces built-in ripgrep without modifying stock system presets.
- **Safe parameter handling**: Immune to CLI flag injection (`--regexp` and `--` boundaries); supports regex, `include` glob filters, and case-insensitive flags.
- **Zero build steps**: Pure modern ESM JavaScript — installs and runs directly without compiling.
- **Zero runtime dependencies**: Never imports harness internals; the tool contract is plain JSON Schema.

---

## Tool Contract

`dsh-tgrep` shadows `grep` on the agent plane, so the model sees this contract instead of the
stock ripgrep one:

| Field | Value |
|---|---|
| `parameters` | `pattern` (required), `path`, `include`, `case_insensitive`, `max_results` |
| `timeoutMs` | `30000` — enforced by the harness tool-call timeout policy through `exec.signal` |
| `presentationMeta` | `SearchMeta` (`shape: 'matches'`) with per-line previews, capped at 64 KiB |
| `presentCall` / `presentResult` | Generic search call card + native search result card |

`case_insensitive` and `max_results` are extensions over the stock tool. Unlike the stock tool,
which spills an over-cap result to a workspace file, `dsh-tgrep` reports a truncation note
inline and never writes a recovery file.

---

## Prerequisites

1. **Node.js**: `>= 22.19.0`
2. **Microsoft tgrep**: Must be installed and available on `PATH`.
   - **macOS (Homebrew)**:
     ```bash
     brew install tgrep
     ```
   - **Cargo (Any platform with Rust)**:
     ```bash
     cargo install tgrep
     ```
   - **Pre-built binaries**: Download from [Microsoft tgrep Releases](https://github.com/microsoft/tgrep/releases).

---

## Installation

You do **not** need to clone or compile this repository manually. DeepSeek Harness installs it directly into any profile:

### Method 1: Directly from NPM Registry (Recommended)

```bash
# For Web GUI profile
dsh plugin --profile web add dsh-tgrep

# Or for headless / TUI profile
dsh plugin --profile tui add dsh-tgrep
```

### Method 2: Directly from GitHub (Without manual git clone)

You can also install straight from GitHub, optionally pinned to a release tag:

```bash
# Latest from default branch
dsh plugin --profile web add github:huuthuan-nguyen/dsh-tgrep

# Or pinned to a specific release tag
dsh plugin --profile web add github:huuthuan-nguyen/dsh-tgrep#v0.1.3
```

### Method 3: From Local Checkout (For development/contributors)

```bash
dsh plugin --profile web add ./dsh-tgrep
```

> **Note:** After installing, simply restart your DeepSeek Harness profile (e.g. `dsh web` or `dsh --profile web`).

---

## Configuration

When installed, `dsh-tgrep` contributes a default configuration layer. You can customize settings in your profile's `cordis.patch.yml` or `$DSH_HOME/cordis.patch.yml`:

```yaml
- insert:
    - id: tgrep
      name: dsh-tgrep
      config:
        # Enable or disable the plugin
        enabled: true
        # Prefer connecting to a running tgrep serve instance or local index
        preferServer: true
        # Soft limit on returned matches (model context protection)
        maxLines: 300
        # Extra CLI flags passed to tgrep (e.g. ["--hidden"])
        extraArgs: []
```

---

## Indexing Your Codebase (Optional but Recommended)

`tgrep` works out-of-the-box without an index by scanning files. For maximum speed in large workspaces:

1. **Build a local index**:
   ```bash
   cd /path/to/your/project
   tgrep index .
   ```
2. **Or run a persistent search daemon**:
   ```bash
   tgrep serve
   ```
   `tgrep` will automatically connect to the background server for sub-millisecond queries.

---

## Verification

To verify that the plugin is active:
1. Start DeepSeek Harness: `dsh web`
2. In the chat, ask the model: `Search for "name" in package.json using grep.`
3. The model will invoke `grep` powered by `tgrep`, and the matches will render inside the native Search card.

---

## Uninstallation

To remove `dsh-tgrep` from your profile:

```bash
dsh plugin --profile web remove dsh-tgrep
```

---

## Compatibility & Troubleshooting

### `Cannot read properties of undefined (reading 'prepare')`

**This is a DeepSeek Harness defect, not a `dsh-tgrep` defect.** It was verified on a profile
with **zero plugins installed**: every tool call (`bash`, `read`, `grep`, …) aborted the turn.

Root cause, in the harness:

- `packages/core/agent-loop/src/tool-calls.ts` reaches into the tool registry with
  `ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)` and never checks the result.
- `TOOL_RUNTIME_SCHEDULER` is declared with `Symbol(...)` (`packages/core/tools/src/index.ts`),
  not `Symbol.for(...)`, so the key is **private to one module instance**.
- Harness `v0.1.6-alpha.2` changed the default `resolutionMode` from `link` to `runtime`
  (`apps/cli/src/profile-boot.ts`). When `@deepseek-ai/dsh-tools` is reachable through two
  resolution paths (the workspace copy and the profile install anchor's symlink), Node
  evaluates it twice, the two symbols differ, the lookup yields `undefined`, and the cryptic
  `Cannot read properties of undefined (reading 'prepare')` aborts every tool call.

Workarounds until the harness ships a fix:

```bash
# 1. One-line local harness patch, then rebuild the host libraries:
#    packages/core/tools/src/index.ts
#    - export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('@deepseek-ai/dsh-tools.scheduler')
#    + export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol.for('@deepseek-ai/dsh-tools.scheduler')
pnpm run build:lib:host

# 2. Or pin a harness release without the changed default:
#    dsh-v0.1.6-alpha.1

# 3. Or force the previous resolution mode, if your CLI exposes it:
dsh --help | grep -i resolution
```

### Why `dsh-tgrep` does not import harness internals

Since `0.1.2` the plugin is **zero-dependency by design**: it never imports
`@deepseek-ai/dsh-tools` (or any other harness package), and declares its tool contract as
plain JSON Schema. Third-party plugins should not load harness internals at runtime — doing so
can add yet another evaluated copy of the package and, with a private symbol key, break the
host's own lookups. The plugin's contract with the harness is exactly the object passed to
`tools.register()`.

---

## License

MIT © 2025-present Thuan Nguyen
