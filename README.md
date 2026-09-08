# pi-loop（中文版）

一个 [pi](https://github.com/earendil-works/pi) 编码助手扩展，让一个提示词**反复运行**——按固定定时、按 pi 事件触发，或由 Agent 自定节奏。原型来自 Claude Code 的 `/loop`。本 fork 新增了 **forever 模式**：永不停止的循环。

## 总览

调度一个提示词在 pi 内部反复运行。三种经典触发方式：定时（cron）、事件、自定节奏（self-paced），以及本 fork 新增的第四种——**forever**：Agent 一空闲就立即开始下一轮，永不停止。

## Forever 模式（本 fork 新增）

```
/loop forever <任务描述>
```

- **永续运行**：Agent 每干完一轮，立刻自动开始下一轮，中间零等待。不设次数上限、不过期（其他模式 7 天自动作废，forever 不会）。
- **上下文超长兜底**：检测到上下文超限（`stopReason: "length"` 或 overflow 类错误），自动注入 `/compact` 压缩后继续。pi 内置的主动压缩（达到阈值即压缩）是第一道防线，这里是兜底。
- **其他一切错误**（服务过载、维护中、key 过期、未知错误）：不区分、不等待，**立即重试**。
- **打字不接管**：你在它运行时插话，循环照跑。
- **模型无权修改**：Agent 调用 `LoopDelete` 无法删除或暂停 forever 循环——只有你能用 `/loop stop` 停它。这修复了原版中"模型偷偷替换用户循环"的问题。

唯一停止方式：`/loop stop [id]`。

## 循环管理面板（本 fork 新增）

直接输入 `/loop`（不带参数）即可打开统一管理面板，所有循环操作都在这里：

```
#2 [active] forever · 5次 · 绿写小说下一章
#3 [paused] cron: */15 * * * * · 12次 · 检查CI是否通过
#4 [active] cron: */30 * * * * · 0次 · 下次 23分钟后 · 检查部署
⚠️ 全部停止
← 关闭
```

选中某个循环后进入操作菜单：

- **✏️ 编辑任务描述**：预填当前 prompt，改完回车提交，下一轮 fire 生效（不停循环、保留 id/次数）；空文本视为取消
- **⏸️ 暂停 / ▶️ 恢复**：暂停不触发 fire，状态保留；恢复 forever 循环时若 Agent 空闲会**立即补触发一次**，cron 循环等下一节拍
- **🛑 停止**：直接停，无确认

命令层保留：`/loop stop <id>`（直停）、`/loop stop all`（全停）。`/loop stop` 不带参数**不停止任何东西**，只提示用法——防误伤。`/loop list` 保留作为面板的别名。

模型（LoopDelete 工具）依然无权修改 forever 循环。

## 其他功能（继承自上游）

- **固定间隔循环** —— `/loop 15m <prompt>`：解析间隔为 cron，由自重装定时器驱动，续跑是默认行为。
- **自定节奏循环** —— `/loop <prompt>`（无间隔）：模型每轮结束时调用 `schedule_loop_wakeup` 续命，不调用即结束。天然支持无限、目标导向、随机三种形态。
- **事件与混合触发** —— 监听 pi 事件（如 `tool_execution_end`、`turn_end`）或 cron+事件组合带防抖。
- **多循环并发** —— 同时跑多个；用 `LoopCreate` / `LoopList` / `LoopDelete` 或 `/loop list` 管理。
- **持久化** —— 循环状态存于 `.pi/loops`，`--resume`/`--continue` 时恢复未过期的循环。
- **安全上限** —— 每循环 `maxFires` 与 7 天自动过期（forever 模式不设这两项）；错峰触发避免 API 惊群。
- **只读模式** —— 限制循环只使用只读工具。
- **实时状态** —— footer 指示器和 widget 列出活跃循环及下次触发倒计时。

## 安装

```bash
pi install git:github.com/tutu359/pi-loop@main
# 本地开发调试（改动即时生效）：
pi install file:/path/to/pi-loop-fork
```

用 `pi list` 验证已加载。

## 快速上手

```
/loop forever 续写小说下一章，写完继续下一章
```

永续循环：每轮结束立刻开始下一轮，上下文满了自动压缩，其他报错直接重试，永不停止。

```
/loop 5m 检查部署是否完成并报告结果
```

固定 5 分钟循环。一直跑到你手动停止、7 天到期或触发次数上限。

```
/loop 检查 CI 是否通过并处理 review 意见
```

自定节奏：模型干完一轮后自行决定是否通过 `schedule_loop_wakeup` 继续，任务完成时不调用即自然结束。

```
/loop              # 打开管理面板（主入口）
/loop list         # 同上（别名）
/loop stop all     # 停止所有循环
/loop stop 3       # 停止 3 号循环
```

## 用法

### `/loop` 命令

| 输入 | 行为 |
| --- | --- |
| `/loop forever <prompt>` | **永续循环**（本 fork 新增）：Agent 一空闲立即接续，永不停止。 |
| `/loop 15m <prompt>` | 固定间隔（cron）循环。间隔也可放句尾：`<prompt> every 2 hours`。 |
| `/loop 0 9 * * 1-5 <prompt>` | 完整 5 段 cron 表达式。 |
| `/loop <prompt>` | 自定节奏循环——模型每轮通过 `schedule_loop_wakeup` 续跑，不调用即结束。 |
| `/loop`（无参数） | **打开循环管理面板**（编辑/暂停/恢复/停止/全部停止）。 |
| `/loop list` | 同上（别名）。 |
| `/loop stop all` | 停止所有循环。 |
| `/loop stop [id]` | 直停指定循环。不带参数不停止任何东西。 |

间隔支持 `s` / `m` / `h` / `d`。不足一分钟的向上取整到一分钟（cron 下限）；不整的间隔（如 `7m`）会吸附到最近的整步并告知你实际选了什么。

### 工具（供 Agent 使用）

| 工具 | 作用 |
| --- | --- |
| `LoopCreate` | 按 cron 定时、pi 事件或混合方式调度循环。支持 `recurring`、`readOnly`、`maxFires`、`filter`。**无法创建或修改 forever 循环。** |
| `LoopList` | 列出循环的 id、触发方式、触发次数、下次触发时间。 |
| `LoopDelete` | 按 id 删除循环，或 `action="pause"` 暂停。**对 forever 循环无权限，会被拒绝。** |
| `schedule_loop_wakeup` | 续跑自定节奏 `/loop`：回合结束时调用以运行下一轮（可选 `delaySeconds`；`0` = 立即）。不调用即结束循环。 |

触发类型：`cron`（`5m`、`1h`、`0 9 * * 1-5`）、`event`（任意 pi 事件通道；生命周期事件 `tool_execution_start/end`、`turn_start/end`、`agent_start/end`、`message_end` 已桥接）、`hybrid`（两者组合带防抖）、`forever`（仅命令层可创建）。

## 行为说明

- **Cron 触发等待空闲。** Agent 忙碌时到点的 tick 会把循环标记为 **due**（状态栏可见）而不是排队陈旧提示；Agent 一空闲立即补发。重复的 tick 合并为一次触发——当单轮时长超过间隔时，实际节奏变为每轮一次。
- **事件触发落在回合之间。** 事件/混合触发作为 follow-up 投递给引发它的那个回合；已有排队消息时循环触发会跳过，不会堆积。
- **接管语义。** 自定节奏循环等待期间你打字即结束（视为接管）。cron/event 循环和 **forever 循环**不受你的消息影响，直到 `/loop stop`。
- **只有跑过的循环才能结束。** omit-to-end 只作用于本轮实际运行过的自定节奏循环；等待中的循环或其他循环不受无关回合影响。
- **上下文超长恢复（forever）。** 检测到 overflow 后自动注入 `/compact`，压缩完成后继续下一轮。配合在 `models.json` 中把模型的 `contextWindow` 调至合理值（使 pi 的压缩触发点远离真实窗口上限），可实现无人值守通宵运行。
- **不补发。** 忙碌期间错过的触发只在空闲时补一次，不按间隔逐个补。
- **会话绑定。** 循环在会话开始时武装（`--resume` 恢复的循环无需输入即可触发），会话变更（`/new`、fork）时重新绑定。每个会话有独立的存储——一个终端启动的循环对另一个终端的 `/loop stop` 不可见。

## 配置

| 变量 | 效果 | 默认值 |
|---|---|---|
| `PI_LOOP` | `off` 关闭持久化（仅内存）；绝对/相对路径指定自定义存储文件 | `.pi/loops/loops-<sessionId>.json` |

常量位于 `loop.ts` / `src/` 顶部：状态刷新间隔、混合触发默认防抖、桥接的生命周期事件列表。上限：25 个活跃循环、7 天过期（forever 循环不适用）。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx — 覆盖解析、cron、抖动
```

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | 循环/触发类型（含 forever）。 |
| `src/loop-parse.ts` | `parseInterval`、`extractInterval`、cron 数学、抖动（纯函数，已测试）。 |
| `src/store.ts` | 循环注册表 + JSON 持久化。 |
| `src/scheduler.ts` | 自重装 cron 定时器。 |
| `src/triggers.ts` | 事件/混合订阅 + 防抖。 |
| `loop.ts` | 入口：命令、工具、触发→消息桥、状态组件、生命周期（含 forever 的 agent_end 续跑与 overflow 兜底）。 |

## 许可证

[MIT](LICENSE)

## 致谢

基于 [kolt-mcb/pi-loop](https://github.com/kolt-mcb/pi-loop)（MIT）修改，感谢原作者的工作。
