import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  Config,
  apply,
  clamp,
  formatGrepMatches,
  groupMatchesByFile,
  toRelativePath,
  validateInclude,
} from '../index.js'

describe('dsh-tgrep Config schema', () => {
  it('supplies defaults for empty config', () => {
    const res = Config['~standard'].validate({})
    assert.deepEqual(res.value, {
      enabled: true,
      preferServer: true,
      maxLines: 300,
      extraArgs: [],
    })
  })

  it('preserves valid custom config', () => {
    const res = Config['~standard'].validate({
      enabled: false,
      preferServer: false,
      maxLines: 500,
      extraArgs: ['--stats'],
    })
    assert.deepEqual(res.value, {
      enabled: false,
      preferServer: false,
      maxLines: 500,
      extraArgs: ['--stats'],
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
