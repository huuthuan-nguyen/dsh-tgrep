import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Config,
  DAEMON_READY_TIMEOUT_MS,
  INDEX_DIR_NAME,
  MAX_META_BYTES,
  TGREP_TIMEOUT_MS,
  apply,
  buildTgrepArgs,
  clamp,
  createGrepTool,
  daemonAlive,
  ensureDaemonStarted,
  formatGrepMatches,
  groupMatchesByFile,
  normalizeMaxFileSize,
  previewLine,
  readServeRecord,
  toRelativePath,
  validateInclude,
} from '../index.js'

/** Whether the `tgrep` binary is available, gating the live search tests. */
const tgrepAvailable = (() => {
  try {
    return spawnSync('tgrep', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
})()

describe('createGrepTool schema and definition', () => {
  it('creates valid ToolDefinition with standard JSON Schema parameters', () => {
    const tool = createGrepTool({ maxLines: 300 })
    assert.equal(tool.name, 'grep')
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.parameters.properties)
    assert.ok(tool.parameters.properties.pattern)
    assert.equal(tool.parameters.properties.pattern.type, 'string')
    assert.deepEqual(tool.parameters.required, ['pattern'])
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.output.presentationMeta, 'function')
    assert.equal(typeof tool.execute, 'function')
  })

  it('rejects execution when arguments is not an object or pattern is missing', async () => {
    const tool = createGrepTool({ maxLines: 300 })
    await assert.rejects(() => tool.execute(null, {}), /arguments must be an object/)
    await assert.rejects(() => tool.execute({}, {}), /pattern must be a non-empty string/)
    await assert.rejects(() => tool.execute({ pattern: '' }, {}), /pattern must be a non-empty string/)
  })

  it('tolerates a partial or missing config (no defineTool defaults applied upstream)', () => {
    for (const cfg of [undefined, {}, { maxLines: 500 }, { extraArgs: ['--stats'] }]) {
      assert.doesNotThrow(() => createGrepTool(cfg))
    }
    const bare = createGrepTool()
    assert.match(bare.parameters.properties.max_results.description, /default 300/)
    assert.deepEqual(bare.output.render({}, { matches: [] }), [{ type: 'text', text: '(no matches)' }])
  })

  it('declares standard JSON Schema only, never defineTool shorthand', () => {
    const tool = createGrepTool({ maxLines: 300 })
    for (const [label, schema] of [['parameters', tool.parameters], ['output.schema', tool.output.schema]]) {
      walk(schema, (node, path) => {
        if (node.required !== undefined) {
          assert.ok(
            Array.isArray(node.required) && node.required.every(name => typeof name === 'string'),
            `${label}${path}.required must be a string array`,
          )
          for (const name of node.required) {
            assert.ok(
              node.properties !== undefined && Object.hasOwn(node.properties, name),
              `${label}${path}.required names unknown property ${name}`,
            )
          }
        }
        if (node.properties !== undefined) {
          for (const [name, child] of Object.entries(node.properties)) {
            assert.equal(child.required, undefined, `${label}${path}.properties.${name} must not carry a boolean required`)
          }
        }
      })
    }
  })
})

