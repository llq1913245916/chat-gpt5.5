# Dual AI Review Loop

这是一个面向两个网页 AI 的 A/B 审核框架，目标是让 B 能有效挑错，但不能仅靠措辞、重复、伪证据或错误 dispute 绑定把 A 带偏。

- **A = Author / Final Owner**：生成答案、独立核验审核意见并决定接受/拒绝。
- **B = Reviewer / Red Team**：提出可核验问题，但不是事实来源，也没有最终决策权。
- **Controller**：维护不可变 Source of Truth、可信主线、争议身份、轮次上限和失败关闭规则。

## 核心安全不变量

1. `current` 永远是 trusted checkpoint。包含 `REJECT` 或 residual `PARTIAL` 的 proposed revision 只保存为 `untrusted-discarded-branch`，不会进入下一轮主线，因此后续 `PASS` 不能“洗白”争议后代。
2. B 的 `suggestion / summary / severity / confidence` 不传给 A。A 只看到 issue identity、claim 和机器可检查的 grounding 数据。
3. 每轮最多 8 条 actionable issues；完全重复的 issue 会被协议拒绝，减少重复锚定和 prompt flooding。
4. `source` / `candidate` basis 必须使用机器可解析的行范围 locator：`source:Lx-Ly` / `candidate:Lx-Ly`。exact quote 必须真实出现在该行范围内，不能只是在全文其他位置出现。
5. `logic` 不是绕过 grounding 的通道。actionable logic 必须由 1–4 个 source/candidate grounded premises 推导；每个 premise 都要有行范围 locator + exact quote。无法锚定的外部事实进入 `uncertainties`。
6. Controller 给 unresolved dispute 分配 `D-0001` 形式的 ID。B 若复用 `relatedDisputeId`，必须同时保持 prior registry 中的 target、claim 和 grounding anchors 一致；不兼容的复用自动按新 dispute 处理，不会增加旧 dispute 的 consecutive counter。
7. 同一 mechanically-continuous dispute 连续 unresolved 达到阈值才触发 `DISAGREEMENT`；返回的是最后 trusted answer，而不是争议版。
8. 默认最多 3 轮，硬上限 12；所有轮次参数必须是有限正整数。
9. 浏览器 profile 只用于认证。A/B 每一轮都要求新 conversation；不会默认继承之前 AI 对话上下文。
10. transport 默认 fail closed。generation-start 需要在发送动作之前就被 armed；生成结束后再关联 response 节点。`doneSelector` 也支持 response-scoped 完成标记；文本稳定 fallback 必须显式 opt-in。

## 快速开始

```bash
npm install
npx playwright install chromium
cp config/sites.example.json config/sites.json
```

然后编辑 `config/sites.json`：

- `session.freshConversationUrl` 或 `session.newConversationSelector`
- `selectors.input`
- `selectors.assistantMessage`（一轮应只对应一个 response container）
- `completion.doneSelector` 或 `completion.generatingSelector`

运行：

```bash
npm start -- \
  --task "检查这份回答" \
  --source-file ./source.md \
  --sites ./config/sites.json \
  --max-rounds 3 \
  --disagreement-limit 2
```

## Grounding 协议

Source/candidate basis 示例：

```json
{
  "type": "source",
  "locator": "source:L2-L3",
  "quote": "这里必须是 L2-L3 内真实存在的原文",
  "evidence": "说明这段原文为何支持该审核点"
}
```

Logic basis 示例：

```json
{
  "type": "logic",
  "locator": "logic:step-1",
  "premises": [
    {
      "type": "source",
      "locator": "source:L2",
      "quote": "真实 source quote"
    },
    {
      "type": "candidate",
      "locator": "candidate:L4",
      "quote": "真实 candidate quote"
    }
  ],
  "evidence": "只描述从这些已锚定前提到结论的推导"
}
```

## Dispute identity

Controller 会把 unresolved dispute 以只读 registry 发送给下一轮 B，例如：

```json
{
  "disputeId": "D-0001",
  "target": "answer:claim-1",
  "claim": "canonical dispute claim",
  "basis": {
    "type": "source",
    "locator": "source:L1",
    "quote": "exact quote"
  }
}
```

若同一争议继续出现，B 必须复用同一个 `relatedDisputeId`，同时原样保持 registry 的 target / claim / grounding anchors。若任何一项不同，应设置 `relatedDisputeId=null`。即使 B 错误复用了合法 ID，Controller 发现不兼容后也会重新分配新 ID，而不是误触发 repeated disagreement。

## 状态结果

- `PASS`：B 对当前 trusted checkpoint 没有 actionable issue。
- `DISAGREEMENT`：同一 mechanically-continuous dispute 连续 unresolved；`answer` 返回最后 trusted checkpoint。
- `MAX_ROUNDS`：达到上限；仍返回最后 trusted checkpoint，最新争议分支仅作为单独信息保留。

## 浏览器完成信号

`completion.doneSelector`：response 内的明确完成标记，最容易做 turn-scoped correlation。

`completion.generatingSelector`：全局生成中信号。框架会在发送动作之前 armed `hidden -> visible -> hidden` lifecycle，再等待 assistant response 节点，所以 final-only assistant selector 也不会因为“生成已经结束才开始监听”而误失败。

`allowStabilityFallback=true`：只有你明确接受风险时才启用。

浏览器自动化不会绕过验证码、登录验证或网站保护机制。
