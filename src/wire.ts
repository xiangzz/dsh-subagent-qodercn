/**
 * Minimal Agent Client Protocol (ACP) v1 client for one Qoder CLI CN `--acp`
 * process. The shared JSON-RPC transport owns framing and request
 * correlation; this module owns only the ACP methods, the run's single
 * session, unattended permission responses, and terminal stop-reason mapping.
 *
 * Wire shapes follow the ACP v1 schema (`session/new`, `session/prompt`,
 * `session/cancel`, `session/update`, `session/request_permission`); Qoder's
 * `_meta.qoder` extensions and every non-message update are consumed but
 * never surfaced.
 *
 * @module dsh-subagent-qodercn/wire
 */

import type { Readable, Writable } from 'node:stream'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { JsonRpcLineTransport, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import { AssistantOutputFold } from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentStopReason } from '@deepseek-ai/dsh-subagent'

type JsonObject = Record<string, unknown>

/** ACP v1, the only protocol version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1

/** Client identity sent with `initialize`. */
export const ACP_CLIENT_INFO = {
  name: 'deepseek-harness',
  title: 'DeepSeek Harness',
  version: '0.1.0',
} as const

/**
 * How to auto-answer the agent's `session/request_permission` prompts. `reject`
 * (default) cancels every prompt; `allow` selects the first `allow_once` or
 * `allow_always` option the agent offered. No prompt reaches a human.
 */
export type PermissionPolicy = 'allow' | 'reject'

export const PERMISSION_POLICIES = ['allow', 'reject'] as const satisfies readonly PermissionPolicy[]

/** Protocol stages this wire can fail in. */
export type QoderWireStage = 'initialize' | 'new-session' | 'prompt'

/** Coarse failure categories derived only from closed protocol facts. */
export type QoderWireCategory =
  | 'protocol'
  | 'transport'
  | 'remote-error'
  | 'remote-limit'
  | 'invalid-result'
  | 'unknown'

/** Structured failure facts owned by the wire after a non-completed outcome. */
export interface QoderWireFailureFacts {
  readonly stage: QoderWireStage
  readonly category: QoderWireCategory
  /** JSON-RPC error code the agent returned, when it returned one. */
  readonly remoteCode?: number | undefined
}

/** Agent facts published at `initialize`; safe to log, never model-visible. */
export interface QoderAgentInfo {
  readonly protocolVersion: number
  readonly name: string | undefined
  readonly version: string | undefined
}

/** The latest unattended permission fact observed for this run. */
export interface QoderPermissionDecision {
  readonly policy: PermissionPolicy
  /** The agent's tool kind, or `unknown` for anything outside the closed set. */
  readonly request: string
  readonly decision: 'allowed' | 'denied'
}

const ACP_TOOL_KINDS: ReadonlySet<string> = new Set([
  'read', 'edit', 'delete', 'move', 'search',
  'execute', 'think', 'fetch', 'switch_mode', 'other',
])

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WireProtocolError(`dsh-subagent-qodercn: agent returned invalid ${label}`)
  }
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WireProtocolError(`dsh-subagent-qodercn: agent returned invalid ${label}`)
  }
  return value
}

/** A frame that violates the ACP contract this client depends on. */
export class WireProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WireProtocolError'
  }
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`dsh-subagent-qodercn: ACP request aborted: ${String(signal.reason)}`)
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Keep only the closed ACP tool-kind vocabulary; other values become `unknown`. */
export function permissionRequestKind(kind: unknown): string {
  return typeof kind === 'string' && ACP_TOOL_KINDS.has(kind) ? kind : 'unknown'
}

/**
 * Map an ACP stop reason to the harness stop-reason vocabulary.
 * @param reason - the terminal `stopReason` from `session/prompt`.
 * @returns the harness equivalent; `max_turn_requests` and any unknown value
 *   map to `error`, so an unclean stop is never reported as `completed`.
 */
export function acpStopReason(reason: string): SubagentStopReason {
  switch (reason) {
    case 'end_turn':
      return 'completed'
    case 'max_tokens':
      return 'max-tokens'
    case 'refusal':
      return 'refusal'
    case 'cancelled':
      return 'aborted'
    default:
      // `max_turn_requests` (the agent hit its turn budget) and future
      // variants mean the task did NOT finish cleanly.
      return 'error'
  }
}

/** Fixed safe failure text derived only from provider-owned structured facts. */
export function wireFailureDiagnostic(facts: QoderWireFailureFacts): string {
  const fields = [
    'product: Qoder CLI CN',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.remoteCode !== undefined) fields.push(`agent error code: ${facts.remoteCode}`)
  return `Product subagent failure (${fields.join('; ')})`
}

/** Fixed permission fact; agent tool titles and option text never enter it. */
export function permissionDiagnostic(permission: QoderPermissionDecision): string {
  return `Qoder unattended decision (policy: ${permission.policy}; request: ${permission.request}; decision: ${permission.decision})`
}

/**
 * One ACP connection and its single session.
 *
 * The class deliberately exposes no generic request surface: supporting
 * another agent method must first become part of the provider contract.
 */
