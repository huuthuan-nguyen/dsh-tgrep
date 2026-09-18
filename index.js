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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

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

/** `tgrep`'s own index directory name, relative to the served root. */
export const INDEX_DIR_NAME = '.tgrep'

/** Default budget for an auto-started daemon to bind, before the search proceeds anyway. */
export const DAEMON_READY_TIMEOUT_MS = 5000

/**
 * Default idle budget for a daemon this plugin started: stop it after 30 minutes without a
 * search, so a long harness session does not accumulate one server per project visited.
 * `tgrep serve` has no idle flag of its own, so the plugin owns this deadline. 0 disables it.
 */
export const DAEMON_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** How often the readiness probe re-reads the server record while waiting. */
const DAEMON_POLL_INTERVAL_MS = 250

/**
 * How long to keep polling after our spawn exits on its own. A losing spawn exits as soon as
 * `tgrep` sees the winner's lock, while the winner is still publishing its server record.
 */
const DAEMON_RACE_GRACE_MS = 1500

/**
 * `tgrep`'s environment with the common install locations prepended, so the binary is found
 * from a host process whose `PATH` lacks Homebrew or Cargo.
 */
export function tgrepEnv(base = process.env) {
  const env = { ...base }
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', `${base.HOME || ''}/.cargo/bin`]
  const currentPath = env.PATH || ''
  const currentList = currentPath.split(':')
  const missing = extraPaths.filter(p => p && !currentList.includes(p))
  if (missing.length > 0) {
    env.PATH = `${missing.join(':')}:${currentPath}`
  }
  return env
}

/**
 * Read `serve.json`, the record `tgrep serve` publishes in its index directory.
 * @returns the recorded pid/port, or `undefined` when absent or malformed.
 */
export function readServeRecord(indexDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(indexDir, 'serve.json'), 'utf8'))
    if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) return undefined
    return { pid: parsed.pid, port: Number.isInteger(parsed?.port) ? parsed.port : undefined }
  } catch {
    return undefined
  }
}

/**
 * Whether a pid is still running. `EPERM` means it exists but belongs to another user.
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Whether a live `tgrep serve` currently owns this index directory.
 *
 * The record outlives a killed daemon, so the pid must be probed: a stale
 * `serve.json` alone would suppress every restart attempt.
 */
export function daemonAlive(indexDir) {
  const record = readServeRecord(indexDir)
  return record !== undefined && isProcessAlive(record.pid)
}

/** In-flight auto-start attempts, keyed by root: concurrent calls must share one spawn. */
const daemonAttempts = new Map()

/**
 * Daemons THIS process spawned, keyed by root. Only these are ours to stop: a server the user
 * started by hand, or another harness's, must survive us.
 */
const ownedDaemons = new Map()

/**
 * argv for one `tgrep serve`, after the executable name.
 *
 * The daemon is spawned by the plugin, so a user has no other way to pass it flags: `extraArgs`
 * belongs to searches. `daemonArgs` covers the daemon's own knobs — `--exclude <dir>`,
 * `--no-watch`, `--watch-mode poll`, `--max-cpu`, `--max-memory`.
 *
 * @param root - workspace root to serve.
 * @param daemonArgs - extra arguments from the plugin config.
 * @returns argv after the executable name.
 */
export function buildServeArgs(root, daemonArgs = []) {
  return ['serve', root, ...(Array.isArray(daemonArgs) ? daemonArgs.map(String) : [])]
}

function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** The pid/port an auto-start reported, when a server record exists to read them from. */
function serveRecordFacts(indexDir) {
  const record = readServeRecord(indexDir)
  return record === undefined ? {} : { pid: record.pid, port: record.port }
}

/** Pids this process owns, for diagnostics and tests. */
export function ownedDaemonPids() {
  return [...ownedDaemons.values()]
}

/**
 * Stop every daemon this process spawned. Called from the plugin's disposal effect, which DSH
 * runs on shutdown: `runProfile` disposes the host fiber from its SIGINT/SIGTERM handler.
 *
 * A tracked pid is only signalled while the root's server record still names it, so a daemon
 * that exited on its own — and whose pid the OS may have recycled — is never mistaken for ours.
 * `tgrep` has no `stop` subcommand, so a signal is the only way to end one.
 *
 * @returns the pids that were signalled.
 */
export function stopOwnedDaemons() {
  const stopped = []
  for (const root of [...ownedDaemons.keys()]) {
    const pid = stopOwnedDaemon(root)
    if (pid !== undefined) stopped.push(pid)
  }
  return stopped
}

