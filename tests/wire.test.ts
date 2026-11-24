import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import {
  QoderAcpWire,
  acpStopReason,
  permissionRequestKind,
} from '../src/wire.ts'
import { FakeAgent, defaultHandler, tick, update } from './helpers.ts'

function connect(policy: 'allow' | 'reject' = 'reject'): { agent: FakeAgent; wire: QoderAcpWire } {
  const agent = new FakeAgent()
  const wire = new QoderAcpWire(agent.toClient, agent.fromClient, policy)
  wire.start()
  return { agent, wire }
}

async function ready(policy: 'allow' | 'reject' = 'reject'): Promise<{ agent: FakeAgent; wire: QoderAcpWire }> {
  const pair = connect(policy)
  await pair.wire.initialize(new AbortController().signal)
  await pair.wire.newSession('/workspace', new AbortController().signal)
  return pair
}

describe('acpStopReason', () => {
  it('maps the closed ACP vocabulary onto the harness vocabulary', () => {
    assert.equal(acpStopReason('end_turn'), 'completed')
    assert.equal(acpStopReason('max_tokens'), 'max-tokens')
    assert.equal(acpStopReason('refusal'), 'refusal')
    assert.equal(acpStopReason('cancelled'), 'aborted')
    assert.equal(acpStopReason('max_turn_requests'), 'error')
    assert.equal(acpStopReason('something-new'), 'error')
  })
})

describe('permissionRequestKind', () => {
  it('keeps closed kinds and collapses others to unknown', () => {
    assert.equal(permissionRequestKind('execute'), 'execute')
    assert.equal(permissionRequestKind('edit'), 'edit')
    assert.equal(permissionRequestKind('delete_everything'), 'unknown')
    assert.equal(permissionRequestKind(undefined), 'unknown')
  })
})

describe('QoderAcpWire.initialize', () => {
  it('sends protocol version 1, no client capabilities, and the client identity', async () => {
    const { agent, wire } = connect()
    const info = await wire.initialize(new AbortController().signal)
    const request = agent.requests[0]
    assert.equal(request?.method, 'initialize')
    assert.deepEqual(request?.params, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.1.0' },
    })
    assert.deepEqual(info, { protocolVersion: 1, name: 'qoder-cli-cn', version: '1.1.90' })
  })

  it('classifies a version mismatch as a protocol failure', async () => {
    const agent = new FakeAgent()
    agent.handler = () => ({ protocolVersion: 2 })
    const wire = new QoderAcpWire(agent.toClient, agent.fromClient, 'reject')
    wire.start()
    await assert.rejects(wire.initialize(new AbortController().signal), /ACP version 2/)
    assert.deepEqual(wire.collectFailure(), { stage: 'initialize', category: 'protocol' })
  })

  it('classifies a JSON-RPC error as a remote failure and keeps the code', async () => {
    const agent = new FakeAgent()
    agent.handler = () => undefined
    const wire = new QoderAcpWire(agent.toClient, agent.fromClient, 'reject')
    wire.start()
    const pending = wire.initialize(new AbortController().signal)
    await tick()
    const request = agent.requests[0]
    assert.ok(request)
    agent.respondError(request.id, 500, 'boom', { detail: 1 })
    await assert.rejects(pending, (error: unknown) => error instanceof JsonRpcResponseError)
    assert.deepEqual(wire.collectFailure(), { stage: 'initialize', category: 'remote-error', remoteCode: 500 })
  })
})

describe('QoderAcpWire.newSession', () => {
  it('sends cwd and an empty MCP list, then keeps the session id', async () => {
    const { agent, wire } = connect()
    await wire.initialize(new AbortController().signal)
    assert.equal(await wire.newSession('/workspace', new AbortController().signal), 'sess-1')
    const request = agent.requests[1]
    assert.equal(request?.method, 'session/new')
    assert.deepEqual(request?.params, { cwd: '/workspace', mcpServers: [] })
  })

  it('rejects a response without a session id', async () => {
    const agent = new FakeAgent()
    agent.handler = (method) => (method === 'session/new' ? {} : defaultHandler(method, {}))
    const wire = new QoderAcpWire(agent.toClient, agent.fromClient, 'reject')
    wire.start()
    await wire.initialize(new AbortController().signal)
    await assert.rejects(wire.newSession('/workspace', new AbortController().signal), /invalid session\/new session id/)
    assert.deepEqual(wire.collectFailure(), { stage: 'new-session', category: 'protocol' })
  })
})

