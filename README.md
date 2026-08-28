# Dual AI Review Loop

这是一个给两个网页 AI 使用的 A/B 审核框架。

- **A = Author / Final Owner**：负责初稿、独立核验 B 的意见、决定接受或拒绝、输出最终答案。
- **B = Reviewer / Red Team**：负责找错和提出可追溯证据，但不能成为“事实来源”或直接指挥 A。
- **Controller**：保存原始任务、控制轮次、维护可信 checkpoint，并在持续分歧时停止而不是让 A 被 B 逐轮带偏。

## 设计原则

1. 原始任务和原始资料是不可变的 Source of Truth，每一轮都重新提供给 A/B。
2. B 的 actionable issue 必须包含稳定 `target` 和结构化 `basis(type/locator/evidence)`；没有可定位证据的内容只能放到 uncertainties。
3. A 必须对每条 issue 输出 `ACCEPT / REJECT / PARTIAL`，并提供自己独立核验的结构化 basis。
4. B 的 `suggestion` 和 review summary 不传给 A；A 只看到问题、目标和证据，减少措辞和指令性文本造成的 steering。
5. `REJECT` 或存在 residual dispute 的 `PARTIAL` 不会自动晋升为可信版本。Controller 始终保留最后一个 trusted checkpoint。
6. 同一 `target + basis.type + basis.locator` 的争议如果连续多轮仍 unresolved，返回 `DISAGREEMENT`；返回值中的 `answer` 是最后可信 checkpoint，争议版单独放在 `disputedRevision`。
7. 默认最多 3 轮，硬上限 12；所有轮次参数必须是有限正整数。
8. 浏览器 profile 只用于保存登录认证，不允许默认复用旧对话。A/B 每轮都开启新的 conversation。
9. 浏览器完成判断默认要求站点提供 generation/done 信号；仅文本稳定属于显式 opt-in 的不安全 fallback。
10. 浏览器自动化不绕过验证码、登录验证或网站保护机制。

## 快速开始

```bash
npm install
npx playwright install chromium
cp config/sites.example.json config/sites.json
```

编辑 `config/sites.json`。每个站点至少需要：

- `session.freshConversationUrl` 或 `session.newConversationSelector`
- `selectors.input`
- `selectors.assistantMessage`，应只匹配“一轮一个最终 assistant response container”
- `completion.generatingSelector` 或 `completion.doneSelector`

建议先手动在持久化 browser profile 中完成正常登录；不要把账号、Cookie、Token 或 browser profile 提交到 GitHub。

运行：

```bash
npm start -- \
  --task "检查这份回答是否存在事实或逻辑错误" \
  --source-file ./source.md \
  --sites ./config/sites.json \
  --max-rounds 3 \
  --disagreement-limit 2
```

## B 的输出协议

```json
{
  "status": "REVISE",
  "score": 78,
  "summary": "发现一项需要核对的问题",
  "issues": [
    {
      "id": "B-1",
      "severity": "major",
      "confidence": 0.91,
      "target": "answer:claim-2",
      "claim": "候选答案中的结论与原始资料冲突",
      "basis": {
        "type": "source",
        "locator": "source:p2",
        "evidence": "第 2 段明确限定了条件 X"
      },
      "suggestion": "重新核对条件 X"
    }
  ],
  "uncertainties": []
}
```

同一实质问题跨轮次必须保持相同 `target + basis.type + basis.locator`，即使 claim 改写也会被 Controller 视为同一争议。

## A 的修订协议

```json
{
  "answer": "新的完整答案",
  "decisions": [
    {
      "issueId": "B-1",
      "verdict": "REJECT",
      "reason": "B 忽略了前置条件",
      "basis": {
        "type": "source",
        "locator": "source:p2",
        "evidence": "第 2 段保留该前置条件"
      },
      "residualDispute": true
    }
  ]
}
```

`PARTIAL` 还必须提供 `acceptedPart` 和 `rejectedPart`。存在 residual dispute 的版本会被记录，但不会自动成为 trusted checkpoint。

## 状态结果

- `PASS`：B 明确通过当前候选答案。
- `DISAGREEMENT`：同类 grounded issue 连续 unresolved。`answer` 返回最后可信 checkpoint，`disputedRevision` 单独提供。
- `MAX_ROUNDS`：达到轮次上限。`answer` 仍返回最后可信 checkpoint；最新未解决候选可能出现在 `candidate`。

## 浏览器传输安全

持久化 profile 仅用于认证。`startSession()` 每次创建新 page，并要求通过“新会话 URL”或“New Chat 按钮”建立新的 conversation。

完成判断优先使用：

1. `completion.generatingSelector`：生成期间可见，结束后隐藏；
2. `completion.doneSelector`：最终 response 内出现完成标记；
3. `allowStabilityFallback=true`：仅在没有更可靠信号时显式开启。

如果一个站点会为同一回答生成多个 assistant DOM 节点，应把 `selectors.assistantMessage` 改成只匹配最终 response container；默认发现一轮新增多个节点会 fail closed。

## 后续 B 审核

B 可以直接审核 Draft PR。A 会读取 GitHub Review 并逐条形成 ACCEPT / REJECT / PARTIAL，不需要人工复制审核内容。