describe('grep timeout, metadata cap and card presenters', () => {
  const tool = createGrepTool({ maxLines: 300 })

  it('declares the cooperative timeout the harness policy enforces', () => {
    assert.equal(TGREP_TIMEOUT_MS, 30_000)
    assert.equal(tool.timeoutMs, TGREP_TIMEOUT_MS)
  })

  it('bounds the serialized presentationMeta while reporting the found total', () => {
    const matches = Array.from({ length: 3000 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      lineNumber: index + 1,
      line: 'x'.repeat(4000),
    }))
    const meta = tool.output.presentationMeta({}, { matches })
    assert.equal(meta.shape, 'matches')
    assert.ok(Buffer.byteLength(JSON.stringify(meta), 'utf8') <= MAX_META_BYTES)
    assert.equal(meta.truncated, true)
    assert.equal(meta.total, 3000)
    assert.ok(meta.files.length >= 1, 'a bounded meta never becomes an empty card')
  })

  it('leaves a small result untouched and uncapped', () => {
    const matches = [{ path: 'a.ts', lineNumber: 1, line: 'short' }]
    const meta = tool.output.presentationMeta({}, { matches })
    assert.deepEqual(meta, {
      shape: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'short' }] }],
      truncated: false,
      total: 1,
    })
  })

  it('previews long lines on a code-point boundary', () => {
    const preview = previewLine(`head${'😀'.repeat(500)}`, 64)
    assert.ok(Buffer.byteLength(preview, 'utf8') <= 64)
    assert.ok(preview.startsWith('head'))
    assert.ok(preview.endsWith('…'))
    assert.equal(previewLine('short', 64), 'short')
    assert.equal(previewLine(undefined, 64), '')
  })

  it('titles the pending call like the tool it shadows', () => {
    assert.deepEqual(tool.presentCall({ pattern: 'foo', path: 'src', include: '*.ts' }), {
      card: 'generic',
      title: 'Grep foo in src (*.ts)',
      kind: 'search',
      rawInput: 'foo',
    })
    assert.equal(tool.presentCall({}).title, 'Grep ')
  })

  it('rebuilds the settled search card from persisted metadata', () => {
    const meta = {
      shape: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'x' }] }],
      truncated: false,
      total: 1,
    }
    assert.deepEqual(tool.presentResult({}, { meta }), { card: 'search', ...meta })
  })

  it('degrades to the generic card on absent, errored or malformed metadata', () => {
    const base = { shape: 'matches', files: [], truncated: false, total: 0 }
    assert.equal(tool.presentResult({}, { meta: base, isError: true }), undefined)
    assert.equal(tool.presentResult({}, {}), undefined)
    assert.equal(tool.presentResult({}, { meta: null }), undefined)
    assert.equal(tool.presentResult({}, { meta: [] }), undefined)
    assert.equal(tool.presentResult({}, { meta: { ...base, shape: 'paths' } }), undefined)
    assert.equal(tool.presentResult({}, { meta: { ...base, truncated: 'yes' } }), undefined)
    assert.equal(tool.presentResult({}, { meta: { ...base, total: -1 } }), undefined)
    assert.equal(tool.presentResult({}, { meta: { ...base, files: [{}] } }), undefined)
    assert.equal(tool.presentResult({}, { meta: { ...base, files: [{ path: 'a.ts', matches: [{ lineNumber: 0, line: 'x' }] }] } }), undefined)
  })
})

/** Visit every nested schema object reachable from `node`. */
function walk(node, visit, path = '') {
  if (node === null || typeof node !== 'object') return
  visit(node, path)
  if (node.properties) {
    for (const [name, child] of Object.entries(node.properties)) walk(child, visit, `${path}.properties.${name}`)
  }
  if (node.items) walk(node.items, visit, `${path}.items`)
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((child, index) => walk(child, visit, `${path}.oneOf[${index}]`))
}

describe('dsh-tgrep Config schema', () => {
  it('supplies defaults for empty config', () => {
    const res = Config['~standard'].validate({})
    assert.deepEqual(res.value, {
      enabled: true,
      preferServer: true,
      maxLines: 300,
      extraArgs: [],
      maxFileSize: null,
      autoStartDaemon: true,
      daemonReadyTimeoutMs: DAEMON_READY_TIMEOUT_MS,
    })
  })

  it('preserves valid custom config', () => {
    const res = Config['~standard'].validate({
      enabled: false,
      preferServer: false,
      maxLines: 500,
      extraArgs: ['--stats'],
      maxFileSize: '8M',
      autoStartDaemon: false,
      daemonReadyTimeoutMs: 2500,
    })
    assert.deepEqual(res.value, {
      enabled: false,
      preferServer: false,
      maxLines: 500,
      extraArgs: ['--stats'],
      maxFileSize: '8M',
      autoStartDaemon: false,
      daemonReadyTimeoutMs: 2500,
    })
  })

  it('clamps maxLines bounds between 20 and 5000', () => {
    const low = Config['~standard'].validate({ maxLines: 5 })
    assert.equal(low.value.maxLines, 20)

    const high = Config['~standard'].validate({ maxLines: 10000 })
    assert.equal(high.value.maxLines, 5000)
  })
})

describe('validateInclude', () => {
  it('accepts valid single glob', () => {
    assert.doesNotThrow(() => validateInclude('*.ts'))
    assert.doesNotThrow(() => validateInclude('src/**/*.js'))
    assert.doesNotThrow(() => validateInclude('*.{ts,tsx}'))
  })

  it('rejects empty or whitespace glob', () => {
    assert.throws(() => validateInclude(''), /non-empty string/)
    assert.throws(() => validateInclude('   '), /non-empty string/)
  })

  it('rejects negated globs', () => {
    assert.throws(() => validateInclude('!*.ts'), /positive glob filter/)
  })

  it('rejects comma-separated globs outside braces', () => {
    assert.throws(() => validateInclude('*.ts,*.js'), /comma-separated list/)
  })
})