/**
 * Stop one owned daemon. The recorded pid is signalled only while the root's server record still
 * names it, so a daemon that exited on its own — and whose pid the OS may have recycled — is
 * never mistaken for ours.
 *
 * @param root - absolute workspace root.
 * @returns the pid that was signalled, or undefined when there was nothing safe to stop.
 */
export function stopOwnedDaemon(root) {
  const pid = ownedDaemons.get(root)
  if (pid === undefined) return undefined
  ownedDaemons.delete(root)
  if (readServeRecord(join(root, INDEX_DIR_NAME))?.pid !== pid) return undefined
  try {
    process.kill(pid, 'SIGTERM')
    return pid
  } catch {
    return undefined
  }
}

/**
 * Whether `tgrep` has published a complete index for this root. It writes `meta.json` as the
 * build finishes, so a missing or incomplete record means indexing is still running.
 */
export function indexIsComplete(root) {
  try {
    return JSON.parse(readFileSync(join(root, INDEX_DIR_NAME, 'meta.json'), 'utf8'))?.complete === true
  } catch {
    return false
  }
}

/** One pending idle timer per root, so activity can push the deadline back. */
const idleTimers = new Map()

/**
 * Arm (or re-arm) the idle deadline for a daemon this process owns.
 *
 * `tgrep serve` has no idle flag, so the budget lives here, in the harness process: every search
 * through the plugin counts as activity, exactly as client contact does in the dsh-knowcode
 * reference. The timer is unref'd so waiting on it never keeps the harness alive.
 *
 * @param root - absolute workspace root.
 * @param idleTimeoutMs - idle budget; 0 or less disables the deadline.
 * @param logger - optional sink for the stop notice.
 */
export function armIdleTimer(root, idleTimeoutMs, logger) {
  if (!(idleTimeoutMs > 0)) return
  if (!ownedDaemons.has(root)) return
  const existing = idleTimers.get(root)
  if (existing !== undefined) clearTimeout(existing)
  const timer = setTimeout(() => {
    idleTimers.delete(root)
    expireIdleDaemon(root, idleTimeoutMs, logger)
  }, idleTimeoutMs)
  timer.unref?.()
  idleTimers.set(root, timer)
}

/** Stop an owned daemon that has been idle for its full budget; re-arm while it is indexing. */
function expireIdleDaemon(root, idleTimeoutMs, logger) {
  if (!ownedDaemons.has(root)) return
  // Never stop mid-index: the run is real work, not idleness.
  if (!indexIsComplete(root)) {
    armIdleTimer(root, idleTimeoutMs, logger)
    return
  }
  const pid = stopOwnedDaemon(root)
  if (pid !== undefined) {
    logger?.debug?.(`[dsh-tgrep] stopped idle daemon for ${root} (pid ${pid}) after ${idleTimeoutMs}ms`)
  }
}

/**
 * Ensure a `tgrep serve` daemon is running for `workdir`, starting one if needed.
 *
 * `tgrep` answers a search from its index only when one exists for the SEARCH root, so without
 * this a user had to run `tgrep serve .` in every project by hand. The daemon is spawned
 * detached so it outlives the harness, with its output appended to `<root>/.tgrep/serve.log`;
 * that detach is also why the plugin stops the daemons it spawned on disposal.
 *
 * Best-effort by contract: a failure is reported, never thrown, because the search that follows
 * still works by scanning. `tgrep` itself refuses a second server for one index directory, so a
 * lost race ends with a healthy daemon either way — which the final probe confirms.
 *
 * @param workdir - workspace root to serve.
 * @param options - readiness budget overrides.
 * @returns whether a daemon for this root is running, and whether this call spawned it.
 */
export async function ensureDaemonStarted(workdir, options = {}) {
  const root = resolve(workdir)
  const indexDir = join(root, INDEX_DIR_NAME)

  if (daemonAlive(indexDir)) return { started: true, spawned: false, ...serveRecordFacts(indexDir) }

  const inFlight = daemonAttempts.get(root)
  if (inFlight !== undefined) return inFlight

  const attempt = spawnDaemon(root, indexDir, options)
  daemonAttempts.set(root, attempt)
  try {
    return await attempt
  } finally {
    daemonAttempts.delete(root)
  }
}

