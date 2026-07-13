# Codex Relay

Real-time messaging and coordination between local Codex conversations.

让一个 Codex 对话按标题向另一个 Codex 对话发送 prompt，并自动启动目标 Agent。

目标对话不需要轮询或调用接收工具。目标 Thread 已在另一个 Codex App 窗口打开时，prompt、
生成过程和最终回答会直接在该窗口实时显示，无需重启 Codex。

```text
发送方 Agent ──> Codex App follower IPC ──> 目标 GUI 窗口
                                      └──> 目标 Agent 自动开始 Turn
```

## 功能

- 按对话标题、Thread ID 或注册别名选择目标。
- 向已打开的 Codex App 窗口实时推送 prompt。
- 目标 Agent 自动执行，发送方可等待并取得最终回答。
- 支持汇报、请求、问题和任务移交。
- 支持 Planner/Reviewer 多轮讨论和需求对齐。
- 保留投递记录、目标回答、日志、超时和失败原因。
- GUI 不可用时可选择共享状态的 CLI 兼容路径。
- 提供 MCP Server、命令行工具和 `$multi-codex-align` Skill。

## 环境要求

- macOS Codex App。GUI 实时投递使用当前 App 的本地 follower IPC。
- Node.js 22.5 或更高版本。
- 已登录的 Codex CLI，仅在使用 CLI 后备模式时需要。

## 安装

```bash
git clone <repository-url> Multi-Codex
cd Multi-Codex
npm install
npm install -g --prefix "$HOME/.local" .
```

如果 `~/.local/bin` 尚未加入 `PATH`，在 shell 配置中加入：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

本地全局安装提供两个命令：

- `multi-codex`：线程查询和消息投递。
- `multi-codex-bridge`：供 Codex 调用的 MCP Server。

安装 Skill：

```bash
npm run install:skill
```

将 MCP Server 加入 Codex：

```bash
codex mcp add multiCodexBridge -- "$(command -v node)" "$(pwd)/src/index.js"
```

如果已经存在同名 MCP 配置，先执行：

```bash
codex mcp remove multiCodexBridge
```

新增 MCP 或 Skill 后，新开一个 Codex 对话让配置生效；目标 GUI 窗口本身不需要重启。

## GUI 实时发送

先使用 Codex App 自带的重命名功能给目标对话设置一个简短、唯一的标题，例如 `MOE`，再把
该 Thread 放在独立 Codex App 窗口中并保持打开。标题会持久化到 Codex 本地状态，Codex Relay
每次发送前都会重新读取，因此重命名后无需重启。

查询目标：

```bash
multi-codex threads "MOE"
```

发送 prompt：

```bash
multi-codex gui-send \
  --target "MOE" \
  --message "请评审这个需求，并列出遗漏的验收条件。"
```

运行后，目标窗口会立即出现这条 prompt 并显示 Agent 的生成过程。命令会等待目标完成，并输出
投递 ID、目标 Turn ID、投递后端和最终回答。

发送长内容时使用文件：

```bash
multi-codex gui-send \
  --target "需求评审" \
  --file "/absolute/path/requirement.md" \
  --timeout 1200
```

## 在 Codex 中使用

安装 MCP 和 Skill 后，可以直接对 Codex 说：

```text
使用 $multi-codex-align，通过 GUI 实时投递向标题为“MOE”的对话发送：
请检查当前方案的边界条件，并回复你的结论。
```

Codex 会调用 `send_agent_message`，核心参数如下：

```json
{
  "target": "MOE",
  "kind": "question",
  "subject": "方案复核",
  "message": "请检查当前方案的边界条件，并回复你的结论。",
  "delivery_mode": "gui",
  "wait_for_response": true,
  "timeout_seconds": 300,
  "turn_timeout_seconds": 900
}
```

目标 Agent 不需要调用任何 MCP 工具。它收到的是一个正常的新用户 Turn。

## 投递模式

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `gui` | 只通过 Codex App follower IPC 投递 | 必须在另一个 GUI 窗口实时显示 |
| `auto` | 优先 GUI，GUI owner 不可用时回退 CLI | 更重视投递成功率 |
| `cli` | 使用 `codex exec resume` 兼容路径 | 目标 GUI 窗口没有打开 |

严格要求实时显示时使用 `gui`。该模式找不到目标 owner 窗口会明确失败，不会静默投到其他对话。

命令行的 `send` 支持选择模式：

```bash
multi-codex send \
  --mode auto \
  --target "需求评审" \
  --message "请回复是否同意 rev-3。"
```

## 两个 Agent 讨论

为两个窗口设置唯一标题，例如：

- `测试任务-规划`
- `测试任务-评审`

然后让控制 Agent 使用 `$multi-codex-align` 交替发送：

1. Planner 提出带版本号的完整方案。
2. Reviewer 返回 `AGREE`、`CONFLICT` 或 `QUESTION`。
3. Planner 根据真实回复修订，不得为了达成一致缩小用户范围。
4. 双方对同一版本明确 `AGREE` 且无遗留问题时才结束。

也可以进行普通辩论。只有目标明确表示被说服，控制 Agent才能报告“说服成功”。

## MCP 工具

- `list_codex_threads`：列出本地对话。
- `register_codex_agent`：为标题经常变化的自动化目标注册可选别名。
- `list_codex_agents`：列出已注册别名。
- `send_agent_message`：发送普通报告、请求、移交或问题。
- `report_task_completion`：发送结构化完成报告。
- `get_agent_delivery`：查询投递状态和最终回答。
- `list_agent_deliveries`：查看最近投递。

投递数据默认保存在 `~/.codex/multi-codex-bridge/`。

## 常见错误

| 错误 | 原因与处理 |
|---|---|
| `GUI_OWNER_NOT_FOUND` | 目标 Thread 没有在独立 Codex App 窗口打开；打开后重试 |
| `GUI_IPC_NOT_FOUND` | Codex App 未运行，或本地 IPC Socket 不存在 |
| `THREAD_NOT_FOUND` | 没有该标题；在 Codex App 中将目标对话重命名为一个唯一短名称 |
| `TARGET_AMBIGUOUS` | 多个对话匹配同一标题；使用完整标题或 Thread ID |
| `SELF_DELIVERY_BLOCKED` | 目标和发送方是同一个 Thread |
| `TARGET_BUSY_TIMEOUT` | 同一目标已有投递或正在执行其他 Turn |
| `TURN_TIMEOUT` | 目标 Agent 在指定时间内没有完成 |
| `GUI_TURN_START_FAILED` | Codex App 内部协议变化或目标窗口拒绝请求 |

GUI follower IPC 是 Codex App 当前使用的内部、本地协议，可能随 App 版本升级而变化。项目会在协议
不匹配时明确失败，不使用鼠标、键盘或剪贴板自动化作为替代。

## 开发与验证

```bash
npm run check
npm test
```

测试包含：Thread 解析、别名、安全边界、MCP 工具、同目标串行化、超时、CLI 后备，以及模拟
Codex App Router 的 GUI follower IPC 端到端协议。

需要实际调用模型的 CLI 持久化测试：

```bash
npm run test:e2e
```

项目结构：

```text
src/
  cli.js          # multi-codex 命令
  gui-ipc.js      # Codex App 实时投递
  index.js        # MCP Server
  bridge.js       # Thread、别名和投递记录
  worker.js       # GUI/CLI 后端与串行执行
skills/
  multi-codex-align/
scripts/
  install-skill.mjs
test/
docs/
  ARCHITECTURE.md
```

详细状态机与信任边界见 [架构说明](./docs/ARCHITECTURE.md)。
