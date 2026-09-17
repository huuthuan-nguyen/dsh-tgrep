/**
 * dsh-tgrep
 *
 * Shadows the built-in `grep` tool with Microsoft tgrep (trigram-indexed search).
 * Registers into each agent's scoped tool layer (agent plane) to shadow the
 * stock host dsh-tool-fs-search registration, while preserving the full
 * structured search experience in both PTC mode and Web GUI.
 *
 * Requires `tgrep` on PATH (brew install tgrep / cargo install tgrep / binary release).
 */

import { spawn } from 'node:child_process'
import { isAbsolute, relative } from 'node:path'

export const name = 'dsh-tgrep'

export const inject = ['tools']

/**
 * Cooperative tool-call deadline, enforced by the harness' timeout policy
 * through `exec.signal`. Mirrors `SEARCH_TIMEOUT_MS` in the tool this plugin
 * shadows (`@deepseek-ai/dsh-tool-fs-search`).
 */
export const TGREP_TIMEOUT_MS = 30_000

/** Byte budget for one serialized `presentationMeta` payload (mirrors `SEARCH_META_MAX_BYTES`). */
export const MAX_META_BYTES = 65_536

/** Per-line preview budget inside `presentationMeta` (mirrors `GREP_MAX_LINE_BYTES`). */
export const META_LINE_MAX_BYTES = 2000

/**
 * Standard Schema v1 validator for Cordis plugin configuration.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-tgrep',
    validate(value) {
      const val = value && typeof value === 'object' ? value : {}
      return {
        value: {
          enabled: val.enabled !== false,
          preferServer: val.preferServer !== false,
          maxLines: clamp(Number(val.maxLines) || 300, 20, 5000),
          extraArgs: Array.isArray(val.extraArgs) ? val.extraArgs.map(String) : [],
        },
      }
    },
  },
}

/**
 * Main plugin entrypoint.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = {
    enabled: config.enabled !== false,
    preferServer: config.preferServer !== false,
    maxLines: clamp(Number(config.maxLines) || 300, 20, 5000),
    extraArgs: Array.isArray(config.extraArgs) ? config.extraArgs.map(String) : [],
  }

  if (!cfg.enabled) {
    ctx.logger?.info?.('[dsh-tgrep] disabled by config')
    return
  }

  const tool = createGrepTool(cfg)
  const agentDisposers = new Map()

  function attachToAgent(agent) {
    if (!agent || agentDisposers.has(agent)) return
    const agentCtx = agent.ctx ?? agent
    const tools = agentCtx.tools ?? agentCtx.get?.('tools')
    if (!tools || typeof tools.register !== 'function') return

    try {
      const disposeTool = tools.register(tool)
      if (typeof disposeTool === 'function') {
        const cleanup = () => {
          try { disposeTool() } catch { /* ignore */ }
          agentDisposers.delete(agent)
        }
        agentDisposers.set(agent, cleanup)
        agentCtx.effect?.(() => cleanup)
      }
      agentCtx.logger?.debug?.('[dsh-tgrep] shadowed grep tool on agent plane')
    } catch (err) {
      agentCtx.logger?.warn?.('[dsh-tgrep] failed to register grep tool on agent', err)
    }
  }

  // 1. Primary path: register into every newly created agent's own tool scope
  const stopCreated = ctx.on?.('agent/created', (payload) => {
    // DeepSeek Harness passes { agent, source, signal } as the event payload
    const agent = payload?.agent ?? payload
    attachToAgent(agent)
  })

  // 2. Also attach to any agents that are already live (e.g. during HMR or dynamic plugin addition)
  try {
    const agents = ctx.get?.('agents') ?? ctx.agents
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) {
        attachToAgent(agent)
      }
    }
  } catch { /* ignore */ }

  // 3. Fallback: register on host tools service ONLY if grep is not already registered globally
  let disposeHost = null
  const hostTools = ctx.tools ?? ctx.get?.('tools')
  if (hostTools && typeof hostTools.register === 'function') {
    if (!hostTools.get?.('grep')) {
      try {
        disposeHost = hostTools.register(tool)
        ctx.logger?.debug?.('[dsh-tgrep] registered grep tool on host context')
      } catch (err) {
        ctx.logger?.warn?.('[dsh-tgrep] failed to register on host context', err)
      }
    }
  }

  // Clean up all registrations when the plugin is unloaded
  ctx.effect?.(() => () => {
    if (typeof stopCreated === 'function') {
      try { stopCreated() } catch { /* ignore */ }
    }
    if (typeof disposeHost === 'function') {
      try { disposeHost() } catch { /* ignore */ }
    }
    for (const cleanup of agentDisposers.values()) {
      try { cleanup() } catch { /* ignore */ }
    }
    agentDisposers.clear()
  })
}