async function spawnDaemon(root, indexDir, options) {
  const readyTimeoutMs = Number.isFinite(options.readyTimeoutMs) && options.readyTimeoutMs > 0
    ? options.readyTimeoutMs
    : DAEMON_READY_TIMEOUT_MS

  let logFd = null
  try {
    mkdirSync(indexDir, { recursive: true })
    logFd = openSync(join(indexDir, 'serve.log'), 'a')
  } catch {
    logFd = null
  }

  try {
    const child = spawn('tgrep', buildServeArgs(root, options.daemonArgs), {
      cwd: root,
      detached: true,
      // The daemon outlives this process, so it cannot share our stdio.
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
      windowsHide: true,
      env: tgrepEnv(),
    })

    let spawnError = null
    // `tgrep` refuses a second server for one index directory, so a lost race ends with our
    // child exiting at once — the winner already holds the lock. Keep polling briefly after
    // that exit: the winner publishes `serve.json` during its own startup, so giving up the
    // instant our child dies would report failure for a project that is serving fine. The
    // grace only shortens the pathological case where nothing ever becomes ready.
    let exitedAt = null
    child.once('error', (error) => { spawnError = error })
    child.once('exit', () => { exitedAt = Date.now() })
    child.unref()

    const deadline = Date.now() + readyTimeoutMs
    while (Date.now() < deadline) {
      if (claimOwnership(root, indexDir, child.pid)) {
        return { started: true, spawned: true, ...serveRecordFacts(indexDir) }
      }
      if (spawnError !== null) break
      if (exitedAt !== null && Date.now() - exitedAt > DAEMON_RACE_GRACE_MS) break
      await delay(DAEMON_POLL_INTERVAL_MS)
    }

    // A server that appeared during the wait is what this call wanted, whoever spawned it.
    if (daemonAlive(indexDir)) return { started: true, spawned: false, ...serveRecordFacts(indexDir) }
    if (spawnError !== null) {
      return { started: false, spawned: false, reason: `failed to spawn tgrep serve: ${spawnError.message}` }
    }
    if (exitedAt !== null) {
      return {
        started: false,
        spawned: false,
        reason: `tgrep serve exited during startup — another server may already own ${indexDir} (see ${join(indexDir, 'serve.log')})`,
      }
    }
    return {
      started: false,
      spawned: false,
      reason: `tgrep serve did not become ready within ${readyTimeoutMs}ms (see ${join(indexDir, 'serve.log')})`,
    }
  } finally {
    if (logFd !== null) {
      try { closeSync(logFd) } catch { /* the child owns its own descriptor */ }
    }
  }
}

/**
 * Record `root` as ours when the live server record names the child this process just spawned.
 * A record naming any other pid belongs to a server someone else started, and is left alone.
 */
function claimOwnership(root, indexDir, childPid) {
  if (childPid === undefined) return false
  const record = readServeRecord(indexDir)
  if (record === undefined || record.pid !== childPid || !isProcessAlive(record.pid)) return false
  ownedDaemons.set(root, record.pid)
  return true
}

/**
 * `tgrep` skips files above 64 MiB by default, where `grep`/ripgrep search them. This plugin
 * therefore passes `--no-max-filesize` unless the config names a cap, so shadowing `grep`
 * cannot silently drop matches.
 */
export const DEFAULT_MAX_FILE_SIZE = null

/** One `--max-filesize` argument that came from user `extraArgs`, which own the decision. */
function isMaxFileSizeFlag(argument) {
  return /^--(?:no-)?max-filesize(?:=.*)?$/.test(argument)
}

/** Either spelling of `tgrep`'s index-directory override. */
function isIndexPathFlag(argument) {
  return argument === '--index-path' || argument.startsWith('--index-path=')
}

/**
 * Normalize the `maxFileSize` config into `null` (no cap) or a `tgrep` SIZE token.
 * Accepts a positive byte count or a size with a `K`/`M`/`G` suffix (e.g. `"64M"`).
 * @throws when a value is present but is not a usable size.
 */