describe('toRelativePath', () => {
  it('strips leading ./', () => {
    assert.equal(toRelativePath('./package.json', '/work'), 'package.json')
  })

  it('normalizes backslashes to forward slashes', () => {
    assert.equal(toRelativePath('.\\src\\index.js', '/work'), 'src/index.js')
  })

  it('relativizes absolute paths inside workdir', () => {
    assert.equal(toRelativePath('/work/src/index.js', '/work'), 'src/index.js')
  })
})

describe('groupMatchesByFile and formatGrepMatches', () => {
  const matches = [
    { path: 'src/a.ts', lineNumber: 10, line: 'const a = 1' },
    { path: 'src/a.ts', lineNumber: 20, line: 'const b = 2' },
    { path: 'src/b.ts', lineNumber: 5, line: 'export const c = 3' },
  ]

  it('groups matches by file in first-seen order', () => {
    const grouped = groupMatchesByFile(matches)
    assert.equal(grouped.length, 2)
    assert.equal(grouped[0].path, 'src/a.ts')
    assert.equal(grouped[0].matches.length, 2)
    assert.equal(grouped[1].path, 'src/b.ts')
    assert.equal(grouped[1].matches.length, 1)
  })

  it('formats model text with file headings and indented lines', () => {
    const formatted = formatGrepMatches(matches, 100)
    assert.match(formatted, /^src\/a\.ts\n  10: const a = 1\n  20: const b = 2\n\nsrc\/b\.ts\n  5: export const c = 3$/)
  })

  it('adds truncation note when matches exceed cap', () => {
    const formatted = formatGrepMatches(matches, 2)
    assert.match(formatted, /truncated, showing first 2 of 3 matches/)
  })

  it('returns (no matches) for empty list', () => {
    assert.equal(formatGrepMatches([], 100), '(no matches)')
  })
})

describe('apply lifecycle and agent shadowing', () => {
  function createMockContext() {
    const listeners = new Map()
    const effectDisposers = []

    const ctx = {
      tools: {
        registered: new Map(),
        get(name) {
          return this.registered.get(name)
        },
        register(tool) {
          if (this.registered.has(tool.name)) {
            throw new Error(`duplicate tool: ${tool.name}`)
          }
          this.registered.set(tool.name, tool)
          return () => {
            this.registered.delete(tool.name)
          }
        },
      },
      on(event, handler) {
        let list = listeners.get(event)
        if (!list) {
          list = []
          listeners.set(event, list)
        }
        list.push(handler)
        return () => {
          const idx = list.indexOf(handler)
          if (idx !== -1) list.splice(idx, 1)
        }
      },
      emit(event, payload) {
        const list = listeners.get(event) ?? []
        for (const fn of [...list]) {
          fn(payload)
        }
      },
      effect(fn) {
        const disposer = fn()
        if (typeof disposer === 'function') {
          effectDisposers.push(disposer)
        }
      },
      unload() {
        for (const d of effectDisposers.reverse()) {
          d()
        }
        effectDisposers.length = 0
      },
      agents: {
        list() { return [] },
      },
    }

    return ctx
  }

  function createMockAgent(id = 'agent-1') {
    const registered = new Map()
    const effects = []
    const agentCtx = {
      tools: {
        registered,
        register(tool) {
          registered.set(tool.name, tool)
          return () => {
            registered.delete(tool.name)
          }
        },
        get(name) {
          return registered.get(name)
        },
      },
      effect(fn) {
        const d = fn()
        if (typeof d === 'function') effects.push(d)
      },
      dispose() {
        for (const d of effects.reverse()) d()
      },
    }
    return { id, ctx: agentCtx }
  }

  it('registers tool on newly created agent when agent/created fires', () => {
    const ctx = createMockContext()
    apply(ctx, { enabled: true })

    const agent = createMockAgent('agent-test')
    // DSH emits { agent, source, signal }
    ctx.emit('agent/created', { agent, source: 'startup' })

    assert.ok(agent.ctx.tools.registered.has('grep'))
    const tool = agent.ctx.tools.registered.get('grep')
    assert.equal(tool.name, 'grep')
  })

  it('does not throw when host context already has grep', () => {
    const ctx = createMockContext()
    ctx.tools.registered.set('grep', { name: 'grep', builtIn: true })

    // apply should succeed without throwing duplicate tool error
    assert.doesNotThrow(() => apply(ctx, { enabled: true }))
    // host still has the built-in tool, not overwritten
    assert.equal(ctx.tools.get('grep').builtIn, true)
  })

  it('unregisters tool from agent plane when plugin unloads', () => {
    const ctx = createMockContext()
    apply(ctx, { enabled: true })

    const agent = createMockAgent('agent-leak-test')
    ctx.emit('agent/created', { agent, source: 'startup' })
    assert.ok(agent.ctx.tools.registered.has('grep'))

    // Unload the plugin
    ctx.unload()
    // The tool should be removed from the agent
    assert.equal(agent.ctx.tools.registered.has('grep'), false)
  })
})

