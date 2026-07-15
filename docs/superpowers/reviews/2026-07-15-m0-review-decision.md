# M0 里程碑评审终审决议

日期:2026-07-15
输入:opus-4.8(有条件通过,4 中 6 低)、gpt-5.6-sol max(不通过,8 高 7 中)
终审(Fable 5)结论:**有条件通过——技术发现大部分成立,开 M0.1 修复;codex"不通过"的首要理由被驳回。**

## 裁决要点

- **驳回 codex #1(Windows/门禁未完成故 M0 不通过)**:provider 门禁(等 API key)、Windows 真机实测(等设备)、3D spike(Fable 5)是计划 v2 中显式后置的外部依赖项,不构成 M0 代码验收的阻断;保留为 M0 最终关闭的前置条件。
- **采纳 codex 的 7 项高危技术发现**:configVersion 应服务器派生并强制注入(客户端可声明旧版本命中陈旧缓存,真 bug);演示回放需启动期版本比对告警+schema 校验;演示模式 cache miss 不得触发真实 provider;外置 prompts/assets 未被服务(违背架构裁决);/api/llm 需防跨站(令牌+Content-Type+体积限制);config schema 需 strict+跨引用+边界校验;recordings/cache 需 gitignore 并区分可分发录制。
- **采纳 opus 独有发现**:脱敏不得作用于 response 主体(损坏回放语义);session 事件 schema 需在冻结前支持逐阶段状态机与 needs-review(否则 M1b 被迫破冻结);安全关键行为(穿越/绑定/交叉引用)需测试锁定;structured() 需 vision 能力门禁(两家评审均中)。
- **按比例简化**:PII 全量扫描 → 缓存与可分发录制分目录+gitignore+打包前人工审计;速率限制 → 仅令牌+同源+大小限制(本机单用户)。
- 中低项(TOCTOU 重试、写盘解耦、tmp 随机后缀、重试短路、错误文案泛化、O(n²)、restoreLatest 真实测试、mock 局限注记)全部进 M0.1。

M0.1 完成并回归通过后,M0 关闭(Windows 实测与 provider 门禁除外,挂起至外部依赖到位),M1a 即可开工。
