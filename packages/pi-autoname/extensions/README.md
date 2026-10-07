# extensions/

pi-autoname 的核心逻辑所在。

## 文件说明

| 文件 | 职责 |
|------|------|
| `index.ts` | Pi Extension 入口：按 session id 持有 controller（M13）、`/autoname`、模型调用、30s 总预算、JSONL 诊断 |
| `controller.ts` | 命名状态机：settled 生命周期、手工名粘滞、过期请求取消 |
| `lib.ts` | 语言检测、配置、脱敏、对话提取、`getRichDialogue`、utility-models registry |

## 关键导出

### index.ts（默认导出）

```typescript
export default function extension(pi: ExtensionAPI): void
```

注册以下能力：
- `session_start`（会话启动）— 恢复命名状态，并在 debug 模式记录 session JSONL 诊断
- `session_info_changed`（会话名称变更）— 立即识别 `/name`，写入手工名称 marker
- `agent_settled`（代理完全稳定）— 后台触发首次或周期命名，不阻塞主代理收口
- `session_shutdown`（会话关闭）— 取消未完成命名请求
- `/autoname`（手动命令）— 显式触发一次命名，即使 `respectManualName` 已启用

命名导出：
- `readSessionFileDiagnostics(sessionFile)` — 读当前 session JSONL，返回最新的 `session_info` 和 `pi-autoname-state` marker。**按文件行序取最后一个**，不区分 branch；Pi 会话是树结构，`.jsonl` 含所有 branch 的 entry，所以诊断里的“最新名”可能来自非活跃分支，仅用于 debug 排障。运行时命名决策以 `getBranch()` 为准，不用这个 helper。
- `SessionFileDiagnostics` — 返回值类型

### lib.ts（命名导出）

纯函数：
- `detectDominantUserLanguage(parts)` — 仅按用户自然语言消息判定中文、英文、日文或韩文主语言
- `getNamingLanguageInstruction(parts, fallbackLocale)` — 生成显式语言提示；无可判定用户语言时才采用可选 locale 兜底
- `normalizeConfig(input)` — 配置规范化
- `redactSensitiveText(text)` — 敏感信息脱敏
- `isHighQualityName(name)` — 名称质量检查
- `blockText(content)` — 从消息 content 抽纯文本
- `smartFallbackName(text)` — 降级命名生成
- `parseRenameMarker(data)` — 解析 `pi-autoname-state` entry 的 marker
- `getFirstDialogue(branch)` / `getRecentDialogue(branch)` / `getInitialDialogue(branch)` — 对话提取

常量：`DEFAULT_CONFIG`、`MIN_NAME_LENGTH`、`MAX_NAME_LENGTH`、`RAW_SLICE_RE`、`SENTENCE_END_RE`、`MIN_COOLDOWN_MINUTES`、`MAX_COOLDOWN_MINUTES`、`SENSITIVE_PATTERNS`

类型：`AutonameConfig`、`RenameMarker`

## 测试

```bash
npm test
```

This fork runs tests with Vitest (`npx vitest run`). Upstream 0.6.6 switched the published package to `node:test`; the cases are the same.

测试文件位于：
- `../tests/pi-autoname.test.ts` — `lib.ts` 纯函数
- `../tests/extension-lifecycle.test.ts` — `index.ts` 生命周期、冷却时间、手工改名检测、session 文件诊断
