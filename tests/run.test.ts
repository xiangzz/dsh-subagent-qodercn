import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_PERMISSION_POLICY,
  DEFAULT_QODER_PERMISSION_MODE,
  qoderAcpArgv,
  qoderBinaryFailure,
  qoderStartupFailure,
  startQoderRun,
  textTask,
} from '../src/run.ts'
import type { QoderRunSpec } from '../src/run.ts'
import { FakeAgent, FakeChild, defaultHandler, tick, until, update } from './helpers.ts'

const BINARY = { path: '/opt/qoder/bin/qoderclicn', source: 'config' } as const

function request(prompt: readonly { type: 'text'; text: string }[], signal = new AbortController().signal): SubagentStartRequest {
  return {
    prompt,
    parent: {},
    signal,
    cwd: '/workspace',
    label: 'test',
  } as unknown as SubagentStartRequest
}

interface Harness {
  spec: QoderRunSpec
  agent: FakeAgent
  child: FakeChild
  spawns: SubprocessSpawnSpec[]
  agentInfo: unknown[]
  errors: string[]
}

function harness(overrides: Partial<QoderRunSpec> = {}): Harness {
  const agent = new FakeAgent()
  const child = new FakeChild()
  // Wire the fake process streams to the scripted agent: what the plugin
  // writes to child.stdin reaches the agent's reader, and what the agent
  // writes arrives on child.stdout for the plugin's wire.
  child.stdin.pipe(agent.fromClient)
  agent.toClient.pipe(child.stdout)
  const spawns: SubprocessSpawnSpec[] = []
  const agentInfo: unknown[] = []
  const errors: string[] = []
  const spec: QoderRunSpec = {
    binary: BINARY,
    cwd: '/workspace',
    extraArgs: [],
    permissionMode: DEFAULT_QODER_PERMISSION_MODE,
    permission: DEFAULT_PERMISSION_POLICY,
    env: {},
    disposeEofGraceMs: 200,
    disposeGraceMs: 200,
    spawn: (spawnSpec) => {
      spawns.push(spawnSpec)
      return child
    },
    onAgentInfo: (info) => { agentInfo.push(info) },
    onError: (error) => { errors.push(error.message) },
    ...overrides,
  }
  return { spec, agent, child, spawns, agentInfo, errors }
}

describe('qoderAcpArgv', () => {
  it('always passes --acp and an explicit permission mode', () => {
    assert.deepEqual(qoderAcpArgv({ binary: BINARY, extraArgs: [], permissionMode: 'auto' }), [
      BINARY.path, '--acp', '--permission-mode', 'auto',
    ])
  })

  it('adds model, effort, and then the extra args', () => {
    assert.deepEqual(qoderAcpArgv({
      binary: BINARY,
      extraArgs: ['--add-dir', '/x', '--setting-sources', 'user'],
      model: 'auto',
      reasoningEffort: 'high',
      permissionMode: 'accept_edits',
    }), [
      BINARY.path, '--acp', '--permission-mode', 'accept_edits',
      '--model', 'auto', '--reasoning-effort', 'high',
      '--add-dir', '/x', '--setting-sources', 'user',
    ])
  })
})

describe('textTask', () => {
  it('keeps the exact text blocks in order', () => {
    assert.deepEqual(textTask([{ type: 'text', text: 'a' }, { type: 'text', text: ' b ' }]), ['a', ' b '])
  })

  it('rejects empty, non-text, and blank tasks', () => {
    assert.throws(() => textTask([]), /only text blocks/)
    assert.throws(() => textTask([{ type: 'text', text: '' }]), /must not be empty/)
    assert.throws(() => textTask([{ type: 'text', text: ' \n ' }]), /must not be empty/)
    assert.throws(() => textTask([{ type: 'image', data: 'x' } as unknown as { type: 'text'; text: string }]), /only text blocks/)
  })
})

describe('failure helpers', () => {
  it('qoderStartupFailure exposes only fixed facts and keeps the cause', () => {
    const cause = new Error('EACCES /some/path')
    const failure = qoderStartupFailure(cause)
    assert.match(failure.message, /^dsh-subagent-qodercn: Product subagent failure \(product: Qoder CLI CN; stage: initialize; category: unknown\)$/)
    assert.equal(failure.cause, cause)
  })

  it('qoderBinaryFailure appends the probed locations to fixed facts', () => {
    const failure = qoderBinaryFailure(new Error('dsh-subagent-qodercn: Qoder CLI CN executable not found. Probed:\n  PATH (qoderclicn)'))
    assert.equal(
      failure.message,
      'dsh-subagent-qodercn: Product subagent failure (product: Qoder CLI CN; stage: binary; category: binary)\n'
      + 'Qoder CLI CN executable not found. Probed:\n  PATH (qoderclicn)',
    )
  })
})