export function normalizeMaxFileSize(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_FILE_SIZE
  const token = typeof raw === 'number'
    ? (Number.isInteger(raw) && raw > 0 ? String(raw) : undefined)
    : typeof raw === 'string' && /^[0-9]+(?:\.[0-9]+)?\s*[KMGkmg]?$/.test(raw.trim())
      ? raw.trim()
      : undefined
  // A zero cap would skip every file, which is never what a caller means.
  if (token === undefined || Number.parseFloat(token) <= 0) {
    throw new Error(
      'dsh-tgrep: maxFileSize must be a positive byte count or a size with a K/M/G suffix '
      + `(e.g. "64M"), got ${JSON.stringify(raw)}`,
    )
  }
  return token
}

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
          maxFileSize: normalizeMaxFileSize(val.maxFileSize),
          autoStartDaemon: val.autoStartDaemon !== false,
          daemonReadyTimeoutMs: clamp(Number(val.daemonReadyTimeoutMs) || DAEMON_READY_TIMEOUT_MS, 0, 60_000),
          daemonArgs: Array.isArray(val.daemonArgs) ? val.daemonArgs.map(String) : [],
          daemonIdleTimeoutMs: clamp(Number(val.daemonIdleTimeoutMs ?? DAEMON_IDLE_TIMEOUT_MS) || 0, 0, 86_400_000),
          stopDaemonOnExit: val.stopDaemonOnExit !== false,
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
    maxFileSize: normalizeMaxFileSize(config.maxFileSize),
    autoStartDaemon: config.autoStartDaemon !== false,
    daemonReadyTimeoutMs: clamp(Number(config.daemonReadyTimeoutMs) || DAEMON_READY_TIMEOUT_MS, 0, 60_000),
    daemonArgs: Array.isArray(config.daemonArgs) ? config.daemonArgs.map(String) : [],
    daemonIdleTimeoutMs: clamp(Number(config.daemonIdleTimeoutMs ?? DAEMON_IDLE_TIMEOUT_MS) || 0, 0, 86_400_000),
    stopDaemonOnExit: config.stopDaemonOnExit !== false,
  }

  if (!cfg.enabled) {
    ctx.logger?.info?.('[dsh-tgrep] disabled by config')
    return
  }

  const tool = createGrepTool(cfg, { logger: ctx.logger })
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

  // Clean up all registrations when the plugin is unloaded. DSH disposes the host fiber from
  // its SIGINT/SIGTERM handler, so this also runs when the harness is shut down — which is
  // where the daemons this plugin detached are stopped, since nothing else would.
  ctx.effect?.(() => () => {
    if (typeof stopCreated === 'function') {
      try { stopCreated() } catch { /* ignore */ }
    }
    if (typeof disposeHost === 'function') {
      try { disposeHost() } catch { /* ignore */ }
    }
    if (cfg.stopDaemonOnExit) {
      const stopped = stopOwnedDaemons()
      if (stopped.length > 0) {
        ctx.logger?.debug?.(`[dsh-tgrep] stopped ${stopped.length} workspace daemon(s)`)
      }
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
    maxFileSize: normalizeMaxFileSize(source.maxFileSize),
    autoStartDaemon: source.autoStartDaemon !== false,
    daemonReadyTimeoutMs: clamp(
      Number(source.daemonReadyTimeoutMs) || DAEMON_READY_TIMEOUT_MS, 0, 60_000,
    ),
    daemonArgs: Array.isArray(source.daemonArgs) ? source.daemonArgs.map(String) : [],
    stopDaemonOnExit: source.stopDaemonOnExit !== false,
    daemonIdleTimeoutMs: clamp(
      Number(source.daemonIdleTimeoutMs ?? DAEMON_IDLE_TIMEOUT_MS) || 0, 0, 86_400_000,
    ),
  }
}

/**
 * Build the exact `tgrep` argv for one call.
 *
 * The file-size policy is emitted here rather than by the caller: `tgrep` caps files at
 * 64 MiB by default while `grep`/ripgrep search them, so shadowing `grep` requires the
 * uncapped form unless the config names a cap. An explicit `--max-filesize` /
 * `--no-max-filesize` in `extraArgs` wins, because the user wrote it deliberately.
 *
 * @param options - validated call facts and plugin config.
 * @returns argv after the executable name.
 */
export function buildTgrepArgs(options) {
  const {
    pattern, searchPath, include, caseInsensitive, preferServer, extraArgs, maxFileSize, indexPath,
  } = options

  const cliArgs = ['--json']

  if (caseInsensitive) {
    cliArgs.push('-i')
  }

  if (include) {
    cliArgs.push('-g', String(include))
  }

  if (preferServer === false) {
    cliArgs.push('--no-index')
  }

  for (const argument of extraArgs) {
    cliArgs.push(argument)
  }

  // `tgrep` resolves its index relative to the SEARCH root, so a search limited to a
  // subdirectory would scan even while the workspace daemon is up. Pinning the workspace
  // index directory lets it answer from that server instead; pointed at a tree the index
  // does not cover, `tgrep` falls back to scanning rather than answering wrongly.
  if (indexPath && !extraArgs.some(isIndexPathFlag)) {
    cliArgs.push('--index-path', indexPath)
  }

  if (!extraArgs.some(isMaxFileSizeFlag)) {
    if (maxFileSize === null) cliArgs.push('--no-max-filesize')
    else cliArgs.push('--max-filesize', maxFileSize)
  }

  // Safeguard: pattern and path passed with explicit flags to prevent flag injection
  cliArgs.push(`--regexp=${pattern}`)
  cliArgs.push('--', searchPath)

  return cliArgs
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
 * The one-line notice a search carries when it started or failed to start a daemon.
 *
 * Mirrors the dsh-knowcode reference, which appends its auto-start note to the tool output:
 * starting a background server is a side effect the user did not ask for, so it is stated once,
 * on the call that caused it, rather than left to a log nobody reads.
 */
export function daemonAutoStartNote(daemon) {
  if (daemon === null || typeof daemon !== 'object' || Array.isArray(daemon)) return undefined
  if (daemon.started === false) {
    return `> ⚙️ tgrep daemon auto-start failed: ${daemon.reason ?? 'unknown reason'}. `
      + 'This search still ran by scanning.'
  }
  const where = typeof daemon.pid === 'number' ? ` (pid ${daemon.pid})` : ''
  return daemon.indexing === true
    ? `> ⚙️ tgrep daemon auto-started for this workspace${where} — its index is still building, so `
      + 'this search scanned the tree instead (complete results, just slower). Later searches are index-served.'
    : `> ⚙️ tgrep daemon auto-started for this workspace${where} — index ready, searches are index-served.`
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
export function createGrepTool(cfg, hooks = {}) {
  const {
    preferServer, maxLines, extraArgs, maxFileSize, autoStartDaemon, daemonReadyTimeoutMs, daemonArgs,
    daemonIdleTimeoutMs,
  } = normalizeToolConfig(cfg)
  const logger = hooks?.logger
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
          // Present only on the call that started (or failed to start) the workspace daemon.
          daemon: { type: 'object', additionalProperties: true },
        },
        required: ['matches'],
      },
      render: (args, value) => {
        const maxMatches = clamp(Number(args?.max_results) || maxLines, 20, 5000)
        const text = formatGrepMatches(value?.matches ?? [], maxMatches)
        const note = daemonAutoStartNote(value?.daemon)
        return [{ type: 'text', text: note === undefined ? text : `${text}\n\n${note}` }]
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

      // A daemon makes the workspace root's index reusable, which `tgrep` only does for a
      // search rooted at that same directory. Best-effort: a failure is logged, never thrown,
      // because the search below still answers by scanning.
      let indexPath
      let daemonFact
      const workspaceRoot = resolve(workdir)
      const workspaceIndex = join(workspaceRoot, INDEX_DIR_NAME)
      if (autoStartDaemon) {
        const daemon = await ensureDaemonStarted(workspaceRoot, {
          readyTimeoutMs: daemonReadyTimeoutMs,
          daemonArgs,
        })
        if (daemon.started) {
          // Any search counts as activity, so the idle deadline only fires when the workspace
          // really goes quiet. A daemon we did not spawn is not ours to time out.
          armIdleTimer(workspaceRoot, daemonIdleTimeoutMs, logger)
        }
        // Starting a background server is a side effect the user did not ask for: state it once,
        // on the call that caused it. Reused daemons stay silent.
        if (daemon.spawned || !daemon.started) {
          daemonFact = daemon.started
            ? { started: true, pid: daemon.pid, indexing: !indexIsComplete(workspaceRoot) }
            : { started: false, reason: daemon.reason }
        }
        if (!daemon.started && daemon.reason !== undefined) {
          logger?.warn?.(`[dsh-tgrep] ${daemon.reason}`)
        }
        if (existsSync(workspaceIndex)) indexPath = workspaceIndex
      }

      const cliArgs = buildTgrepArgs({
        pattern: args.pattern,
        searchPath,
        include: args.include ? String(args.include) : undefined,
        caseInsensitive: Boolean(args.case_insensitive),
        preferServer,
        extraArgs,
        maxFileSize,
        indexPath,
      })

      const matches = await runTgrep(cliArgs, {
        signal: exec?.signal,
        cwd: workdir,
        maxMatches,
      })

      return daemonFact === undefined ? { matches } : { matches, daemon: daemonFact }
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
    const env = tgrepEnv()

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
