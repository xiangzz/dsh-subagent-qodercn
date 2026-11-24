/**
 * One-shot Qoder child lifecycle: resolve the real `qoderclicn`, spawn it as
 * an ACP server through the subprocess seam, publish only after
 * initialization and session creation, flatten post-publication failures,
 * and dispose to whole-range quiescence.
 *
 * @module dsh-subagent-qodercn/run
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { QoderBinary } from './binary.ts'
import {
  QoderAcpWire,
  type PermissionPolicy,
  type QoderAgentInfo,
  type QoderWireFailureFacts,
} from './wire.ts'

/**
 * EOF grace for the agent's final flush and nested-process teardown; wider
 * than the signal grace below. Measured on Qoder CLI CN 1.1.95: the ACP server
 * exits on stdin EOF after roughly 6.4 s, so 8 s observes a cooperative exit
 * without an unnecessary signal.
 */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 8_000

/** Default grace between managed-range termination tiers on dispose. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Qoder's native non-interactive permission modes (`--permission-mode`). */
export type QoderPermissionMode =
  | 'default'
  | 'accept_edits'
  | 'auto'
  | 'bypass_permissions'
  | 'dont_ask'

export const QODER_PERMISSION_MODES = [
  'default',
  'accept_edits',
  'auto',
  'bypass_permissions',
  'dont_ask',
] as const satisfies readonly QoderPermissionMode[]

/**
 * Safe default for unattended runs: Qoder auto-approves safe reads and
 * in-workspace edits, rejects or classifies risky actions, and forwards any
 * remaining `ask` to this provider's {@link PermissionPolicy}.
 */
export const DEFAULT_QODER_PERMISSION_MODE: QoderPermissionMode = 'auto'

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = 'reject'

type QoderFailureStage = 'binary' | 'process' | QoderWireFailureFacts['stage'] | 'teardown'

type QoderFailureCategory =
  | QoderWireFailureFacts['category']
  | 'binary'
  | 'process'
  | 'process-start'
  | 'unknown'

