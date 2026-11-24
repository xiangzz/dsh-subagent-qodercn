/**
 * Profile-named Qoder CLI CN one-shot subagent provider. Every accepted run
 * spawns a fresh `qoderclicn --acp` server in the delegating Session's
 * workspace and publishes only after an ACP session exists.
 *
 * @module dsh-subagent-qodercn
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  NO_START_CAPABILITIES,
  assertPositiveFinite,
  assertUsableCwd,
} from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { resolveQoderBinary } from './binary.ts'
import type { QoderBinary } from './binary.ts'
import {
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_PERMISSION_POLICY,
  DEFAULT_QODER_PERMISSION_MODE,
  QODER_PERMISSION_MODES,
  qoderBinaryFailure,
  qoderStartupFailure,
  startQoderRun,
} from './run.ts'
import type { QoderPermissionMode, QoderRunSpec } from './run.ts'
import { PERMISSION_POLICIES } from './wire.ts'
import type { PermissionPolicy } from './wire.ts'

export const name = 'subagent-qodercn'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'qodercn'
const DIAGNOSTIC_PREFIX = 'dsh-subagent-qodercn'

/** Deployment-owned binary, model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `qodercn`). */
  providerName?: string
  /**
   * Explicit `qoderclicn` executable: an absolute path, or a bare name looked
   * up on `PATH`. Omitted to auto-resolve the official install-script and npm
   * locations.
   */
  command?: string
  /** Extra `qoderclicn` arguments appended after the provider's own flags. */
  extraArgs?: string[]
  /** Native Qoder model fixed for this instance (`--model`); omitted to inherit Qoder settings. */
  model?: string
  /** Native Qoder reasoning effort fixed for this instance (`--reasoning-effort`). */
  reasoningEffort?: string
  /** Native permission mode fixed for every run (`--permission-mode`); `auto` is Qoder's unattended mode. */
  permissionMode?: QoderPermissionMode
  /**
   * How to auto-answer the agent's ACP permission requests: `reject` cancels
   * every prompt (default), `allow` selects the first `allow_once`/`allow_always`
   * option. No prompt reaches a human.
   */
  permission?: PermissionPolicy
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment, e.g. `QODERCN_PERSONAL_ACCESS_TOKEN`.
   */
  env?: Record<string, string>
  /** Grace in milliseconds after stdin EOF for the agent's cooperative shutdown. */
  disposeEofGraceMs?: number
  /** Grace in milliseconds between managed-range termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  command: z.string().min(1),
  extraArgs: z.array(z.string()).default([]),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  permissionMode: z.union([...QODER_PERMISSION_MODES])
    .default(DEFAULT_QODER_PERMISSION_MODE),
  permission: z.union([...PERMISSION_POLICIES])
    .default(DEFAULT_PERMISSION_POLICY),
  env: z.dict(z.string()).default({}),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Omit<Required<Config>, 'command' | 'model' | 'reasoningEffort'>
  & Pick<Config, 'command' | 'model' | 'reasoningEffort'>

/** A process grace must fit every Node timer that observes or terminates the child. */
function assertGrace(name: string, value: number): void {
  assertPositiveFinite(DIAGNOSTIC_PREFIX, name, value)
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${DIAGNOSTIC_PREFIX}: ${name} must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

class QoderProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly name: string
  private readonly ctx: Context
  private readonly config: ResolvedConfig

  constructor(name: string, ctx: Context, config: ResolvedConfig) {
    this.name = name
    this.ctx = ctx
    this.config = config
  }

  async start(request: ResolvedSubagentStartRequest) {
    if (request.signal.aborted) {
      throw new Error(`${DIAGNOSTIC_PREFIX}: request was aborted before ACP startup`)
    }
    let cwd: string
    try {
      cwd = assertUsableCwd(name, 'child cwd', request.cwd)
    } catch (error: unknown) {
      const failure = qoderStartupFailure(error)
      this.ctx.logger.warn(`${DIAGNOSTIC_PREFIX} "${this.name}": child start failed: %o`, failure)
      throw failure
    }
    let binary: QoderBinary
    try {
      binary = resolveQoderBinary(this.config.command)
    } catch (error: unknown) {
      const failure = qoderBinaryFailure(error)
      this.ctx.logger.warn(`${DIAGNOSTIC_PREFIX} "${this.name}": child start failed: %o`, failure)
      throw failure
    }
    const spec: QoderRunSpec = {
      binary,
      cwd,
      extraArgs: this.config.extraArgs,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      ...this.config.reasoningEffort === undefined ? {} : { reasoningEffort: this.config.reasoningEffort },
      permissionMode: this.config.permissionMode,
      permission: this.config.permission,
      env: this.config.env,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onAgentInfo: (info) => {
        this.ctx.logger.info(
          `${DIAGNOSTIC_PREFIX} "${this.name}": ${info.name ?? 'agent'} ${info.version ?? ''} (ACP ${info.protocolVersion}) from ${binary.path}`,
        )
      },
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `${DIAGNOSTIC_PREFIX} "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startQoderRun(request, spec)
  }
}

/**
 * Register one Profile-named Qoder CLI CN provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional binary/model/effort overrides,
 *   permission mode and policy, child environment, and disposal graces.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.command === undefined ? {} : { command: config.command },
    extraArgs: config.extraArgs ?? [],
    ...config.model === undefined ? {} : { model: config.model },
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    permissionMode: config.permissionMode ?? DEFAULT_QODER_PERMISSION_MODE,
    permission: config.permission ?? DEFAULT_PERMISSION_POLICY,
    env: config.env as Record<string, string>,
    disposeEofGraceMs: config.disposeEofGraceMs as number,
    disposeGraceMs: config.disposeGraceMs as number,
  }
  assertGrace('disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertGrace('disposeGraceMs', resolved.disposeGraceMs)
  ctx.subagents.registerProvider(new QoderProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
}
