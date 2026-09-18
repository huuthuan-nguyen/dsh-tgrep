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
   over an indexed tree return without re-walking every file (≈**15×** measured on a mid-size
   repo — see [⚡ Performance & Trade-offs](#-performance--trade-offs)).
2. **Automatic daemon** — the workspace's `tgrep serve` is started for you on first use
   (`autoStartDaemon`) and stays hot across calls — and across sessions too if you keep it warm
   with `stopDaemonOnExit: false`. No manual `tgrep serve .` per project, no per-call cold start,
   and by default no orphan left behind when the harness exits.
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
| **Speed on an indexed repo** | O(bytes) per call — re-reads the tree | ✅ **Index-served (~15× measured; see [⚡ Performance](#-performance--trade-offs))** |
| **Repeated queries** | Re-scans the tree on every call | ✅ **Index-served when indexed (scan fallback)** |
| **Persistent daemon** | ❌ None | ✅ **`tgrep serve`** |
| **Without an index** | ✅ Full scan | ✅ **Graceful fallback scan** |
| **Files above 64 MiB** | ✅ Searched (no size cap) | ✅ **Searched — uncapped by default (`maxFileSize` opts into a cap)** |
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

## ⚡ Performance & Trade-offs

`grep` and `ripgrep` scan every file on every search — **O(total bytes) per query**. `tgrep`
pre-builds a trigram index so a search only touches the files that could match, and a running
`tgrep serve` keeps that index hot. Microsoft publishes the full results in
[`BENCHMARKS.md`](https://github.com/microsoft/tgrep/blob/main/BENCHMARKS.md) — up to **52×
faster** than ripgrep on large repositories, winning 17 of the 18 measured cells (index
pre-built, average latency per query):

| Repo | Files | Platform | ripgrep | tgrep | Speedup |
|---|---:|---|---:|---:|---:|
| gecko-dev | 388 K | macOS arm64 | 33,402 ms | 643 ms | **51.9×** |
| linux | 96 K | macOS arm64 | 5,390 ms | 256 ms | **21.0×** |
| chromium | 504 K | macOS arm64 | 41,806 ms | 2,643 ms | **15.8×** |
| rust | 62 K | Windows | 1,489 ms | 194 ms | **7.7×** |
| kubernetes | 31 K | Windows | 1,342 ms | 190 ms | **7.1×** |

Measured locally on this machine (macOS arm64, `deepseek-harness/packages`, 5,672 text files,
160 MB, pattern `defineTool`, 226 matches, best of 3):

| Mode | Latency |
|---|---:|
| `tgrep` with an index | **15 ms** |
| `tgrep` with an index **+ `-g '*.ts'`** (what `include` sends) | **15 ms** |
| `tgrep --no-index` (the brute-force scan `grep`/ripgrep always performs) | **232 ms** |

So roughly **15× faster** on a mid-size repo, and building that index took **0.7 s**. Note that
passing a positive `-g` glob filter — which the tool's `include` parameter does — keeps the
index benefit rather than falling back to a scan.

### When the margin shrinks — or reverses

- **No index, no benefit.** Without a built index (or a running `tgrep serve`), `tgrep` scans
  like ripgrep, so the first search on a large tree is not faster. `autoStartDaemon` (on by
  default) removes the manual step: the daemon is spawned for the workspace root on the first
  search and later searches reuse it — see [Indexing & the Background
  Daemon](#-indexing--the-background-daemon).
- **Small repos and broad queries.** The margin depends on repo size and on how many matches a
  query returns: a search returning tens of thousands of matches spends more on *delivering*
  them than the index saves on *finding* them. On Kubernetes/Linux, Microsoft measured a
  near-tie (0.93×).
- **`preferServer: false`** in this plugin's config passes `--no-index`, deliberately choosing
  the brute-force scan (useful when the index may be stale).
- **Files above 64 MiB.** `tgrep` skips them by default, where ripgrep searches them — a
  deliberate divergence. Verified here: a 74 MiB file reported no match until
  `--no-max-filesize` was passed. Because silently dropping matches would break `grep`
  semantics, **this plugin passes `--no-max-filesize` by default**. On a workspace dominated by
  huge generated files that trade may cost scan time; opt back into a cap if you want it:

  ```yaml
  config:
    maxFileSize: "64M"   # or "8M", or a byte count
  ```

- **Bigger flags fall back to a scan.** Widening flags (`-E/--encoding`, `-a/--text`,
  `--binary`, the `--no-ignore*` family) bypass the index, so `extraArgs` using them gives up
  the speedup — and a single named file is always read directly.

Run `tgrep status .` to see whether a server/index is serving your tree, or `tgrep <pattern> .
--stats` for the query plan and timing.

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

⚠️ `tgrep` also **skips files larger than 64 MiB** by default, where ripgrep searches them. This
plugin passes `--no-max-filesize` so shadowing `grep` cannot silently drop matches; set
`maxFileSize` (e.g. `"64M"`) to opt into a cap instead — see
[⚡ Performance & Trade-offs](#-performance--trade-offs).

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
dsh plugin --profile web add github:huuthuan-nguyen/dsh-tgrep#v0.1.6
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
        # Files larger than this are skipped by tgrep. Omitted (the default)
        # means --no-max-filesize, matching grep/ripgrep coverage; set a size
        # such as "64M" or "8M" to cap instead.
        # maxFileSize: "64M"
        # Start a `tgrep serve` daemon for the session workspace when none is
        # running, so no manual `tgrep serve .` is needed per project.
        autoStartDaemon: true
        # How long a search waits for a freshly spawned daemon to bind before
        # proceeding anyway (it scans meanwhile, so the call never fails).
        daemonReadyTimeoutMs: 5000
        # Stop the daemon this plugin started when the harness exits, so it does
        # not linger as an orphan. Set false to keep it warm across sessions.
        stopDaemonOnExit: true
```

---

## 🗂️ Indexing & the Background Daemon

`tgrep` works out-of-the-box without an index by scanning files — it just isn't faster that
way. Indexing is what unlocks the [⚡ numbers above](#-performance--trade-offs).

**You normally do not have to do anything.** With `autoStartDaemon` on (the default), the first
`grep` in a workspace checks `<workspace>/.tgrep/serve.json` for a live `tgrep serve` and spawns
one, detached, when it finds none:

- The daemon serves the **session workspace root**, builds the index in the background, and
  keeps it fresh with a file watcher. Searches never wait for it: while it is still indexing
  they scan the tree exactly as before, so the first call is correct and later calls are fast.
- Its output goes to `<workspace>/.tgrep/serve.log`; the readiness record is
  `<workspace>/.tgrep/serve.json` (`{"pid":…,"port":…}`).
- One daemon per workspace: concurrent calls share a single attempt, and `tgrep` itself refuses
  a second server for the same index directory, so a lost race still ends with one live server.
- Searches pass `--index-path <workspace>/.tgrep`. `tgrep` resolves its index relative to the
  **search** root, so without this a search limited to `src/` would scan even with the workspace
  server up. Pointed at a tree the index does not cover, `tgrep` falls back to scanning rather
  than answering wrongly.
- A stale `serve.json` left by a killed daemon does not block a restart: the recorded pid is
  probed, not trusted.
- **The daemon is stopped when the harness exits.** It is spawned detached, so nothing else
  would end it: the plugin's disposal effect — which DSH runs on `SIGINT`/`SIGTERM` — sends
  `SIGTERM` to the daemons *it* started. A server you started yourself, or one belonging to
  another live harness, is never touched. The index stays on disk, so the next session's first
  search reuses it after a stale check rather than rebuilding.
- Prefer to keep it warm across sessions? `stopDaemonOnExit: false` leaves it running. Note the
  plugin then never stops it, not even on a later exit — it is no longer "its" daemon.

`tgrep` has no `stop` subcommand, so stopping a daemon means signalling its pid:

```bash
kill $(node -p "require('./.tgrep/serve.json').pid")
```

Two limits worth knowing: a harness killed with `SIGKILL` (or a crash) skips the disposal
effect and leaves an orphan, which the next session adopts and reuses rather than killing; and
daemons left behind by a version before `0.1.6` have no ownership record, so they must be
stopped once by hand.

Prefer to manage it yourself? Set `autoStartDaemon: false` — the plugin then touches no daemon
and no index path. Doing it by hand stays available:

```bash
cd /path/to/your/project
tgrep index .        # build the index once
tgrep serve          # or keep a server running (auto-builds and watches)
tgrep status .       # shows whether a server is running for this tree
```

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