/** Structured failure facts; every field is a closed vocabulary or a process/protocol fact. */
interface QoderFailureFacts {
  readonly stage: QoderFailureStage
  readonly category: QoderFailureCategory
  /** JSON-RPC error code the agent returned, when it returned one. */
  readonly remoteCode?: number | undefined
  /** Managed-range exit facts, when the process ended before or during failure. */
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: QoderFailureFacts): string {
  const fields = [
    'product: Qoder CLI CN',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.remoteCode !== undefined) fields.push(`agent error code: ${facts.remoteCode}`)
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ] as const
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class QoderRunFailure extends Error {
  readonly facts: QoderFailureFacts

  constructor(facts: QoderFailureFacts, cause?: unknown, detail?: string) {
    super(
      `dsh-subagent-qodercn: ${failureDiagnostic(facts)}${detail === undefined ? '' : `\n${detail}`}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'QoderRunFailure'
    this.facts = facts
  }
}

/**
 * Hide an unpublished Host failure (an unusable child directory) behind fixed
 * safe startup facts.
 * @param cause - original Host failure retained for internal diagnostics.
 * @returns a startup failure whose message contains only fixed safe facts.
 */
export function qoderStartupFailure(cause: unknown): Error {
  return new QoderRunFailure({ stage: 'initialize', category: 'unknown' }, cause)
}

/**
 * Report a missing Qoder CLI CN executable. The resolver's probed-location
 * list (standard paths and the install docs URL, nothing credential-shaped)
 * is the one operator-actionable fact this provider puts in its message.
 * @param cause - the resolver's error naming every probed location.
 * @returns a `binary`-stage failure that keeps the resolver's message.
 */
export function qoderBinaryFailure(cause: unknown): Error {
  return new QoderRunFailure(
    { stage: 'binary', category: 'binary' },
    cause,
    thrown(cause).message.replace(/^dsh-subagent-qodercn: /, ''),
  )
}

/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/** Fully resolved inputs for one Qoder ACP run. */
export interface QoderRunSpec {
  /** The resolved `qoderclicn` executable. */
  readonly binary: QoderBinary
  /** Selected child working directory; also the process cwd and the ACP session `cwd`. */
  readonly cwd: string
  /** Extra `qoderclicn` arguments appended after the provider's own flags. */
  readonly extraArgs: readonly string[]
  /** Profile-selected native model; omitted to preserve Qoder settings. */
  readonly model?: string
  /** Profile-selected native reasoning effort; omitted to preserve Qoder settings. */
  readonly reasoningEffort?: string
  /** Profile-selected native permission mode fixed for every run. */
  readonly permissionMode: QoderPermissionMode
  /** How to auto-answer the agent's ACP permission requests. */
  readonly permission: PermissionPolicy
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Window after stdin EOF for the agent's cooperative shutdown before termination. */
  readonly disposeEofGraceMs: number
  /** Subprocess termination grace passed to the shared managed-range owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Observes the agent facts published at `initialize` (Host logging only). */
  readonly onAgentInfo?: (info: QoderAgentInfo) => void
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/**
 * The fixed ACP server command line for one run. The permission mode is always
 * passed explicitly so the run does not depend on the user's
 * `general.defaultPermissionMode` setting.
 * @param spec - resolved run inputs.
 * @returns `argv[0]` plus the `--acp` server flags.
 */
export function qoderAcpArgv(spec: Pick<QoderRunSpec, 'binary' | 'extraArgs' | 'model' | 'reasoningEffort' | 'permissionMode'>): string[] {
  const argv = [spec.binary.path, '--acp', '--permission-mode', spec.permissionMode]
  if (spec.model !== undefined) argv.push('--model', spec.model)
  if (spec.reasoningEffort !== undefined) argv.push('--reasoning-effort', spec.reasoningEffort)
  argv.push(...spec.extraArgs)
  return argv
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('dsh-subagent-qodercn: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('dsh-subagent-qodercn: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('dsh-subagent-qodercn: the one-shot task must not be empty')
  }
  return texts
}

/** Bounded managed-range exit wait: observes the handle's range until it is empty or `ms` elapses. */
async function rangeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  return child.waitForExit(AbortSignal.timeout(Math.ceil(ms)))
}

/**
 * Close the private wire, hand the agent stdin EOF (its window to flush
 * session persistence and reap its own nested processes), then escalate
 * through the shared managed-range termination and wait for exit proof.
 * @param wire - private ACP protocol connection.
 * @param child - shared-service handle that owns the managed range.
 * @param eofGraceMs - tier-1 window after stdin EOF.
 */
export async function disposeQoderChild(
  wire: QoderAcpWire,
  child: SubprocessHandle,
  eofGraceMs: number,
): Promise<void> {
  wire.close()

  let outcome: SubprocessOutcome | undefined
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )
  try {
    child.stdin?.end()
  } catch {
    // A concurrently closed stdin does not change range ownership below.
  }
  let exited = false
  try {
    exited = await rangeExitsWithin(child, eofGraceMs)
  } catch (error: unknown) {
    throw new QoderRunFailure({ stage: 'teardown', category: 'unknown', outcome }, thrown(error))
  }
  if (!exited) {
    // terminate() owns the bounded SIGTERM→SIGKILL timer; its unbounded wait
    // is the process owner's exit proof, not a second derived grace.
    child.terminate()
    try {
      await child.waitForExit()
    } catch (error: unknown) {
      throw new QoderRunFailure({ stage: 'teardown', category: 'unknown', outcome }, thrown(error))
    }
  }
  await child.done.catch(() => {})
}

/**
 * Start the real `qoderclicn --acp` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - binary, Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after initialization and session creation.
 */
export async function startQoderRun(
  request: SubagentStartRequest,
  spec: QoderRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('dsh-subagent-qodercn: request was aborted before ACP startup')
  }

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: qoderAcpArgv(spec),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw new QoderRunFailure({ stage: 'process', category: 'process-start' }, thrown(error))
  }
  /* v8 ignore start -- 'pipe' dispositions expose both streams by the seam contract; defensive. */
  if (child.stdin === undefined || child.stdout === undefined) {
    child.terminate()
    await child.waitForExit().catch(() => {})
    throw new QoderRunFailure({
      stage: 'process',
      category: 'process-start',
    }, new Error('dsh-subagent-qodercn: subprocess implementation dropped a piped protocol stream'))
  }
  /* v8 ignore stop */

  const wire = new QoderAcpWire(child.stdout, child.stdin, spec.permission)
  const onStderr = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    try {
      // Synchronous fd forwarding preserves byte order without owning a
      // backpressure queue. A slow host sink can block this event-loop turn.
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // Host stderr is an observation sink, not a child-run failure authority.
    }
  }
  const onStderrError = (): void => {
    // Stderr observation is auxiliary. JSON-RPC and child.done remain the
    // only terminal authorities if the diagnostic stream itself fails.
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  let processDisposal: Promise<void> | undefined
  const disposeProcess = (): Promise<void> => (processDisposal ??= (async (): Promise<void> => {
    try {
      await disposeQoderChild(wire, child, spec.disposeEofGraceMs)
      // Let stderr already queued by the process close reach the Host before
      // its forwarding listeners are detached.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    } finally {
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
    }
  })())

  let processFailureFacts: QoderFailureFacts | undefined
  const processFailure: Promise<never> = child.done.then<never>(
    (outcome) => {
      processFailureFacts = {
        stage: 'process',
        category: 'process',
        outcome,
      }
      throw new QoderRunFailure(processFailureFacts)
    },
    (error: unknown) => {
      processFailureFacts = {
        stage: 'process',
        category: 'unknown',
      }
      throw new QoderRunFailure(processFailureFacts, thrown(error))
    },
  )
  // A normal post-result dispose also closes the process. Keep its expected
  // late rejection observed when the terminal result settles first.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('dsh-subagent-qodercn: run cancelled locally'))
    wire.cancel()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let startupStage: 'initialize' | 'new-session' = 'initialize'
  try {
    wire.start()
    const agentInfo = await Promise.race([wire.initialize(request.signal), processFailure])
    try {
      spec.onAgentInfo?.(agentInfo)
    } catch {
      // Host logging cannot fail a run.
    }
    startupStage = 'new-session'
    await Promise.race([wire.newSession(spec.cwd, request.signal), processFailure])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = runAbort.signal.aborted
    if (!(error instanceof QoderRunFailure) && !cancelledBeforeCleanup) {
      // Node reports stdout EOF before the child close that owns its outcome.
      // Let an already-exiting process publish those facts before rollback.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
    // Report WHERE startup died. A process that already ended explains the
    // failure better than the stream close it caused; otherwise the wire's
    // recorded category (protocol / remote-error / transport) stands.
    const wireFacts = wire.collectFailure()
    const outcome = error instanceof QoderRunFailure
      ? error.facts.outcome
      : processFailureFacts?.outcome
    const category = error instanceof QoderRunFailure
      ? error.facts.category
      : processFailureFacts === undefined ? wireFacts.category : 'process'
    const failure = new QoderRunFailure({
      stage: startupStage,
      category,
      ...wireFacts.remoteCode === undefined ? {} : { remoteCode: wireFacts.remoteCode },
      ...outcome === undefined ? {} : { outcome },
    }, thrown(error))
    try {
      spec.onError?.(error instanceof QoderRunFailure ? (error.cause instanceof Error ? error.cause : error) : thrown(error), 'error')
    } catch {
      // The diagnostic sink cannot replace the startup failure.
    }
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      const cleanupFailure = thrown(disposeError)
      throw new AggregateError(
        [failure, cleanupFailure],
        `${failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (cancelledBeforeCleanup) {
      throw new Error('dsh-subagent-qodercn: request was aborted before run publication')
    }
    try {
      request.signal.throwIfAborted()
    } catch {
      throw new Error('dsh-subagent-qodercn: request was aborted before run publication')
    }
    throw failure
  }

  const collectOutput = (): readonly ContentBlock[] => wire.collectOutput()
  let diagnostic: string | undefined
  const recordFailureDiagnostic = (facts: QoderFailureFacts): string => {
    const failure = failureDiagnostic(facts)
    const permission = wire.collectDiagnostic()
    diagnostic = permission === undefined
      ? failure
      : `${failure}\n${permission}`
    return diagnostic
  }
  const withProcessOutcome = (facts: QoderFailureFacts): QoderFailureFacts => {
    const outcome = processFailureFacts?.outcome
    return outcome === undefined
      ? facts
      : { ...facts, outcome }
  }
  const publishedProcessFailure = processFailure.catch(
    async (error: unknown): Promise<never> => {
      // Frames already queued by the exiting agent remain authoritative. One
      // I/O turn lets them settle before process exit ends the run.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      throw error
    },
  )
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        const terminal = await Promise.race([
          wire.prompt(texts, runAbort.signal),
          publishedProcessFailure,
        ])
        if (terminal.stopReason === 'completed') return terminal
        // Let stderr already queued with the terminal frame reach the Host
        // before the non-completed result settles.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        return terminal
      } catch (error: unknown) {
        // Give stderr data already queued in Node one turn to reach the Host
        // before error settlement.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        // A child that died before answering explains the failure through its
        // exit facts; otherwise the wire's recorded category stands.
        const facts = error instanceof QoderRunFailure
          ? error.facts
          : wire.endedBeforeTerminal() && processFailureFacts !== undefined
            ? processFailureFacts
            : withProcessOutcome(wire.collectFailure())
        recordFailureDiagnostic(facts)
        throw error instanceof QoderRunFailure
          ? error
          : new QoderRunFailure(facts, thrown(error))
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      try {
        await disposeProcess()
      } catch (error: unknown) {
        throw error instanceof QoderRunFailure
          ? error
          : new QoderRunFailure({ stage: 'teardown', category: 'unknown' }, thrown(error))
      }
    },
  })
}