/**
 * Normalize a partial plugin config into the exact tool-closure facts.
 * `createGrepTool` is callable directly (tests, embedding), so it never
 * assumes `apply` already filled every field in.
 */
function normalizeToolConfig(cfg) {
  const source = cfg && typeof cfg === 'object' ? cfg : {}
  return {
    preferServer: source.preferServer !== false,
    maxLines: clamp(Number(source.maxLines) || 300, 20, 5000),
    extraArgs: Array.isArray(source.extraArgs) ? source.extraArgs.map(String) : [],
  }
}

/**
 * Serialized UTF-8 byte size of one meta payload, as persisted and re-sent.
 */
function metaBytes(meta) {
  return Buffer.byteLength(JSON.stringify(meta), 'utf8')
}

/**
 * Bound one matched line to `maxBytes` on a code-point boundary, marking the
 * cut with an ellipsis. Keeps `presentationMeta` small for minified files
 * without ever emitting a lone surrogate half.
 */
export function previewLine(line, maxBytes = META_LINE_MAX_BYTES) {
  if (typeof line !== 'string') return ''
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return line
  const ellipsis = '…'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'))
  let out = ''
  let bytes = 0
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > budget) break
    out += char
    bytes += size
  }
  return `${out}${ellipsis}`
}

/**
 * Drop trailing file groups until the serialized meta fits `maxMetaBytes`,
 * flipping `truncated` when anything was dropped. `total` is preserved: it
 * counts what the search FOUND, not what the card retains. A single group too
 * large to fit alone is kept, so a bounded payload never becomes an empty card
 * that hides a real result.
 */
export function capSearchMeta(meta, maxMetaBytes = MAX_META_BYTES) {
  if (metaBytes(meta) <= maxMetaBytes) return meta
  const files = [...meta.files]
  while (files.length > 1 && metaBytes({ ...meta, files, truncated: true }) > maxMetaBytes) files.pop()
  return { ...meta, files, truncated: true }
}

/**
 * Narrow arbitrary replayed metadata into the search-card `files` payload.
 * `presentationMeta` round-trips through the session log, so this runs on
 * obsolete or hand-edited data and must reject rather than throw.
 */
function narrowSearchFiles(value) {
  if (!Array.isArray(value)) return undefined
  const files = []
  for (const file of value) {
    if (typeof file !== 'object' || file === null || Array.isArray(file)) return undefined
    const { path, matches } = file
    if (typeof path !== 'string' || !Array.isArray(matches)) return undefined
    const narrowed = []
    for (const match of matches) {
      if (typeof match !== 'object' || match === null || Array.isArray(match)) return undefined
      const { lineNumber, line } = match
      if (!Number.isInteger(lineNumber) || lineNumber < 1 || typeof line !== 'string') return undefined
      narrowed.push({ lineNumber, line })
    }
    files.push({ path, matches: narrowed })
  }
  return files
}

/**
 * Project the retained matches into the `SearchMeta` the search card consumes,
 * with per-line previews and a serialized-size cap.
 */
function grepSearchMeta(matches, maxMatches) {
  const retained = matches.slice(0, maxMatches).map(match => ({
    path: match.path,
    lineNumber: match.lineNumber,
    line: previewLine(match.line),
  }))
  return capSearchMeta({
    shape: 'matches',
    files: groupMatchesByFile(retained),
    truncated: matches.length > maxMatches,
    total: matches.length,
  })
}

/**
 * Construct the model-facing `grep` ToolDefinition.
 *
 * Returns a plain object conforming to the harness `ToolDefinition` contract.
 * It deliberately imports nothing from the harness: a plugin that loads
 * `@deepseek-ai/dsh-tools` itself can evaluate a second copy of that package,
 * and the private scheduler `Symbol()` then mismatches the host's.
 */
