import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Config, apply, inject, name } from '../src/index.ts'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { FakeAgent, FakeChild, defaultHandler, update } from './helpers.ts'

const tempDirs: string[] = []
const originalPath = process.env.PATH

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qodercn-idx-'))
  tempDirs.push(dir)
  return dir
}

function fakeCtx(): { ctx: { logger: { info: (m: string) => void; warn: (m: string) => void }; subagents: { registerProvider: (p: SubagentProvider) => void }; subprocess: unknown }; registered: SubagentProvider[]; warned: string[]; info: string[] } {
  const registered: SubagentProvider[] = []
  const warned: string[] = []
  const info: string[] = []
  return {
    registered,
    warned,
    info,
    ctx: {
      logger: {
        info: (message: string) => { info.push(message) },
        warn: (message: string) => { warned.push(message) },
      },
      subagents: { registerProvider: (provider: SubagentProvider) => { registered.push(provider) } },
      subprocess: {},
    },
  }
}

afterEach(() => {
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('plugin metadata', () => {
  it('declares the loader name and the two seam services it injects', () => {
    assert.equal(name, 'subagent-qodercn')
    assert.deepEqual(inject, ['subagents', 'subprocess'])
  })
})

describe('Config', () => {
  it('fills every default', () => {
    assert.deepEqual(Config({}), {
      providerName: 'qodercn',
      extraArgs: [],
      permissionMode: 'auto',
      permission: 'reject',
      env: {},
      disposeEofGraceMs: 8_000,
      disposeGraceMs: 3_000,
    })
  })

  it('keeps optional fields absent when omitted and accepts every permission mode', () => {
    const resolved = Config({ model: 'auto', permissionMode: 'bypass_permissions', permission: 'allow' }) as Record<string, unknown>
    assert.equal('command' in resolved, false)
    assert.equal('reasoningEffort' in resolved, false)
    assert.equal(resolved.model, 'auto')
    assert.equal(resolved.permissionMode, 'bypass_permissions')
    assert.equal(resolved.permission, 'allow')
  })
})

describe('apply', () => {
  it('registers one provider with no start capabilities that inherits nothing', () => {
    const h = fakeCtx()
    apply(h.ctx as never, Config({}))
    assert.equal(h.registered.length, 1)
    const provider = h.registered[0]
    assert.ok(provider)
    assert.equal(provider.name, 'qodercn')
    assert.deepEqual(provider.capabilities, {
      agentOptions: false,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    })
    assert.equal(provider.inheritsParentContext, false)
    assert.equal(typeof provider.start, 'function')
  })

  it('honours a custom provider name', () => {
    const h = fakeCtx()
    apply(h.ctx as never, Config({ providerName: 'qoder' }))
    assert.equal(h.registered[0]?.name, 'qoder')
  })

  it('rejects graces that are not positive or exceed the Node timer ceiling', () => {
    const h = fakeCtx()
    assert.throws(() => apply(h.ctx as never, { ...Config({}), disposeGraceMs: 0 }), /disposeGraceMs must be a positive finite number/)
    assert.throws(() => apply(h.ctx as never, { ...Config({}), disposeEofGraceMs: -1 }), /disposeEofGraceMs must be a positive finite number/)
    assert.throws(
      () => apply(h.ctx as never, { ...Config({}), disposeGraceMs: MAX_TIMER_DELAY_MS + 1 }),
      /disposeGraceMs must be no greater than/,
    )
    assert.equal(h.registered.length, 0)
  })
})

describe('QoderProvider.start', () => {
  it('fails in the binary stage with the probed locations when nothing is installed', async () => {
    const h = fakeCtx()
    apply(h.ctx as never, Config({}))
    const emptyBin = tempDir()
    const emptyHome = tempDir()
    const originalHome = process.env.HOME
    process.env.PATH = emptyBin
    process.env.HOME = emptyHome
    try {
      await assert.rejects(
        h.registered[0]?.start({
          prompt: [{ type: 'text', text: 'x' }],
          parent: {},
          signal: new AbortController().signal,
          cwd: tempDir(),
        } as never),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.match(error.message, /stage: binary; category: binary\)\nQoder CLI CN executable not found\. Probed:/)
          return true
        },
      )
      assert.equal(h.warned.length, 1)
    } finally {
      process.env.HOME = originalHome
    }
  })

  it('fails with fixed startup facts when the child directory is unusable', async () => {
    const h = fakeCtx()
    apply(h.ctx as never, Config({ command: '/bin/ls' }))
    await assert.rejects(
      h.registered[0]?.start({
        prompt: [{ type: 'text', text: 'x' }],
        parent: {},
        signal: new AbortController().signal,
        cwd: join(tempDir(), 'missing'),
      } as never),
      /stage: initialize; category: unknown\)$/,
    )
  })

  it('spawns through ctx.subprocess and returns the published run', async () => {
    const h = fakeCtx()
    const agent = new FakeAgent()
    const child = new FakeChild()
    child.stdin.pipe(agent.fromClient)
    agent.toClient.pipe(child.stdout)
    agent.handler = (method, params) => {
      if (method !== 'session/prompt') return defaultHandler(method, params)
      agent.notify('session/update', update('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'from provider' },
      }))
      return { stopReason: 'end_turn' }
    }
    const spawnCalls: unknown[] = []
    const ctx = {
      ...h.ctx,
      subprocess: { spawn: (spec: unknown) => { spawnCalls.push(spec); return child } },
    }
    apply(ctx as never, Config({ command: '/bin/ls', model: 'auto' }))
    const cwd = tempDir()
    mkdirSync(cwd, { recursive: true })
    const run = await h.registered[0]?.start({
      prompt: [{ type: 'text', text: 'x' }],
      parent: {},
      signal: new AbortController().signal,
      cwd,
    } as never)
    assert.ok(run)
    try {
      const result = await run.result
      assert.deepEqual(result, { output: [{ type: 'text', text: 'from provider' }], stopReason: 'completed' })
      assert.equal(spawnCalls.length, 1)
      const spec = spawnCalls[0] as { argv: string[]; cwd: string }
      assert.deepEqual(spec.argv, ['/bin/ls', '--acp', '--permission-mode', 'auto', '--model', 'auto'])
      assert.equal(spec.cwd, cwd)
      assert.equal(h.info.length, 1)
      assert.match(h.info[0] ?? '', /qoder-cli-cn 1\.1\.90 \(ACP 1\) from \/bin\/ls/)
    } finally {
      await run.dispose()
    }
  })
})
