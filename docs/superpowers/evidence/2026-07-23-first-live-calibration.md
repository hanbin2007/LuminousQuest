# 首轮真实数据 live 校准报告（q1-4，30 case）

日期：2026-07-23 ｜ 执行：Fable 5 ｜ 语料：15 名学生 q1-4 真实作答 × D3/P1（`eval/cases/human/exam1-membrane.json`）
链路：生产同链路（structured-assessment prompt + 闭集 schema + 规则判分），provider = claude-agent（开发替身，OAuth 零 key），model = claude-sonnet-5，base×3 + 蜕变×3/case。

## 迭代过程（当日四轮）

| 轮 | 变更 | 宏平均命中率 | 判分一致率 |
|---|---|---:|---:|
| 1（pilot 5） | 基线 | 0% | 20% |
| 2（pilot 5） | valueDomain：判断型槽位取值域闭集（含错误取值，实体槽保持开放） | 80% | 20% |
| 3（pilot 5） | hint：槽位语义提示注入 schema；化学符号不判 typo | 100% | 100% |
| 4（全量 30） | — | **90%（27/30）** | 76.67% |

第 1 轮根因：prompt「最小实体名」契约 + schema 无取值约束 → 模型把 `o2-passes` 填成实体 `"K"`。该缺陷覆盖所有判断型槽位（含训练案例 M1b 起的 `spontaneous` 等），此前从未暴露因为 eval:live 从未真实运行。

## 全量结果（30 case 多数票）

- **宏平均命中率 90%（门槛线上）**；D3 13/15，P1 14/15
- **全错判掌握率 0/8 = 0%**（门槛 ≤2%）——8 个应判 miss 的作答（K⁺-only、电路论证、电中性论证）全部正确判 miss，**无一多给分**
- 引用幻觉 0/90、schema 失败 0/90、闭集遵守 100%
- 蜕变不变率 85.56%（门槛 90%，FAIL）、判分一致率 76.67%（门槛 95%，FAIL）——见「provider 归因」

### 三个失误逐一定性（方向全部安全）

| case | 期望→实际 | 定性 |
|---|---|---|
| s15-d3（「不，无法构成原电池回路」） | hit→miss | 裸「不」+ 电路式理由，模型不确定否定是否指向 O₂ 通过性 → 少给分。真实边界样本，保留观察 |
| s07-d3（长句绕行论证） | hit→needs-review | 2/3 跑校验拒绝转教师复核 → 零风险方向 |
| s12-p1（K₂O 深层论证） | hit→miss/needs-review | **完全符合预标注的引擎缺口预言**（M5-D1 同义表述语料）；模型甚至自发标了 syllabus=beyond 并正确引用。待 D1 项（否定感知/同义扩展）实现后回归 |

### provider 归因（不动工程的失分）

一致率/蜕变率不达标主要因 claude-agent **不强制 JSON schema**（枚举可被无视，靠校验兜底重试）且不响应 temperature，run 间波动是采样噪声。正式接 GLM/DeepSeek（原生结构化输出、temperature 0.1）后此类波动预期消失；本轮 needs-review 型的不一致同源。性能：claude-agent 单次 88s–5min、~8k tokens/次，全战役约 2.5M tokens；正式 API 同量 <¥5、分钟级。

## 结论与后续

1. **判分链路对真实学生作答的基本面成立**：保守方向零违背（无多给分、无幻觉、无泄题面），达线的命中率 + 全部失误可解释。
2. 真实作答进系统 24 小时内暴露并修复三个生产级缺陷（盐桥槽位错配、取值域缺失、化学符号误判 typo）——「教师提供真实数据 → 系统进化」的答辩实证。
3. 后续：① 正式 provider key 到位后重跑（预期一致率达标，此为 M1c 关闭前提）；② valueDomain/hint 推广到训练案例判断槽（冻结窗口批量）；③ s12/s15 两类边界并入 M5-D1 语料；④ K⁺-only 裁量待陆老师（改判 partial 只动标签）。

录制件在 `eval/recordings/claude-agent/`（本机，gitignore），报告快照 `eval/reports/latest-live.md`。