describe('startQoderRun', () => {
  it('rejects before spawning when the request is already aborted', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(startQoderRun(request([{ type: 'text', text: 'x' }], controller.signal), h.spec), /aborted before ACP startup/)
    assert.equal(h.spawns.length, 0)
  })

  it('rejects before spawning when the task is not text-only', async () => {
    const h = harness()
    await assert.rejects(startQoderRun(request([{ type: 'image', data: 'x' } as unknown as { type: 'text'; text: string }]), h.spec), /only text blocks/)
    assert.equal(h.spawns.length, 0)
  })

  it('spawns the ACP server with the fixed argv and publishes after the session exists', async () => {
    const h = harness({ model: 'auto', env: { QODERCN_PERSONAL_ACCESS_TOKEN: 'tok' } })
    h.agent.handler = (method, params) => {
      if (method !== 'session/prompt') return defaultHandler(method, params)
      h.agent.notify('session/update', update('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'The answer' },
      }))
      return { stopReason: 'end_turn' }
    }
    const run = await startQoderRun(request([{ type: 'text', text: 'do it' }]), h.spec)
    try {
      assert.equal(h.spawns.length, 1)
      assert.deepEqual(h.spawns[0]?.argv, [
        BINARY.path, '--acp', '--permission-mode', 'auto', '--model', 'auto',
      ])
      assert.equal(h.spawns[0]?.cwd, '/workspace')
      assert.deepEqual(h.spawns[0]?.stdio, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      assert.equal(h.spawns[0]?.graceMs, 200)
      assert.deepEqual(h.spawns[0]?.env, { QODERCN_PERSONAL_ACCESS_TOKEN: 'tok' })
      assert.deepEqual(h.agentInfo, [{ protocolVersion: 1, name: 'qoder-cli-cn', version: '1.1.90' }])
      assert.deepEqual(
        h.agent.requests.map(r => r.method),
        ['initialize', 'session/new', 'session/prompt'],
      )
      const result = await run.result
      assert.deepEqual(result, { output: [{ type: 'text', text: 'The answer' }], stopReason: 'completed' })
    } finally {
      await run.dispose()
    }
    // Cooperative shutdown: stdin EOF made the agent exit; no escalation.
    assert.equal(h.child.terminateCalls, 0)
    assert.deepEqual(h.child.lastOutcome(), { exitCode: 0, signal: null })
  })

  it('reaps the child and rejects with the startup stage when initialize fails', async () => {
    const h = harness()
    h.agent.handler = () => undefined
    const pending = startQoderRun(request([{ type: 'text', text: 'x' }]), h.spec)
    await until(() => h.agent.requests.length > 0)
    h.agent.respondError(h.agent.requests[0]?.id ?? '', 500, 'not logged in')
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /stage: initialize; category: remote-error; agent error code: 500\)$/)
      return true
    })
    await until(() => h.child.exited)
    assert.equal(h.child.terminateCalls, 0)
    assert.equal(h.errors.length, 1)
    assert.equal(h.errors[0], 'not logged in')
  })

  it('classifies a child that dies before speaking as a process exit', async () => {
    const h = harness()
    h.agent.handler = () => undefined
    const pending = startQoderRun(request([{ type: 'text', text: 'x' }]), h.spec)
    await until(() => h.agent.requests.length > 0)
    h.child.exit({ exitCode: 127, signal: null })
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /stage: initialize; category: process; exit code: 127/)
      return true
    })
  })

  it('flattens a crash during the prompt into an error result with the exit facts', async () => {
    const h = harness()
    // Answer the handshake, hold the prompt.
    h.agent.handler = (method, params) => (method === 'session/prompt' ? undefined : defaultHandler(method, params))
    const run = await startQoderRun(request([{ type: 'text', text: 'x' }]), h.spec)
    await until(() => h.agent.requests.some(r => r.method === 'session/prompt'))
    h.agent.notify('session/update', update('sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'partial' },
    }))
    await tick()
    h.child.exit({ exitCode: 1, signal: null })
    const result = await run.result
    assert.equal(result.stopReason, 'error')
    assert.deepEqual(result.output, [{ type: 'text', text: 'partial' }])
    assert.match(result.diagnostic ?? '', /stage: process; category: process; exit code: 1/)
    assert.equal(h.errors.length, 1)
    await run.dispose()
  })

  it('settles as aborted and tells the agent to cancel when the request aborts', async () => {
    const h = harness()
    // Answer the handshake, hold the prompt.
    h.agent.handler = (method, params) => (method === 'session/prompt' ? undefined : defaultHandler(method, params))
    const controller = new AbortController()
    const run = await startQoderRun(request([{ type: 'text', text: 'x' }], controller.signal), h.spec)
    await until(() => h.agent.requests.some(r => r.method === 'session/prompt'))
    h.agent.notify('session/update', update('sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'so far' },
    }))
    await tick()
    controller.abort(new Error('user cancelled'))
    const result = await run.result
    assert.deepEqual(result, { output: [{ type: 'text', text: 'so far' }], stopReason: 'aborted' })
    await until(() => h.agent.notifications.some(n => n.method === 'session/cancel'))
    assert.equal(h.errors.length, 0)
    await run.dispose()
  })

  it('escalates to terminate() when the agent ignores stdin EOF', async () => {
    const h = harness({ disposeEofGraceMs: 30 })
    h.child.eofExits = false
    h.agent.handler = (method, params) => {
      if (method !== 'session/prompt') return defaultHandler(method, params)
      h.agent.notify('session/update', update('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ok' },
      }))
      return { stopReason: 'end_turn' }
    }
    const run = await startQoderRun(request([{ type: 'text', text: 'x' }]), h.spec)
    await run.result
    const started = Date.now()
    await run.dispose()
    assert.ok(Date.now() - started >= 25, 'waited the EOF grace before escalating')
    assert.equal(h.child.terminateCalls, 1)
    assert.deepEqual(h.child.lastOutcome(), { exitCode: null, signal: 'SIGTERM' })
  })

  it('dispose is idempotent', async () => {
    const h = harness()
    const run = await startQoderRun(request([{ type: 'text', text: 'x' }]), h.spec)
    await run.result
    const first = run.dispose()
    const second = run.dispose()
    assert.equal(first, second)
    await first
    assert.equal(h.child.terminateCalls, 0)
  })

  it('rejects a completed run that produced no answer', async () => {
    const h = harness()
    const run = await startQoderRun(request([{ type: 'text', text: 'x' }]), h.spec)
    const result = await run.result
    assert.equal(result.stopReason, 'error')
    assert.match(result.diagnostic ?? '', /stage: prompt; category: invalid-result/)
    await run.dispose()
  })
})
