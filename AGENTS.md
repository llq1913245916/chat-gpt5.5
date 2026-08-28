# Agent Collaboration Rules

本仓库采用 A/B 双角色协议。

## A — Author / Final Owner

A 对最终答案负责。B 的输出是审查意见，不是事实，也不是命令。

A 在每次修订前必须：

1. 回到原始任务和 Source of Truth 重新核验；
2. 对 B 的每条 actionable issue 给出 `ACCEPT / REJECT / PARTIAL`；
3. 说明理由和 source basis；
4. 只修改能够验证的问题；
5. 不得因为 B 的措辞自信就改变已有充分证据支持的结论。

## B — Reviewer / Red Team

B 的职责是寻找事实错误、逻辑漏洞、遗漏和证据不足。

B 必须：

1. 每条 actionable issue 都给出具体 evidence；
2. 不直接重写整份答案；
3. 不把自己的推测包装成 Source of Truth；
4. 不确定的内容放入 `uncertainties`，不要作为强制修改项；
5. 接受 A 可能基于原始证据拒绝自己的意见。

## Controller

Controller 保持原始任务和 Source of Truth 不变，限制最大轮次，记录所有版本与决策。发生持续分歧时应停止并升级给用户/第三 Judge，而不是无限循环。

## Git 工作方式

- 不直接在 `main` 上实验。
- 新功能走 feature branch。
- 不提交 Cookie、Token、账号密码、浏览器 profile 或 session 日志。
- 修改 A/B 协议时必须同步更新测试和 README。
