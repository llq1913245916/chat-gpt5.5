# Dual AI Review Loop

这是一个给两个网页 AI 使用的 A/B 审核框架。

- **A = Author / Final Owner**：负责初稿、核验 B 的意见、决定接受或拒绝、输出最终答案。
- **B = Reviewer / Red Team**：负责找错和提出有证据的质疑，但不能直接成为“事实来源”。
- **Controller**：保存原始任务、控制轮次、记录每次决策，并在长期分歧时停止，而不是让 A 被 B 无限带偏。

## 设计原则

1. 原始任务和原始资料是不可变的 Source of Truth，每一轮都重新提供给 A/B。
2. B 的 actionable issue 必须包含证据、严重度和置信度；没有证据的内容只能放到 uncertainties。
3. A 必须对 B 的每条 issue 输出 `ACCEPT / REJECT / PARTIAL` 和理由，不能静默照单全收。
4. 同一类质疑如果被 A 基于原始资料连续拒绝两次，Controller 返回 `DISAGREEMENT`，交给用户或第三个 Judge，而不是继续强迫 A 修改。
5. 默认最多 3 轮；每一版和每一轮审核都可以落盘到 `sessions/`，便于人工比较和回滚。
6. 浏览器自动化只负责“收发消息”，不绕过验证码、登录验证或网站保护机制。

## 结构

```text
.
├── AGENTS.md
├── config/
│   └── sites.example.json
├── prompts/
│   ├── agent-a.md
│   └── reviewer-b.md
├── src/
│   ├── adapters/
│   │   └── playwright-agent.js
│   ├── cli.js
│   ├── controller.js
│   ├── protocol.js
│   └── state-store.js
└── test/
    └── core.test.js
```

## 快速开始

```bash
npm install
npx playwright install chromium
cp config/sites.example.json config/sites.json
```

编辑 `config/sites.json`，填写两个网站的 URL 和选择器。建议先手动在持久化浏览器 profile 中完成正常登录；不要把账号、Cookie、Token 或浏览器 profile 提交到 GitHub。

运行：

```bash
npm start -- \
  --task "检查这份回答是否存在事实或逻辑错误" \
  --source-file ./source.md \
  --sites ./config/sites.json \
  --max-rounds 3
```

如果没有原始资料，可以省略 `--source-file`，但涉及事实核验时最好提供 Source of Truth。

## B 的输出协议

B 必须返回 JSON：

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
      "claim": "候选答案中的结论与原始资料冲突",
      "evidence": "原始资料第 2 段明确限定了条件 X",
      "suggestion": "重新核对条件 X，不要直接把结论改成我给出的版本"
    }
  ],
  "uncertainties": []
}
```

完全通过时：

```json
{
  "status": "PASS",
  "score": 95,
  "summary": "未发现需要修改的可验证问题",
  "issues": [],
  "uncertainties": []
}
```

## A 的修订协议

收到 B 的意见后，A 返回 JSON：

```json
{
  "answer": "新的完整答案",
  "decisions": [
    {
      "issueId": "B-1",
      "verdict": "REJECT",
      "reason": "B 的判断忽略了原始资料中的前置条件",
      "sourceBasis": "原始资料第 2 段"
    }
  ]
}
```

A 必须覆盖 B 的每条 actionable issue。`REJECT` 是正常结果，不代表流程失败。

## 状态结果

Controller 可能返回：

- `PASS`：B 明确通过。
- `DISAGREEMENT`：同类问题反复出现且 A 基于 Source of Truth 拒绝，建议人工/第三 Judge 裁决。
- `MAX_ROUNDS`：达到轮次上限，保留最后版本和完整历史。

## 后续接入 B

后续 B 只需要遵循 `prompts/reviewer-b.md` 和上述 JSON schema。若 B 使用另一个网页 AI，只需在 `config/sites.json` 中补齐 `b` 的 URL 与 selectors；核心 Controller 不需要改。
