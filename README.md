# Dual AI Review Loop

这是一个给两个网页 AI 使用的 A/B 审核框架，目标是让 A 能利用 B 的审查能力，同时防止 A 被 B 的重复意见、错误证据或会话残留带偏。

- **A = Author / Final Owner**：负责初稿、独立核验 B 的意见、决定接受/拒绝、输出答案。
- **B = Reviewer / Red Team**：负责找错和提出有证据的质疑，但不是事实来源。
- **Controller**：维护 Source of Truth、可信主线、争议分支、稳定 dispute ID、轮次和审计历史。

## 核心安全不变量

1. 原始任务和 Source of Truth 每轮重新提供，且不被 B 改写。
2. **`current` 永远是 trusted checkpoint。**
3. 只要 A 对任一 issue 给出 `REJECT`，或 `PARTIAL + residualDispute=true`，该整版修订都会记录为 `untrusted-discarded-branch`，不会成为下一轮输入。
4. 下一轮 B 始终审核最后可信版本，因此后续 `PASS` 不能把之前的争议改动“洗白”。
5. 同一争议由 Controller 分配 `D-0001` 这类稳定 ID。B 每轮是新会话，但会收到 prior dispute registry；同一实质争议必须用 `relatedDisputeId` 关联。
6. `source` / `candidate` 证据必须附带可在实际输入中解析到的 exact `quote`。伪造 locator 或不存在的 quote 会被协议拒绝。
7. 默认最多 3 轮，硬上限 12；连续未解决达到阈值后返回 `DISAGREEMENT` 和最后可信版本。

## 结构

```text
.
├── AGENTS.md
├── config/sites.example.json
├── prompts/
│   ├── agent-a.md
│   └── reviewer-b.md
├── src/
│   ├── adapters/playwright-agent.js
│   ├── cli.js
│   ├── controller.js
│   ├── protocol.js
│   └── state-store.js
└── test/
    ├── core.test.js
    └── transport.test.js
```

## 快速开始

```bash
npm install
npx playwright install chromium
cp config/sites.example.json config/sites.json
```

编辑 `config/sites.json`，为 A/B 网站配置：

- 登录 profile；
- 新对话入口（`freshConversationUrl` 或 `newConversationSelector`）；
- 输入框和 assistant response 容器；
- **权威的生成完成信号**（推荐 `doneSelector`，或可靠的 `generatingSelector`）。

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

示例：

```json
{
  "status": "REVISE",
  "score": 78,
  "summary": "发现一项需要核对的问题",
  "issues": [
    {
      "id": "B-1",
      "relatedDisputeId": null,
      "severity": "major",
      "confidence": 0.91,
      "target": "answer:claim-1",
      "claim": "候选答案中的结论与原始资料冲突",
      "basis": {
        "type": "source",
        "locator": "source:paragraph-2",
        "quote": "原始资料中必须真实存在的逐字片段",
        "evidence": "说明这段引用为什么支持该质疑"
      },
      "suggestion": "重新核对条件"
    }
  ],
  "uncertainties": []
}
```

同一实质争议在后续轮次必须引用 Controller 提供的 `relatedDisputeId`，即使答案段落移动或措辞变化。不同实质问题不得共用同一 dispute ID。

## A 的修订协议

A 收到的是过滤后的 review data：不会看到 B 的 `suggestion`、summary、severity 或 confidence，只看到问题、稳定 dispute ID 和可核验 basis。

```json
{
  "answer": "新的完整答案",
  "decisions": [
    {
      "issueId": "B-1",
      "verdict": "REJECT",
      "reason": "重新核验后，该质疑与原始资料冲突",
      "basis": {
        "type": "source",
        "locator": "source:paragraph-2",
        "quote": "原始资料中真实存在的逐字片段",
        "evidence": "该片段支持 A 的裁决"
      },
      "residualDispute": true
    }
  ]
}
```

`PARTIAL` 还必须包含 `acceptedPart` 和 `rejectedPart`，并保持 `residualDispute=true`。

## 可信主线与争议分支

如果一轮包含 unresolved decision：

```text
trusted v1
   |
   +--> disputed v2 (discarded/untrusted)
   |
   +--> 下一轮仍从 trusted v1 开始
```

如果下一轮 B 对 `trusted v1` 返回 PASS，最终答案仍是 `trusted v1`，而不是 disputed v2。

如果所有 issue 都被 A `ACCEPT` 并完成修订，则新版本才会升级为新的 trusted checkpoint。

## 浏览器传输层

Playwright profile 只用于保留登录状态，不代表复用聊天上下文。每个 A draft/revision 和每个 B review 都会新开对话。

生成完成默认 fail-closed：

- `doneSelector`：推荐，必须在本轮 response 容器内出现；
- `generatingSelector`：必须先观察到 visible，再等待 hidden；
- 如果连 generation-start 都没观察到，默认直接报错；
- 只有显式开启 `allowMissingGenerationStart + allowStabilityFallback` 才允许降级到文本稳定判断，此模式属于不安全 fallback。

默认还要求每次发送只产生一个匹配 `assistantMessage` 的最终 response container；出现多节点会报错而不是猜测。

## 状态结果

- `PASS`：B 对当前 trusted checkpoint 明确通过。
- `DISAGREEMENT`：同一 controller-managed dispute 连续未解决；返回最后可信版本，并单独暴露 disputed revision。
- `MAX_ROUNDS`：达到上限；仍返回最后可信版本。

## 测试覆盖

当前回归测试覆盖：

- 不存在的 source/candidate quote；
- B suggestion/summary/severity/confidence 不传给 A；
- `REJECT + drift -> 下一轮 PASS` 不得洗白；
- 旧争议消失 + 新问题 ACCEPT 不得继承争议分支；
- 位置/locator 改变但 `relatedDisputeId` 相同仍能连续跟踪；
- 相同 target/locator 的不同问题不会自动合并；
- unknown dispute ID；
- repeated PARTIAL；
- 非法轮数；
- 会话隔离配置；
- generatingSelector 未观察到 start 时 fail-closed；
- 多 assistant node 拒绝猜测。
