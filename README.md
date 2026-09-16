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
dsh plugin --profile web add github:huuthuan-nguyen/dsh-tgrep#v0.1.1
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

## License

MIT © 2025-present Thuan Nguyen
