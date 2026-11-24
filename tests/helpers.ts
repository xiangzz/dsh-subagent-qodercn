/**
 * Test doubles shared by the wire and run tests: a scripted ACP agent over
 * PassThrough streams and a fake subprocess handle with the seam's shape.
 * Both are plain erasable TypeScript so `node --experimental-strip-types`
 * can load them.
 *
 * @module dsh-subagent-qodercn/tests/helpers
 */

import { PassThrough } from 'node:stream'
import type { Duplex } from 'node:stream'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'

type JsonObject = Record<string, unknown>

export type AgentHandler = (method: string, params: JsonObject) => unknown | undefined

/**
 * A scripted ACP agent. `toClient` is what the wire reads; `fromClient` is
 * what the wire writes. Requests are answered by {@link handler}; notifications
 * are recorded in {@link notifications}.
 */
export class FakeAgent {
  readonly toClient = new PassThrough()
  readonly fromClient = new PassThrough()
  readonly notifications: Array<{ method: string; params: JsonObject }> = []
  readonly requests: Array<{ id: string; method: string; params: JsonObject }> = []
  /** Every frame the wire wrote back (responses to server requests). */
  readonly clientFrames: JsonObject[] = []
  handler: AgentHandler = defaultHandler
  private serverRequestSeq = 0
  private buffer = ''

  constructor() {
    // `fromClient` is in flowing mode here, so buffered reads never see
    // data; collect frames in the data listener instead.
    this.fromClient.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString()
      for (;;) {
        const nl = this.buffer.indexOf('\n')
        if (nl < 0) break
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        if (line.trim() === '') continue
        const frame = JSON.parse(line) as JsonObject
        this.clientFrames.push(frame)
        this.consume(frame)
      }
    })
  }

  private consume(frame: JsonObject): void {
    const method = frame.method
    if (typeof method !== 'string') return
    const params = (frame.params ?? {}) as JsonObject
    if (frame.id === undefined) {
      this.notifications.push({ method, params })
      return
    }
    const id = String(frame.id)
    this.requests.push({ id, method, params })
    const result = this.handler(method, params)
    if (result === undefined) return
    this.respond(id, result)
  }

  respond(id: string, result: unknown): void {
    this.toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  respondError(id: string, code: number, message: string, data?: unknown): void {
    const error: JsonObject = { code, message }
    if (data !== undefined) error.data = data
    this.toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`)
  }

  notify(method: string, params: JsonObject): void {
    this.toClient.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /** Send a server→client request and return its id. */
  request(method: string, params: JsonObject): string {
    this.serverRequestSeq += 1
    const id = `srv_${this.serverRequestSeq}`
    this.toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return id
  }

  /** Response frames (id, no method) the wire wrote back since the last call. */
  readClientFrames(): JsonObject[] {
    const responses = this.clientFrames.filter(frame => frame.method === undefined)
    for (const frame of responses) {
      const index = this.clientFrames.indexOf(frame)
      if (index >= 0) this.clientFrames.splice(index, 1)
    }
    return responses
  }

  /** Close the agent→client stream like a exiting process would. */
  end(): void {
    this.toClient.end()
  }
}

export const defaultHandler: AgentHandler = (method, params) => {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: 1,
        agentInfo: { name: 'qoder-cli-cn', title: 'Qoder CLI CN', version: '1.1.90' },
        authMethods: [{ id: 'qoderclicn-login', name: 'Use qoderclicn login' }],
      }
    case 'session/new':
      return { sessionId: 'sess-1', modes: null, configOptions: null }
    case 'session/prompt':
      return { stopReason: 'end_turn' }
    default:
      return undefined
  }
}

export function update(sessionId: string, update: JsonObject): JsonObject {
  return { sessionId, update }
}

/**
 * Fake subprocess handle. The agent reads `stdin` and writes `stdout`. When
 * the plugin ends `stdin` the fake "process" exits cooperatively (exit 0) on
 * the next tick, like an ACP agent asked to shut down. `exit()` forces an
 * outcome; `terminate()` records the escalation and exits with SIGTERM.
 */
export class FakeChild implements SubprocessHandle {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly control: Duplex | undefined = undefined
  readonly collected: SubprocessCollectedOutputs = {}
  exited = false
  terminateCalls = 0
  eofExits = true
  private readonly settled = Promise.withResolvers<SubprocessOutcome>()
  private waiters: Array<() => void> = []
  private outcome: SubprocessOutcome | undefined

  constructor() {
    // Cooperatively exit on stdin EOF unless a test opts out.
    this.stdin.on('end', () => {
      if (!this.eofExits || this.exited) return
      setImmediate(() => { this.exit({ exitCode: 0, signal: null }) })
    })
  }

  get done(): Promise<SubprocessOutcome> {
    return this.settled.promise
  }

  terminate(): void {
    this.terminateCalls += 1
    if (!this.exited) this.exit({ exitCode: null, signal: 'SIGTERM' })
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.exited) return true
    const aborted = new Promise<false>((resolve) => {
      if (signal === undefined) return
      if (signal.aborted) {
        resolve(false)
        return
      }
      signal.addEventListener('abort', () => { resolve(false) }, { once: true })
    })
    const gone = new Promise<true>((resolve) => { this.waiters.push(() => { resolve(true) }) })
    return Promise.race([gone, aborted])
  }

  exit(outcome: SubprocessOutcome): void {
    if (this.exited) return
    this.exited = true
    this.outcome = outcome
    this.stdin.end()
    this.stdout.end()
    this.stderr.end()
    for (const waiter of this.waiters.splice(0)) waiter()
    this.settled.resolve(outcome)
  }

  lastOutcome(): SubprocessOutcome | undefined {
    return this.outcome
  }
}

/** Wait for one macrotask turn so queued stream events settle. */
export function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

/** Wait until `predicate` holds, polling per macrotask, failing after `ms`. */
export async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await tick()
  }
}
