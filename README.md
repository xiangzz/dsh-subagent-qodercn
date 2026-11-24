# dsh-subagent-qodercn

English | [中文](README.zh.md)

Connects Qoder CLI CN to the DeepSeek Harness (DSH) subagent registry. Once enabled, every preset's model sees a `subagent_qodercn` tool: each call starts a fresh `qoderclicn --acp` process in the task's working directory, hands it the task over the Agent Client Protocol (ACP), and returns only its final answer (or a safe failure diagnostic) to the parent session.

The layout mirrors the official `@deepseek-ai/dsh-subagent-codex`; only the protocol layer changes, from the Codex app-server to ACP.

## Requirements

- DeepSeek Harness `>=0.2.2-rc.5`
- Qoder CLI CN installed and signed in (`qoderclicn --version` prints a version). See [Qoder CLI CN installation](https://docs.qoder.cn/cli/installation) (install script: `curl -fsSL https://static.qoder.com.cn/qoder-cli-cn/install.sh | bash`); sign in with `qodercn login`.
- The plugin does not depend on the Host `PATH`. When `qoderclicn` is not configured explicitly it probes, in order:
  1. the plugin's `command` config
  2. `qoderclicn` on `PATH`
  3. `~/.local/bin/qoderclicn` (the install-script symlink)
  4. `~/.qoder-cn/bin/qoderclicn/qoderclicn-<version from version.txt>`
  5. `~/.qoder-cn/bin/qoderclicn/qoderclicn`
  6. `qodercn` on `PATH` (the shell dispatcher, last resort)

## Install

In the DSH Web/Desktop **Plugins** > **Add plugin** page pick this directory, or run `plugin_manager` `install_bundle` with this directory's absolute path. The bundle inserts two Host rows:

```yaml
- insert:
    - id: subagent-qodercn
      name: 'dsh-subagent-qodercn'             # registers the provider
    - id: tool-subagent-qodercn
      name: '@deepseek-ai/dsh-tool-subagent'  # the shared delegation tool (shipped with DSH)
      config:
        provider: qodercn
        toolName: subagent_qodercn
        maxDepth: provider-managed
```

`subagent_qodercn` is a global tool visible to every preset, including minimal. Later user patches may configure or disable either row by id.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `qodercn` | Registry name on `ctx.subagents`; unique per mounted instance |
| `command` | auto-resolve | The `qoderclicn` executable: an absolute path, or a name to look up on `PATH` |
| `extraArgs` | `[]` | `qoderclicn` arguments appended after the provider's own flags, e.g. `['--add-dir', '/x']`, `['--setting-sources', 'user']`, `['--strict-mcp-config']` |
| `model` | Qoder settings | Fixed model (`--model`), e.g. `auto` or `Qwen3.8-Max` |
| `reasoningEffort` | Qoder settings | Fixed reasoning effort (`--reasoning-effort`) |
| `permissionMode` | `auto` | Fixed `--permission-mode`: `default` / `accept_edits` / `auto` / `bypass_permissions` / `dont_ask` |
| `permission` | `reject` | How to answer permission requests Qoder forwards over ACP: `reject` cancels every prompt; `allow` selects the first `allow_once` / `allow_always` option |
| `env` | `{}` | Explicit child environment entries, e.g. `QODERCN_PERSONAL_ACCESS_TOKEN` (the subprocess seam scrubs credential-shaped variables first, so a token must be listed here to reach the child) |
| `disposeEofGraceMs` | `8000` | Window after stdin EOF for Qoder to flush persistence and reap its own subprocesses (measured on 1.1.95: the ACP server exits on EOF after about 6.4 s) |
| `disposeGraceMs` | `3000` | Grace between managed-range termination tiers (SIGTERM → SIGKILL) |

Every run uses this fixed command line:

```
<qoderclicn> --acp --permission-mode <permissionMode> [--model <model>] [--reasoning-effort <effort>] <extraArgs...>
```

The permission mode is always passed explicitly, so runs do not depend on `general.defaultPermissionMode` in the user's `~/.qoder-cn/settings.json`. The process cwd is the task's working directory; Qoder treats it as the primary trust root, so non-default modes such as `auto` take effect.

When `model` is omitted the run uses the default model from `~/.qoder-cn/settings.json`. If that default is a custom (BYOK) provider rather than a model included with the Qoder account, the subagent uses that provider too; set `model` to `auto` or one of the names from `--list-models` to pin a subscription model.

Permission split (see the [Qoder permissions doc](https://docs.qoder.cn/cli/permissions.md)): under `auto`, Qoder approves safe reads and in-workspace edits itself and rejects risky actions; only operations that still resolve to `ask` reach this plugin through ACP `session/request_permission`, where the `permission` policy decides. No prompt is ever shown to a human.

## What you get

The parent model first receives the child's name, then Qoder's final answer (the text accumulated from `agent_message_chunk`) or a stop reason with a safe diagnostic. Stop reasons map as `end_turn` → `completed`, `max_tokens` → `max-tokens`, `refusal` → `refusal`, `cancelled` → `aborted`, everything else (including `max_turn_requests`) → `error`.

Qoder's reasoning, tool calls, plans, stderr, and workspace changes never enter the parent session; the parent only stores the external task identity and terminal result and creates no local child Session.

## Failures and recovery

- **Executable not found**: fails in the `binary` stage; the message lists every probed path and the installation docs.
- **Startup failure** (`initialize` / `new-session`): the child is reaped before rejecting; the diagnostic carries only fixed stage, category, agent error code, and process exit code/signal.
- **Post-publication failure**: flattened to `stopReason: 'error'` with the same safe diagnostic; local cancellation settles as `aborted`.
- **Unknown agent request**: an ACP request this plugin does not recognize fails the run (default deny) instead of leaving the child waiting.
- **Cancellation**: sends `session/cancel`, closes stdin, waits the EOF grace, then escalates termination.

## Implementation

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry: Config schema, provider registration |
| `src/binary.ts` | `qoderclicn` executable resolution |
| `src/run.ts` | Run lifecycle: spawn, startup transaction, publication, cancellation, disposal |
| `src/wire.ts` | Minimal ACP v1 client (`initialize` / `session/new` / `session/prompt` / `session/cancel` / `session/request_permission`) |
| `cordis.patch.yml` | Profile layer that registers the provider and adds the delegation tool |

Framing and request correlation reuse DSH's own `JsonRpcLineTransport` (`@deepseek-ai/dsh-sdk-protocol`); there is no ACP SDK dependency and the bundle has no npm runtime dependencies — every `@deepseek-ai/*` package ships with DSH and is declared as a peerDependency.

One run does exactly: spawn → `initialize` (advertising `clientCapabilities: {}`, no fs/terminal, so Qoder self-serves) → `session/new {cwd}` → publish the `SubagentRun` → `session/prompt` → collect `agent_message_chunk` → return the `stopReason`. No continuation, resume, or process pooling.

## Development

```sh
pnpm install
pnpm run verify     # build + typecheck + test
```

## Known limitations

- One fresh process, session, and prompt per run; no continuation, resume, progress streaming, or session persistence.
- As an out-of-process provider it cannot honor `agentPreset`, `agentOptions`, `outputSchema`, or depth limits; the seam rejects such requests.
- Login and account state stay managed by Qoder's native mechanisms; the plugin never signs in or edits Qoder settings.
- No human approval path: permission requests are only auto-allowed or auto-rejected.
- Files changed before cancellation are not restored.
- `--acp` is not listed in `qoderclicn --help` but works on 1.1.90; if a future Qoder release breaks the handshake, the diagnostic reports a protocol failure in the `initialize` stage.
