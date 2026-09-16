# dsh-tgrep

Shadow the built-in `grep` tool in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with [Microsoft tgrep](https://github.com/microsoft/tgrep) (trigram-indexed fast regex search).

Provides orders-of-magnitude faster code searches on medium-to-large repositories while retaining full compatibility with DeepSeek Harness's interactive Web GUI search cards and Programmatic Tool Calling (PTC) mode.

---

## Features

- **Trigram-indexed search**: Instant query latency across millions of lines of code using `tgrep`.
- **Full Web GUI integration**: Automatically generates structured search metadata so DeepSeek Harness renders native expandable file groups and match counters.
- **Graceful degradation**: Searches directly if no index is built yet; automatically utilizes `tgrep serve` background daemon if running.
- **PTC & agent-plane shadowing**: Scoped to each agent so it cleanly replaces built-in ripgrep without modifying stock system presets.
- **Safe parameter handling**: Immune to CLI flag injection (`--regexp` and `--` boundaries); supports regex, `include` glob filters, and case-insensitive flags.

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

### Into your DeepSeek Harness profile (e.g. `web` or `tui`)

From npm:
```bash
dsh plugin --profile web add dsh-tgrep
```

Or from a local checkout:
```bash
dsh plugin --profile web add ./dsh-tgrep
```

Restart your DeepSeek Harness profile (`dsh web` or `dsh --profile web`).

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

To verify that the plugin is loaded:
1. Open DeepSeek Harness Web GUI or CLI.
2. Ask the assistant: `Search for "name" in package.json using grep.`
3. The model will invoke `grep` powered by `tgrep`, and the response will be displayed in the native Search card.

---

## Uninstallation

To remove `dsh-tgrep`:

```bash
dsh plugin --profile web remove dsh-tgrep
```

---

## License

MIT © 2025-present