describe('QoderAcpWire.prompt', () => {
  it('sends text blocks and returns the streamed assistant text on end_turn', async () => {
    const { agent, wire } = await ready()
    agent.handler = (method, params) => {
      if (method !== 'session/prompt') return defaultHandler(method, params)
      agent.notify('session/update', update('sess-1', {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking…' },
      }))
      agent.notify('session/update', update('sess-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read file',
        kind: 'read',
        status: 'pending',
      }))
      agent.notify('session/update', update('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello ' },
      }))
      agent.notify('session/update', update('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: '...', mimeType: 'image/png' },
      }))
      agent.notify('session/update', update('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'world' },
      }))
      return { stopReason: 'end_turn' }
    }
    const result = await wire.prompt(['Hello', 'world'], new AbortController().signal)
    const request = agent.requests.find(r => r.method === 'session/prompt')
    assert.deepEqual(request?.params, {
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'world' }],
    })
    assert.deepEqual(result, {
      output: [{ type: 'text', text: 'Hello world' }],
      stopReason: 'completed',
    })
  })

  it('treats end_turn without any answer as an invalid result', async () => {
    const { wire } = await ready()
    await assert.rejects(wire.prompt(['task'], new AbortController().signal), /completed without an answer/)
    assert.deepEqual(wire.collectFailure(), { stage: 'prompt', category: 'invalid-result' })
  })

  it('keeps partial output for max_tokens, refusal, and cancelled', async () => {
    for (const [reason, expected] of [['max_tokens', 'max-tokens'], ['refusal', 'refusal'], ['cancelled', 'aborted']] as const) {
      const { agent, wire } = await ready()
      agent.handler = (method, params) => {
        if (method !== 'session/prompt') return defaultHandler(method, params)
        agent.notify('session/update', update('sess-1', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'partial' },
        }))
        return { stopReason: reason }
      }
      const result = await wire.prompt(['task'], new AbortController().signal)
      assert.equal(result.stopReason, expected)
      assert.deepEqual(result.output, [{ type: 'text', text: 'partial' }])
      assert.equal(result.diagnostic, undefined)
    }
  })

  it('rejects max_turn_requests as a remote limit', async () => {
    const { agent, wire } = await ready()
    agent.handler = (method, params) => (method === 'session/prompt' ? { stopReason: 'max_turn_requests' } : defaultHandler(method, params))
    await assert.rejects(wire.prompt(['task'], new AbortController().signal), /stop reason max_turn_requests/)
    assert.deepEqual(wire.collectFailure(), { stage: 'prompt', category: 'remote-limit' })
  })

  it('rejects an unknown stop reason as an unclean stop', async () => {
    const { agent, wire } = await ready()
    agent.handler = (method, params) => (method === 'session/prompt' ? { stopReason: 'paused' } : defaultHandler(method, params))
    await assert.rejects(wire.prompt(['task'], new AbortController().signal), /stop reason paused/)
    assert.deepEqual(wire.collectFailure(), { stage: 'prompt', category: 'unknown' })
  })

  it('rejects a response without a stop reason as a protocol failure', async () => {
    const { agent, wire } = await ready()
    agent.handler = (method, params) => (method === 'session/prompt' ? {} : defaultHandler(method, params))
    await assert.rejects(wire.prompt(['task'], new AbortController().signal), /invalid session\/prompt stopReason/)
    assert.deepEqual(wire.collectFailure(), { stage: 'prompt', category: 'protocol' })
  })

  it('rejects when the agent closes the stream before answering', async () => {
    const { agent, wire } = await ready()
    agent.handler = () => undefined
    const pending = wire.prompt(['task'], new AbortController().signal)
    await tick()
    agent.end()
    await assert.rejects(pending, /closed|aborted/)
    assert.equal(wire.collectFailure().category, 'transport')
  })

  it('rejects with the abort reason when the signal fires', async () => {
    const { agent, wire } = await ready()
    agent.handler = () => undefined
    const controller = new AbortController()
    const pending = wire.prompt(['task'], controller.signal)
    await tick()
    controller.abort(new Error('stop it'))
    await assert.rejects(pending, /stop it/)
  })

  it('ignores updates for another session', async () => {
    const { agent, wire } = await ready()
    agent.handler = (method, params) => {
      if (method !== 'session/prompt') return defaultHandler(method, params)
      agent.notify('session/update', update('other-session', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'not mine' },
      }))
      agent.notify('session/update', update('sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'mine' },
      }))
      return { stopReason: 'end_turn' }
    }
    const result = await wire.prompt(['task'], new AbortController().signal)
    assert.deepEqual(result.output, [{ type: 'text', text: 'mine' }])
  })
})