export function createGrepTool(cfg) {
  const { preferServer, maxLines, extraArgs } = normalizeToolConfig(cfg)
  return {
    name: 'grep',
    description:
      'Search file contents with Microsoft tgrep (trigram index). ' +
      'Returns matching lines with line numbers, grouped by file, capped at the configured limit. ' +
      'Use path to limit the search tree, or include to filter file names. ' +
      'Also accepts case_insensitive (case-insensitive match) and max_results (per-call cap).',
    timeoutMs: TGREP_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression or literal text to search for (ripgrep syntax).',
        },
        path: {
          type: 'string',
          description: 'Directory or file to search (default: session workspace root).',
        },
        include: {
          type: 'string',
          description: 'One glob filter for file names (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Case-insensitive search (passes -i to tgrep).',
        },
        max_results: {
          type: 'number',
          description: `Soft limit on returned matches (default ${maxLines}).`,
        },
      },
      required: ['pattern'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                path: { type: 'string' },
                lineNumber: { type: 'integer' },
                line: { type: 'string' },
              },
              required: ['path', 'lineNumber', 'line'],
            },
          },
        },
        required: ['matches'],
      },
      render: (args, value) => {
        const maxMatches = clamp(Number(args?.max_results) || maxLines, 20, 5000)
        return [{
          type: 'text',
          text: formatGrepMatches(value?.matches ?? [], maxMatches),
        }]
      },
      presentationMeta: (args, value) => {
        const matches = value?.matches ?? []
        const maxMatches = clamp(Number(args?.max_results) || maxLines, 20, 5000)
        return grepSearchMeta(matches, maxMatches)
      },
    },
    /** Pending-state card: a generic card titled like the tool it shadows. */
    presentCall: (args) => {
      const pattern = typeof args?.pattern === 'string' ? args.pattern : ''
      const where = typeof args?.path === 'string' && args.path !== '' ? ` in ${args.path}` : ''
      const filter = typeof args?.include === 'string' && args.include !== '' ? ` (${args.include})` : ''
      return { card: 'generic', title: `Grep ${pattern}${where}${filter}`, kind: 'search', rawInput: pattern }
    },
    /**
     * Completed-state card, reconstructed from the persisted metadata. Replay of
     * an obsolete or hand-edited log must degrade to the generic card, so every
     * shape check rejects instead of throwing.
     */
    presentResult: (_args, result) => {
      if (result?.isError) return undefined
      const meta = result?.meta
      if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
      if (meta.shape !== 'matches') return undefined
      if (typeof meta.truncated !== 'boolean') return undefined
      if (!Number.isInteger(meta.total) || meta.total < 0) return undefined
      const files = narrowSearchFiles(meta.files)
      if (files === undefined) return undefined
      return { card: 'search', shape: 'matches', files, truncated: meta.truncated, total: meta.total }
    },
    async execute(args, exec) {
      if (!args || typeof args !== 'object') {
        throw new Error('grep: arguments must be an object')
      }
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
        throw new Error('pattern must be a non-empty string')
      }
      if (args.path !== undefined && (typeof args.path !== 'string' || args.path.trim().length === 0)) {
        throw new Error('path must be a non-empty string when given')
      }
      if (args.include !== undefined) {
        validateInclude(args.include)
      }

      const maxMatches = clamp(Number(args.max_results) || maxLines, 20, 5000)
      const workdir = resolveCwd(exec)
      const searchPath = args.path ? String(args.path) : '.'

      const cliArgs = ['--json']

      if (args.case_insensitive) {
        cliArgs.push('-i')
      }

      if (args.include) {
        cliArgs.push('-g', String(args.include))
      }

      if (preferServer === false) {
        cliArgs.push('--no-index')
      }

      for (const a of extraArgs) {
        cliArgs.push(a)
      }

      // Safeguard: pattern and path passed with explicit flags to prevent flag injection
      cliArgs.push(`--regexp=${args.pattern}`)
      cliArgs.push('--', searchPath)

      const matches = await runTgrep(cliArgs, {
        signal: exec?.signal,
        cwd: workdir,
        maxMatches,
      })

      return { matches }
    },
  }
}

/**
 * Reject an `include` that is not a valid single positive glob filter.
 */
export function validateInclude(include) {
  if (typeof include !== 'string' || include.trim().length === 0) {
    throw new Error('include must be a non-empty string when given')
  }
  if (include.startsWith('!')) {
    throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported')
  }
  let braceDepth = 0
  for (const char of include) {
    if (char === '{') braceDepth++
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === ',' && braceDepth === 0) {
      throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)')
    }
  }
}

/**
 * Spawn tgrep and parse ripgrep-compatible JSON line output.
 */