export class QoderAcpWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private readonly fold = new AssistantOutputFold()
  private readonly input: Readable
  private readonly permission: PermissionPolicy
  private sessionId: string | undefined
  private agentInfo: QoderAgentInfo | undefined
  private failure: QoderWireFailureFacts | undefined
  private diagnostic: string | undefined
  private inputEnded = false
  private terminalObserved = false
  private closed = false

  constructor(input: Readable, output: Writable, permission: PermissionPolicy) {
    this.input = input
    this.permission = permission
    this.transport = new JsonRpcLineTransport(input, output)
    // Fatal protocol state can arrive after the current guarded operation has
    // already settled. Keep the shared rejection observed without inserting
    // another promise-adoption hop into active races.
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleAgentRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.fail(thrown(error))
      }
    })
    // Pipe errors can race protocol closure and process teardown. Retain the
    // listeners for the lifetime of the per-run streams so no late EPIPE or
    // read failure becomes an unhandled EventEmitter error.
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    output.on('error', this.onOutputError)
  }

  /** Start reading agent frames. */
  start(): void {
    this.transport.start()
  }

  /**
   * Perform the ACP `initialize` handshake. Advertises no optional client
   * capability (no fs, no terminal): the agent self-serves in its own process.
   * @param signal - unpublished-start cancellation.
   * @returns the agent facts worth logging.
   */
  async initialize(signal: AbortSignal): Promise<QoderAgentInfo> {
    try {
      const response = object(await this.guarded(this.transport.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { ...ACP_CLIENT_INFO },
      }, signal), signal), 'initialize response')
      const protocolVersion = response.protocolVersion
      if (protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new WireProtocolError(`dsh-subagent-qodercn: agent speaks ACP version ${String(protocolVersion)}, expected ${ACP_PROTOCOL_VERSION}`)
      }
      const info = response.agentInfo === undefined || response.agentInfo === null
        ? {}
        : object(response.agentInfo, 'initialize agentInfo')
      this.agentInfo = {
        protocolVersion,
        name: typeof info.name === 'string' ? info.name : undefined,
        version: typeof info.version === 'string' ? info.version : undefined,
      }
      return this.agentInfo
    } catch (error: unknown) {
      this.classifyFailure(error, 'initialize')
      throw thrown(error)
    }
  }

  /**
   * Create the run's private session in `cwd` and retain its identity.
   * @param cwd - selected child working directory; also the agent's trust root.
   * @param signal - unpublished-start cancellation.
   * @returns the agent-issued session id.
   */
  async newSession(cwd: string, signal: AbortSignal): Promise<string> {
    try {
      const response = object(await this.guarded(this.transport.request('session/new', {
        cwd,
        mcpServers: [],
      }, signal), signal), 'session/new response')
      const sessionId = string(response.sessionId, 'session/new session id')
      this.sessionId = sessionId
      return sessionId
    } catch (error: unknown) {
      this.classifyFailure(error, 'new-session')
      throw thrown(error)
    }
  }

  /**
   * Submit the one text-only task and wait for the agent's authoritative
   * `session/prompt` response. Message chunks streamed meanwhile are folded.
   * @param texts - already validated task text blocks.
   * @param signal - local cancellation for the published run.
   * @returns the shared subagent result.
   */
  async prompt(texts: readonly string[], signal: AbortSignal): Promise<SubagentResult> {
    const sessionId = this.sessionId as string
    let response: JsonObject
    try {
      response = object(await this.guarded(this.transport.request('session/prompt', {
        sessionId,
        prompt: texts.map(text => ({ type: 'text', text })),
      }, signal), signal), 'session/prompt response')
      this.terminalObserved = true
    } catch (error: unknown) {
      this.classifyFailure(error, 'prompt')
      throw thrown(error)
    }
    let stopReason: string
    try {
      stopReason = string(response.stopReason, 'session/prompt stopReason')
    } catch (error: unknown) {
      this.classifyFailure(error, 'prompt')
      throw thrown(error)
    }
    const stop = acpStopReason(stopReason)
    if (stop !== 'completed') {
      this.recordFailure({
        stage: 'prompt',
        category: stopReason === 'max_turn_requests' ? 'remote-limit' : 'unknown',
      })
      if (stop !== 'error') {
        // max-tokens / refusal / aborted keep the partial answer; the
        // permission line, when any, explains why the agent stopped.
        const permission = this.collectDiagnostic()
        return { output: this.collectOutput(), ...permission === undefined ? {} : { diagnostic: permission }, stopReason: stop }
      }
      throw new Error(`dsh-subagent-qodercn: Qoder turn ended with stop reason ${stopReason}`)
    }
    const output = this.collectOutput()
    if (output.length === 0) {
      this.recordFailure({ stage: 'prompt', category: 'invalid-result' })
      throw new Error('dsh-subagent-qodercn: Qoder completed without an answer')
    }
    return { output, stopReason: 'completed' }
  }

  /**
   * Best-effort remote cancellation (`session/cancel` notification). Local
   * settlement and process teardown remain authoritative when the agent no
   * longer accepts protocol messages.
   */
  cancel(): void {
    if (this.sessionId === undefined || this.closed) return
    try {
      this.transport.notify('session/cancel', { sessionId: this.sessionId })
    } catch {
      // The agent is gone; the process teardown owns the outcome.
    }
  }

  /**
   * The assistant text streamed so far through `agent_message_chunk`.
   * @returns the folded text block, or `[]` when nothing streamed.
   */
  collectOutput(): readonly ContentBlock[] {
    return this.fold.collect() ?? []
  }

  /**
   * The latest safe unattended permission fact observed for this run.
   * @returns provider-authored diagnostic text, when one was observed.
   */
  collectDiagnostic(): string | undefined {
    return this.diagnostic
  }

  /**
   * Whether protocol output ended before the `session/prompt` response
   * arrived. A process that dies mid-prompt closes the stream before any
   * terminal frame, so the exit facts explain the failure better than the
   * transport close they caused.
   * @returns `true` only for an early protocol close without a terminal frame.
   */
  endedBeforeTerminal(): boolean {
    return this.inputEnded && !this.terminalObserved
  }

  /**
   * The structured failure recorded for this published turn. Call only after
   * a rejection from {@link initialize}, {@link newSession}, or {@link prompt},
   * or a non-`error` return from {@link prompt}.
   */
  collectFailure(): QoderWireFailureFacts {
    return this.failure ?? { stage: 'prompt', category: 'unknown' }
  }

  /** Detach JSON-RPC listeners and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return raceAbort(Promise.race([this.fatal.promise, pending]), signal)
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    this.inputEnded = true
    this.fail(new Error('dsh-subagent-qodercn: ACP protocol stream closed'))
  }

  private recordFailure(facts: QoderWireFailureFacts): void {
    this.failure = facts
  }

  /** Classify a rejected protocol operation from the error it rejected with. */
  private classifyFailure(error: unknown, stage: QoderWireStage): void {
    const category: QoderWireCategory = error instanceof WireProtocolError
      ? 'protocol'
      : error instanceof JsonRpcResponseError
        ? 'remote-error'
        : 'transport'
    const remoteCode = error instanceof JsonRpcResponseError ? error.code : undefined
    this.recordFailure(remoteCode === undefined ? { stage, category } : { stage, category, remoteCode })
  }

  private recordPermissionDecision(request: unknown, decision: 'allowed' | 'denied'): void {
    this.diagnostic = permissionDiagnostic({
      policy: this.permission,
      request: permissionRequestKind(request),
      decision,
    })
  }

  /**
   * Reject any agent request that names a session other than this run's. An
   * unanswered approval would leave the agent waiting, so a mismatched
   * request fails the run instead of being ignored.
   */
  private assertSession(params: JsonObject): void {
    if (this.sessionId === undefined || params.sessionId !== this.sessionId) {
      throw new WireProtocolError('dsh-subagent-qodercn: agent referenced another session')
    }
  }

  private handleAgentRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      switch (method) {
        case 'session/request_permission': {
          this.assertSession(params)
          const toolCall = params.toolCall === undefined || params.toolCall === null
            ? {}
            : object(params.toolCall, 'request_permission toolCall')
          if (this.permission === 'allow' && Array.isArray(params.options)) {
            const allow = params.options.find((option): option is JsonObject => {
              if (option === null || typeof option !== 'object' || Array.isArray(option)) return false
              const candidate = option as JsonObject
              return (candidate.kind === 'allow_once' || candidate.kind === 'allow_always')
                && typeof candidate.optionId === 'string'
            })
            if (allow !== undefined) {
              this.recordPermissionDecision(toolCall.kind, 'allowed')
              return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
            }
          }
          // Decline: answer `cancelled` so the agent does not proceed with
          // the denied tool call under either policy.
          this.recordPermissionDecision(toolCall.kind, 'denied')
          return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        }
        default:
          // An unanswered approval would leave the agent waiting or, worse,
          // proceeding unreviewed. Unknown agent requests fail the run.
          throw new WireProtocolError(`dsh-subagent-qodercn: unsupported agent request ${JSON.stringify(method)}`)
      }
    } catch (error: unknown) {
      const normalized = thrown(error)
      this.fail(normalized)
      return Promise.reject(normalized)
    }
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method !== 'session/update') return
    // Updates for another session (for example a nested sub-agent's) are not
    // this run's output: consume them without folding.
    if (this.sessionId === undefined || params.sessionId !== this.sessionId) return
    const update = object(params.update, 'session/update update')
    if (update.sessionUpdate !== 'agent_message_chunk') return
    const content = update.content
    if (content === null || typeof content !== 'object' || Array.isArray(content)) {
      throw new WireProtocolError('dsh-subagent-qodercn: agent returned an invalid message chunk')
    }
    const block = content as JsonObject
    if (block.type !== 'text' || typeof block.text !== 'string') return
    this.fold.pushText(block.text)
  }
}
