# dsh-subagent-qodercn

[English](README.md) | 中文

把 Qoder CLI CN 接入 DeepSeek Harness（DSH）的子代理注册表。启用后，所有预设里的模型都能看到一个 `subagent_qodercn` 工具：每次调用都会在任务的工作目录里全新启动一个 `qoderclicn --acp` 进程，通过 ACP（Agent Client Protocol）把任务交给它，只把它的最终回答（或安全的失败诊断）返回给父会话。

实现结构仿照官方的 `@deepseek-ai/dsh-subagent-codex`，只是把协议层从 Codex app-server 换成了 ACP。

## 前置条件

- DeepSeek Harness `>=0.2.2-rc.5`
- Qoder CLI CN 已安装并登录：`qoderclicn --version` 能输出版本号即可。安装方式见 [Qoder CLI CN 安装与升级](https://docs.qoder.cn/cli/installation)（推荐安装脚本：`curl -fsSL https://static.qoder.com.cn/qoder-cli-cn/install.sh | bash`），登录用 `qodercn login`。
- 本插件不依赖宿主 `PATH`。找不到 `qoderclicn` 时会按下面顺序自动定位：
  1. 插件配置里的 `command`
  2. `PATH` 上的 `qoderclicn`
  3. `~/.local/bin/qoderclicn`（安装脚本放的软链）
  4. `~/.qoder-cn/bin/qoderclicn/qoderclicn-<version.txt 里的版本>`
  5. `~/.qoder-cn/bin/qoderclicn/qoderclicn`
  6. `PATH` 上的 `qodercn`（bash 分发脚本，最后兜底）

## 安装

在 DSH Web/Desktop 的 **插件** > **添加插件** 里选择本目录安装，或者用 `plugin_manager` 的 `install_bundle` 指向本目录的绝对路径。安装后 bundle 会插入两行 Host 条目：

```yaml
- insert:
    - id: subagent-qodercn
      name: 'dsh-subagent-qodercn'          # 注册提供方
    - id: tool-subagent-qodercn
      name: '@deepseek-ai/dsh-tool-subagent'  # 通用委派工具（DSH 自带）
      config:
        provider: qodercn
        toolName: subagent_qodercn
        maxDepth: provider-managed
```

`subagent_qodercn` 是全局工具，对包括 minimal 在内的所有预设可见。后续用户补丁可以按 id 配置或禁用这两行。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `qodercn` | 在 `ctx.subagents` 上的注册名；每个已挂载实例都要唯一 |
| `command` | 自动定位 | `qoderclicn` 可执行文件：绝对路径，或要在 `PATH` 上查找的名字 |
| `extraArgs` | `[]` | 追加在插件自身参数之后的 `qoderclicn` 参数，例如 `['--add-dir', '/x']`、`['--setting-sources', 'user']`、`['--strict-mcp-config']` |
| `model` | Qoder 原生设置 | 固定模型（`--model`），例如 `auto` 或 `Qwen3.8-Max` |
| `reasoningEffort` | Qoder 原生设置 | 固定推理强度（`--reasoning-effort`） |
| `permissionMode` | `auto` | 固定 `--permission-mode`：`default` / `accept_edits` / `auto` / `bypass_permissions` / `dont_ask` |
| `permission` | `reject` | 回答 Qoder 通过 ACP 发来的权限请求：`reject` 全部取消；`allow` 选第一个 `allow_once` / `allow_always` 选项 |
| `env` | `{}` | 叠加在子进程环境上的显式变量，例如 `QODERCN_PERSONAL_ACCESS_TOKEN`（子进程环境会先清掉长得像凭据的变量，所以要传 token 必须在这里显式写） |
| `disposeEofGraceMs` | `8000` | 关闭 stdin 后给 Qoder 做持久化和清理自己子进程的宽限（实测 1.1.95 在 stdin 关闭后约 6.4 秒自行退出） |
| `disposeGraceMs` | `3000` | 托管进程范围逐级终止（SIGTERM → SIGKILL）的宽限 |

每次运行的命令行固定是：

```
<qoderclicn> --acp --permission-mode <permissionMode> [--model <model>] [--reasoning-effort <effort>] <extraArgs...>
```

权限模式总是显式传入，所以不会受用户 `~/.qoder-cn/settings.json` 里 `general.defaultPermissionMode` 的影响。进程 cwd 就是任务的工作目录，Qoder 会把它当作主信任目录，因此 `auto` 等非默认模式能正常生效。

省略 `model` 时沿用 `~/.qoder-cn/settings.json` 里的默认模型。如果你的默认模型是自定义（BYOK）提供方而不是 Qoder 账号自带的模型，子智能体也会走那个提供方；想固定用 Qoder 订阅内的模型，就把 `model` 设成 `auto` 或 `--list-models` 列出的某个名字。

关于权限的分工（见 [Qoder 权限文档](https://docs.qoder.cn/cli/permissions.md)）：`auto` 模式下 Qoder 自己放行安全的读取和工作区内编辑、拒绝风险动作；只有最终仍是 `ask` 的操作才会通过 ACP 的 `session/request_permission` 发给本插件，由 `permission` 策略决定。没有任何请求会弹给人。

## 你会得到什么

父模型先收到子任务名称，任务结束后收到 Qoder 的最终回答（`agent_message_chunk` 累积的文本），或者停止原因加安全诊断。停止原因映射：`end_turn` → `completed`，`max_tokens` → `max-tokens`，`refusal` → `refusal`，`cancelled` → `aborted`，其余（含 `max_turn_requests`）→ `error`。

Qoder 的推理过程、工具调用、计划、stderr 和工作区改动都不会进入父会话；父会话只保存外部任务的身份和终态结果，不会创建本地子 Session。

## 失败与恢复

- **找不到可执行文件**：在 `binary` 阶段失败，错误信息里列出所有探测过的路径和安装文档链接。
- **启动失败**（`initialize` / `new-session` 阶段）：先把子进程收拾干净再拒绝，诊断只含固定的阶段、类别、agent 错误码和进程退出码/信号。
- **发布后失败**：折叠成 `stopReason: 'error'`，附带同样的安全诊断；本地取消则结算为 `aborted`。
- **未知的服务端请求**：Qoder 发来本插件不认识的 ACP 请求时运行失败（默认拒绝），不会让子进程无人应答地等待。
- 被取消的运行：先发 `session/cancel`，再关闭 stdin，等待宽限期后逐级终止。

## 实现说明

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：Config schema、提供方注册 |
| `src/binary.ts` | `qoderclicn` 可执行文件定位 |
| `src/run.ts` | 运行生命周期：spawn、启动事务、发布、取消、销毁 |
| `src/wire.ts` | 最小的 ACP v1 客户端（`initialize` / `session/new` / `session/prompt` / `session/cancel` / `session/request_permission`） |
| `cordis.patch.yml` | 注册提供方并添加委派工具的 Profile 配置层 |

帧格式和请求关联复用 DSH 自带的 `JsonRpcLineTransport`（`@deepseek-ai/dsh-sdk-protocol`），不依赖 ACP SDK，bundle 没有 npm 运行时依赖；所有 `@deepseek-ai/*` 包都是 DSH 自带、以 peerDependencies 声明的。

一次运行只做：spawn → `initialize`（声明 `clientCapabilities: {}`，不提供 fs/terminal，让 Qoder 在自己进程里处理）→ `session/new {cwd}` → 发布 `SubagentRun` → `session/prompt` → 收集 `agent_message_chunk` → 返回 `stopReason`。没有续接、恢复或进程池。

## 开发

```sh
pnpm install
pnpm run verify     # build + typecheck + test
```

## 已知限制

- 每次运行一个全新进程、一个会话、一轮提示；不支持续接、恢复、进度流或会话持久化。
- 进程外子代理不支持 `agentPreset`、`agentOptions`、`outputSchema` 和深度上限，seam 会直接拒绝这些请求。
- 登录和账户状态仍由 Qoder 原生机制管理；本插件不会登录、不改写 Qoder 设置。
- 没有人工审批路径：权限请求只会被自动允许或拒绝。
- 取消前已经改动的文件不会恢复原状。
- `--acp` 在 `qoderclicn --help` 里没有列出，但在 1.1.90 上实测可用；Qoder 升级后若握手失败，诊断会报 `initialize` 阶段的协议错误。