describe('file-size policy (grep parity)', () => {
  it('uncaps file size by default so shadowing grep cannot drop matches', () => {
    const argv = buildTgrepArgs({ pattern: 'x', searchPath: '.', extraArgs: [], maxFileSize: null })
    assert.ok(argv.includes('--no-max-filesize'))
    assert.ok(!argv.includes('--max-filesize'))
  })

  it('applies a configured cap instead of uncapping', () => {
    const argv = buildTgrepArgs({ pattern: 'x', searchPath: '.', extraArgs: [], maxFileSize: '8M' })
    assert.equal(argv[argv.indexOf('--max-filesize') + 1], '8M')
    assert.ok(!argv.includes('--no-max-filesize'))
  })

  it('lets an explicit extraArgs size flag own the policy', () => {
    for (const extraArgs of [['--no-max-filesize'], ['--max-filesize', '1M'], ['--max-filesize=2M']]) {
      const argv = buildTgrepArgs({ pattern: 'x', searchPath: '.', extraArgs, maxFileSize: null })
      const injected = argv.filter(a => a === '--no-max-filesize' || a === '--max-filesize')
      assert.equal(injected.length, extraArgs.filter(a => a === '--no-max-filesize' || a === '--max-filesize').length)
    }
  })

  it('keeps the injection-guard flags last', () => {
    const argv = buildTgrepArgs({ pattern: 'a b', searchPath: 'src', extraArgs: [], maxFileSize: null })
    assert.deepEqual(argv.slice(-3), ['--regexp=a b', '--', 'src'])
  })

  it('normalizes the maxFileSize config', () => {
    assert.equal(normalizeMaxFileSize(undefined), null)
    assert.equal(normalizeMaxFileSize(null), null)
    assert.equal(normalizeMaxFileSize(''), null)
    assert.equal(normalizeMaxFileSize('64M'), '64M')
    assert.equal(normalizeMaxFileSize(' 8m '), '8m')
    assert.equal(normalizeMaxFileSize(1024), '1024')
    assert.deepEqual(Config['~standard'].validate({ maxFileSize: '16M' }).value.maxFileSize, '16M')
    assert.deepEqual(Config['~standard'].validate({}).value.maxFileSize, null)
  })

  it('rejects an unusable maxFileSize instead of guessing', () => {
    for (const bad of ['abc', '0', -1, 0, '1.2.3', true, {}]) {
      assert.throws(() => normalizeMaxFileSize(bad), /maxFileSize must be a positive byte count/)
    }
  })
})