function runTgrep(cliArgs, { signal, cwd, maxMatches }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const abortErr = new Error('tgrep cancelled')
      abortErr.name = 'AbortError'
      reject(abortErr)
      return
    }

    // Augment PATH so tgrep is discovered across macOS Homebrew, Cargo, and system bin
    const env = { ...process.env }
    const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME || ''}/.cargo/bin`]
    const currentPath = env.PATH || ''
    const currentList = currentPath.split(':')
    const missing = extraPaths.filter(p => p && !currentList.includes(p))
    if (missing.length > 0) {
      env.PATH = `${missing.join(':')}:${currentPath}`
    }

    const child = spawn('tgrep', cliArgs, {
      cwd: cwd || process.cwd(),
      env,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      // Early soft-cap at 20MB to protect memory on pathological match sets
      if (stdout.length > 20 * 1024 * 1024) {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
      }
    })

    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      if (err.name === 'AbortError') {
        const abortErr = new Error('tgrep cancelled')
        abortErr.name = 'AbortError'
        finish(reject, abortErr)
        return
      }
      finish(
        reject,
        new Error(
          `Failed to run tgrep: ${err.message}. ` +
          'Is Microsoft tgrep installed and on PATH? ' +
          '(macOS: brew install tgrep | Cargo: cargo install tgrep | GitHub: https://github.com/microsoft/tgrep/releases)',
        ),
      )
    })

    child.on('close', (code, signalName) => {
      if (signal?.aborted) {
        const abortErr = new Error('tgrep cancelled')
        abortErr.name = 'AbortError'
        finish(reject, abortErr)
        return
      }

      // Exit code >= 2 indicates an execution/syntax error
      if (code !== null && code >= 2) {
        // Strip benign tgrep informational warnings (such as unindexed workspace notes)
        const relevantStderr = stderr
          .split('\n')
          .filter(l => !l.startsWith('warning: no index') && !l.startsWith('note: if a server'))
          .join('\n')
          .trim()
        const msg = relevantStderr || stderr.trim() || `tgrep exited with code ${code}`
        finish(reject, new Error(msg))
        return
      }

      if (signalName && !stdout.trim()) {
        finish(reject, new Error(`tgrep killed by signal ${signalName}`))
        return
      }

      const matches = []
      const lines = stdout.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('{')) continue
        try {
          const record = JSON.parse(trimmed)
          if (record.type === 'match' && record.data) {
            const rawPath = record.data.path?.text ?? ''
            const lineNumber = Number(record.data.line_number) || 1
            const lineText = record.data.lines?.text ?? ''
            matches.push({
              path: toRelativePath(rawPath, cwd),
              lineNumber,
              line: lineText.replace(/\r?\n$/, ''),
            })
          }
        } catch {
          // Ignore malformed intermediate JSON chunks defensively
        }
      }

      finish(resolve, matches)
    })
  })
}

/**
 * Group flat matches by file (first-seen order) for model formatting and Web GUI cards.
 */
export function groupMatchesByFile(matches) {
  const byFile = new Map()
  for (const match of matches) {
    let group = byFile.get(match.path)
    if (!group) {
      group = []
      byFile.set(match.path, group)
    }
    group.push({ lineNumber: match.lineNumber, line: match.line })
  }
  return Array.from(byFile, ([path, fileMatches]) => ({ path, matches: fileMatches }))
}

/**
 * Format matching lines grouped by file with line numbers for model-facing prompt content.
 */
export function formatGrepMatches(matches, maxMatches) {
  if (!matches || matches.length === 0) {
    return '(no matches)'
  }

  const kept = matches.slice(0, maxMatches)
  const byFile = groupMatchesByFile(kept)
  const blocks = []

  for (const file of byFile) {
    const lines = [file.path]
    for (const m of file.matches) {
      lines.push(`  ${m.lineNumber}: ${m.line}`)
    }
    blocks.push(lines.join('\n'))
  }

  let result = blocks.join('\n\n')
  if (matches.length > maxMatches) {
    result += `\n\n... [dsh-tgrep] truncated, showing first ${maxMatches} of ${matches.length} matches`
  }
  return result
}

/**
 * Normalize paths to be workspace-relative with forward slashes.
 */
export function toRelativePath(filePath, workdir) {
  if (typeof filePath !== 'string') return ''
  let p = filePath
  if (p.startsWith('./') || p.startsWith('.\\')) {
    p = p.slice(2)
  }
  if (isAbsolute(p) && workdir) {
    const rel = relative(workdir, p)
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      p = rel
    }
  }
  return p.replace(/\\/g, '/')
}

/**
 * Resolve workspace working directory from execution context.
 */
function resolveCwd(exec) {
  try {
    const session = exec?.agent?.session ?? exec?.session
    const cwd =
      session?.header?.cwd ??
      session?.cwd ??
      exec?.cwd ??
      exec?.workspace?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  } catch { /* ignore */ }
  return process.cwd()
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}
