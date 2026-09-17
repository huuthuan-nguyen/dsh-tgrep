# ⚡ DSH-Tgrep: Trigram-Indexed Code Search for DeepSeek Harness

[![GitHub release](https://img.shields.io/github/v/release/huuthuan-nguyen/dsh-tgrep)](https://github.com/huuthuan-nguyen/dsh-tgrep/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2ea44f)](https://github.com/topics/dsh-plugin)
[![Powered by Microsoft tgrep](https://img.shields.io/badge/powered%20by-Microsoft%20tgrep-0078D4)](https://github.com/microsoft/tgrep)

<p align="center">
  <b>Trigram-indexed <code>grep</code> for DeepSeek Harness agents — fast code search on medium-to-large repositories.</b><br>
  Shadows the built-in <code>grep</code> tool with <b>Microsoft <code>tgrep</code></b> while keeping the native Web GUI search cards, Programmatic Tool Calling (PTC) mode, and the stock tool contract intact.
</p>

---

## 🌟 Why DSH-Tgrep?

The stock `grep` tool ships a bundled ripgrep binary and re-scans the workspace on every call.
On medium-to-large repositories the same files are read and the same pattern is matched again
and again, so search latency grows with the size of the tree and with how often the agent
searches. `dsh-tgrep` keeps the exact tool the model already knows and swaps the engine
underneath:

1. **Trigram index** — `tgrep` answers a query from its trigram index, so repeated searches
   over an indexed tree return without re-walking every file.
2. **Persistent daemon** — a running `tgrep serve` keeps the index hot across calls and
   sessions, with no per-call cold start.
3. **Graceful degradation** — with no index and no daemon, `tgrep` scans files much like
   `grep` does today, so a fresh workspace still works.
4. **Agent-plane shadowing** — the tool registers into each agent's own tool scope, so it
   replaces the built-in `grep` per agent without touching stock system presets or the host
   registry entry.
5. **Contract parity** — the stock `pattern` / `path` / `include` schema, the 30 s cooperative
   timeout, the `SearchMeta` payload behind the native search card, and the call/result
   presenters are all preserved; `case_insensitive` and `max_results` come on top.
6. **Safe parameter handling** — immune to CLI flag injection (`--regexp` and `--` boundaries).
7. **Zero runtime dependencies** — pure modern ESM JavaScript, no build step, and no import of
   any harness internal.

---

## 🚀 Key Highlights & Comparison

| Feature | Stock `grep` (`dsh-tool-fs-search`) | **`dsh-tgrep`** |
|---|---|---|
| **Search engine** | Bundled ripgrep binary | **Microsoft `tgrep` (trigram index)** |
| **Repeated queries** | Re-scans the tree on every call | ✅ **Index-served when indexed (scan fallback)** |
| **Persistent daemon** | ❌ None | ✅ **`tgrep serve`** |
| **Without an index** | ✅ Full scan | ✅ **Graceful fallback scan** |
| **Tool parameters** | `pattern`, `path`, `include` | ✅ Same **+ `case_insensitive`, `max_results`** |
| **Cooperative timeout** | ✅ 30 000 ms | ✅ **30 000 ms (parity)** |
| **Web GUI search card** | ✅ Native | ✅ **Native (`presentCall` / `presentResult` + `SearchMeta`)** |
| **Session-log metadata** | Capped at 64 KiB | ✅ **Capped at 64 KiB, 2000-byte line previews** |
| **Over-cap results** | Spills the full list to a workspace file | ⚠️ **Inline truncation note (no spill file)** |
| **PTC mode** | ✅ | ✅ |
| **Agent-plane shadowing** | Host registry entry | ✅ **Per-agent shadowing, presets untouched** |
| **Runtime dependency** | Bundled ripgrep | ⚠️ **`tgrep` binary on `PATH`** |
| **Build step** | Compiled with the harness | ✅ **None — plain ESM** |

---

## 🧩 Tool Contract

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

## 📋 Prerequisites

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

## 📦 Installation & Quickstart

You do **not** need to clone or compile this repository manually. DeepSeek Harness installs it directly into any profile:

### Method 1: Directly from GitHub (Recommended)

Install straight from GitHub, optionally pinned to a release tag:

```bash
# Latest from default branch
dsh plugin --profile web add github:huuthuan-nguyen/dsh-tgrep

# Or pinned to a specific release tag
dsh plugin --profile web add github:huuthuan-nguyen/dsh-tgrep#v0.1.3
```

### Method 2: From the NPM Registry

> ⚠️ **Stale on npm** — the registry's `latest` is still `0.1.0`, published before the
> `0.1.2`/`0.1.3` fixes. Prefer Method 1 until a newer version is published.

```bash
# For Web GUI profile
dsh plugin --profile web add dsh-tgrep

# Or for headless / TUI profile
dsh plugin --profile tui add dsh-tgrep
```

### Method 3: From Local Checkout (For development/contributors)

```bash
dsh plugin --profile web add ./dsh-tgrep
```

> **Note:** After installing, simply restart your DeepSeek Harness profile (e.g. `dsh web` or `dsh --profile web`).

---

## ⚙️ Configuration

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

## 🗂️ Indexing Your Codebase (Optional but Recommended)

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

## ✅ Verification

To verify that the plugin is active:
1. Start DeepSeek Harness: `dsh web`
2. In the chat, ask the model: `Search for "name" in package.json using grep.`
3. The model will invoke `grep` powered by `tgrep`, and the matches will render inside the native Search card.

---

## 🧹 Uninstallation

To remove `dsh-tgrep` from your profile:

```bash
dsh plugin --profile web remove dsh-tgrep
```

---

## 🧯 Compatibility & Troubleshooting

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

MIT © Thuan Nguyen
