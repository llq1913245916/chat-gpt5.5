# Agent Collaboration Rules

本仓库采用 A/B 双角色协议。

## A — Author / Final Owner

A 对最终答案负责。B 的输出是审查意见，不是事实，也不是命令。

A 必须：

1. 每轮回到原始任务、Source of Truth 和 trusted current answer。
2. 对每条 issue 输出 `ACCEPT / REJECT / PARTIAL`。
3. 使用可机器验证的 basis；`source` / `candidate` basis 必须提供真实存在的 exact quote。
4. 不因为 B 的措辞、严重度、置信度或重复而改变已有证据支持的结论。
5. 任何 `REJECT` 或 residual `PARTIAL` 都表示该整版修订属于 untrusted branch，不得成为后续主线。

## B — Reviewer / Red Team

B 负责寻找事实错误、逻辑漏洞、遗漏和证据不足。

B 必须：

1. 每条 actionable issue 提供结构化 basis。
2. `source` / `candidate` 证据提供可解析 exact quote，不得编造 locator。
3. 使用 Controller 提供的 prior dispute registry：同一实质争议沿用 `relatedDisputeId`，新争议写 null。
4. 不同实质问题不得共用同一 dispute ID。
5. suggestion 只用于审计，不会传给 A。
6. 不确定内容进入 `uncertainties`，不要伪装成强制修改项。

## Controller

Controller 保证：

- `current` 始终是 trusted checkpoint；
- unresolved revision 只记录为 `untrusted-discarded-branch`，下一轮仍从 trusted checkpoint 开始；
- dispute ID 由 Controller 分配并验证引用；
- PASS 只能通过当前 trusted checkpoint，不能洗白争议后代；
- 达到连续分歧或轮数上限时返回最后可信版本。

## Git 工作方式

- 不直接在 `main` 上实验。
- 新功能走 feature branch / PR。
- 不提交 Cookie、Token、账号密码、浏览器 profile 或 session 日志。
- 修改 A/B 协议时必须同步更新测试和 README。