describe('live tgrep coverage above the default size cap', () => {
  it('finds a match in a 65 MiB file, and misses it when capped', { skip: !tgrepAvailable && 'tgrep is not on PATH' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgrep-size-'))
    const big = join(dir, 'big.log')
    const marker = 'NEEDLE_ABOVE_THE_CAP'
    try {
      const line = 'filler line for the size policy test\n'
      const unit = Buffer.from(line.repeat(Math.ceil((1024 * 1024) / line.length)))
      const handle = await open(big, 'w')
      try {
        for (let written = 0; written < 65 * 1024 * 1024; written += unit.length) await handle.write(unit)
        await handle.write(`${marker}\n`)
      } finally {
        await handle.close()
      }

      // autoStartDaemon off: this test is about the size policy, and a daemon here would
      // build an index beside the 65 MiB fixture and outlive the test.
      const toolOptions = { maxLines: 300, autoStartDaemon: false }
      const uncapped = await createGrepTool(toolOptions)
        .execute({ pattern: marker, path: dir }, { cwd: dir })
      assert.equal(uncapped.matches.length, 1)

      const capped = await createGrepTool({ ...toolOptions, maxFileSize: '64M' })
        .execute({ pattern: marker, path: dir }, { cwd: dir })
      assert.equal(capped.matches.length, 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('workspace daemon auto-start', () => {
  it('pins the workspace index so subdirectory searches reuse the server', () => {
    const argv = buildTgrepArgs({
      pattern: 'x', searchPath: 'src', extraArgs: [], maxFileSize: null, indexPath: '/w/.tgrep',
    })
    assert.equal(argv[argv.indexOf('--index-path') + 1], '/w/.tgrep')
  })

  it('omits the index pin when there is none, and defers to extraArgs', () => {
    const bare = buildTgrepArgs({ pattern: 'x', searchPath: '.', extraArgs: [], maxFileSize: null })
    assert.ok(!bare.includes('--index-path'))

    const owned = buildTgrepArgs({
      pattern: 'x', searchPath: '.', extraArgs: ['--index-path', '/other'], maxFileSize: null, indexPath: '/w/.tgrep',
    })
    assert.equal(owned.filter(a => a === '--index-path').length, 1)
    assert.equal(owned[owned.indexOf('--index-path') + 1], '/other')
  })

  it('defaults autoStartDaemon on and keeps a bounded readiness budget', () => {
    const defaults = Config['~standard'].validate({}).value
    assert.equal(defaults.autoStartDaemon, true)
    assert.equal(defaults.daemonReadyTimeoutMs, DAEMON_READY_TIMEOUT_MS)

    const off = Config['~standard'].validate({ autoStartDaemon: false, daemonReadyTimeoutMs: 1234 }).value
    assert.equal(off.autoStartDaemon, false)
    assert.equal(off.daemonReadyTimeoutMs, 1234)
    assert.equal(Config['~standard'].validate({ daemonReadyTimeoutMs: 999_999 }).value.daemonReadyTimeoutMs, 60_000)
  })

  it('treats a stale server record as no daemon', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tgrep-record-'))
    try {
      assert.equal(daemonAlive(dir), false)
      assert.equal(readServeRecord(dir), undefined)

      await writeFile(join(dir, 'serve.json'), JSON.stringify({ pid: process.pid, port: 1 }))
      assert.equal(daemonAlive(dir), true, 'a live pid means a live daemon')

      await writeFile(join(dir, 'serve.json'), JSON.stringify({ pid: 999_999, port: 1 }))
      assert.equal(daemonAlive(dir), false, 'a dead pid must not suppress a restart')

      await writeFile(join(dir, 'serve.json'), 'not json')
      assert.equal(daemonAlive(dir), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('live daemon auto-start', () => {
  it('starts one daemon per workspace and reuses it', { skip: !tgrepAvailable && 'tgrep is not on PATH' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tgrep-daemon-'))
    let pid
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'a.ts'), 'alpha one\n')
      await writeFile(join(root, 'src', 'b.ts'), 'alpha two\n')

      assert.equal(daemonAlive(join(root, INDEX_DIR_NAME)), false)
      const first = await ensureDaemonStarted(root)
      assert.equal(first.started, true)
      assert.equal(first.spawned, true)

      const second = await ensureDaemonStarted(root)
      assert.equal(second.started, true)
      assert.equal(second.spawned, false, 'one daemon per workspace, not one per call')

      const result = await createGrepTool({ maxLines: 300 })
        .execute({ pattern: 'alpha', path: join(root, 'src') }, { cwd: root })
      assert.deepEqual(result.matches.map(m => m.line), ['alpha two'])
    } finally {
      pid = readServeRecord(join(root, INDEX_DIR_NAME))?.pid ?? pid
      if (pid !== undefined) {
        try { process.kill(pid) } catch { /* already gone */ }
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not start a daemon when the option is off', { skip: !tgrepAvailable && 'tgrep is not on PATH' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tgrep-nodaemon-'))
    try {
      await writeFile(join(root, 'a.ts'), 'alpha one\n')
      const tool = createGrepTool({ maxLines: 300, autoStartDaemon: false })
      const result = await tool.execute({ pattern: 'alpha', path: root }, { cwd: root })
      assert.equal(result.matches.length, 1)
      assert.equal(daemonAlive(join(root, INDEX_DIR_NAME)), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