describe('QoderAcpWire session/request_permission', () => {
  it('cancels every prompt under the reject policy and records the decision', async () => {
    const { agent, wire } = await ready('reject')
    agent.handler = () => undefined
    const pending = wire.prompt(['task'], new AbortController().signal)
    await tick()
    agent.request('session/request_permission', {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't1', title: 'rm -rf build', kind: 'execute', status: 'pending' },
      options: [
        { optionId: 'a', name: 'Allow', kind: 'allow_once' },
        { optionId: 'r', name: 'Reject', kind: 'reject_once' },
      ],
    })
    await tick()
    const frames = agent.readClientFrames()
    assert.deepEqual(frames, [{
      jsonrpc: '2.0',
      id: 'srv_1',
      result: { outcome: { outcome: 'cancelled' } },
    }])
    assert.equal(
      wire.collectDiagnostic(),
      'Qoder unattended decision (policy: reject; request: execute; decision: denied)',
    )
    // The prompt itself is still pending: answer it so the test can finish.
    agent.respond(agent.requests.find(r => r.method === 'session/prompt')?.id ?? '', { stopReason: 'cancelled' })
    const result = await pending
    assert.equal(result.stopReason, 'aborted')
    assert.equal(result.diagnostic, 'Qoder unattended decision (policy: reject; request: execute; decision: denied)')
  })

  it('selects the first allow option under the allow policy', async () => {
    const { agent, wire } = await ready('allow')
    agent.handler = () => undefined
    const pending = wire.prompt(['task'], new AbortController().signal)
    await tick()
    agent.request('session/request_permission', {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't2', title: 'Write file', kind: 'edit', status: 'pending' },
      options: [
        { optionId: 'r', name: 'Reject', kind: 'reject_once' },
        { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'a2', name: 'Allow always', kind: 'allow_always' },
      ],
    })
    await tick()
    assert.deepEqual(agent.readClientFrames(), [{
      jsonrpc: '2.0',
      id: 'srv_1',
      result: { outcome: { outcome: 'selected', optionId: 'a1' } },
    }])
    assert.equal(
      wire.collectDiagnostic(),
      'Qoder unattended decision (policy: allow; request: edit; decision: allowed)',
    )
    agent.respond(agent.requests.find(r => r.method === 'session/prompt')?.id ?? '', { stopReason: 'end_turn' })
    agent.notify('session/update', update('sess-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }))
    await pending
  })

  it('cancels under the allow policy when no allow option is offered', async () => {
    const { agent, wire } = await ready('allow')
    agent.handler = () => undefined
    const pending = wire.prompt(['task'], new AbortController().signal)
    await tick()
    agent.request('session/request_permission', {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't3', title: 'Something', kind: 'mystery', status: 'pending' },
      options: [{ optionId: 'r', name: 'Reject', kind: 'reject_always' }],
    })
    await tick()
    assert.deepEqual(agent.readClientFrames()[0]?.result, { outcome: { outcome: 'cancelled' } })
    assert.equal(wire.collectDiagnostic(), 'Qoder unattended decision (policy: allow; request: unknown; decision: denied)')
    agent.respond(agent.requests.find(r => r.method === 'session/prompt')?.id ?? '', { stopReason: 'cancelled' })
    await pending
  })

  it('fails the run on an unknown agent request and answers with a JSON-RPC error', async () => {
    const { agent, wire } = await ready()
    agent.handler = () => undefined
    const pending = wire.prompt(['task'], new AbortController().signal)
    await tick()
    agent.request('fs/read_text_file', { sessionId: 'sess-1', path: '/etc/passwd' })
    await assert.rejects(pending, /unsupported agent request "fs\/read_text_file"/)
    await tick()
    const frames = agent.readClientFrames()
    assert.equal(frames.length, 1)
    assert.equal(frames[0]?.error && (frames[0].error as { code: number }).code, -32603)
    assert.deepEqual(wire.collectFailure(), { stage: 'prompt', category: 'protocol' })
  })

  it('fails the run on a permission request for another session', async () => {
    const { agent, wire } = await ready()
    agent.handler = () => undefined
    const pending = wire.prompt(['task'], new AbortController().signal)
    await tick()
    agent.request('session/request_permission', {
      sessionId: 'other-session',
      toolCall: { toolCallId: 't9', title: 'x', kind: 'execute', status: 'pending' },
      options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }],
    })
    await assert.rejects(pending, /referenced another session/)
    assert.equal(wire.collectDiagnostic(), undefined)
  })
})

describe('QoderAcpWire.cancel and close', () => {
  it('is a no-op before a session exists', () => {
    const { agent, wire } = connect()
    wire.cancel()
    assert.equal(agent.notifications.length, 0)
  })

  it('notifies session/cancel for the current session', async () => {
    const { agent, wire } = await ready()
    wire.cancel()
    await tick()
    assert.deepEqual(agent.notifications, [{ method: 'session/cancel', params: { sessionId: 'sess-1' } }])
  })

  it('close detaches listeners and later notifications are ignored', async () => {
    const { agent, wire } = await ready()
    wire.close()
    agent.notify('session/update', update('sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'late' },
    }))
    await tick()
    assert.deepEqual(wire.collectOutput(), [])
    assert.equal(agent.toClient.listenerCount('data'), 0)
  })
})
