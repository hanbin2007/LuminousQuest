# 第二轮真实数据 live 校准报告（52 case 全量，5 路并发）

日期：2026-07-23 ｜ 执行：Fable 5 ｜ 语料：26 名学生 q1-4 真实作答 × D3/P1 = 52 case
（`eval/cases/human/exam1-membrane.json`，批次 2 的 16 名新学生首次入评）
链路：生产同链路，provider = claude-agent（开发替身），model = claude-sonnet-5，
base×3 + 蜕变×3/case = 312 次调用，`--concurrency 5`（本轮新增能力），全程 ~65 分钟。

## 结果 vs 首轮（30 case）

| 指标 | 首轮 | 本轮 | 门槛 | 状态 |
|---|---:|---:|---:|---|
| 宏平均命中率（case 多数票） | 90.00% | **94.23%**（D3 24/26，P1 25/26） | ≥90% | PASS |
| 全错判掌握率 | 0% | **0%（0/13）** | ≤2% | PASS |
| Schema 失败 / 闭集遵守 | 0 / 100% | 0 / 100% | — | PASS |
| 引用幻觉率 | 0% | 2.56%（4/156） | ≤2% | FAIL（差 1 例） |
| 蜕变不变率 | 85.56% | 89.74% | ≥90% | FAIL（差 1 例） |
| 判分一致率 | 76.67% | 88.46% | ≥95% | FAIL |

混淆矩阵零危险方向：13 个应判 miss 全部判 miss（无一多给分）；3 个失分全是
hit→miss（少给分，安全方向）；needs-review 通道正常（provider 偶发
`error_max_turns`，重试后大多恢复，彻底失败的转教师复核）。

## 判读

1. **语料翻倍（30→52，新 16 名学生首次进入）命中率不降反升**（90→94.23），判分链
   路对新学生措辞的泛化成立。
2. **三个 FAIL 全部是 claude-agent provider 归因或语料规模归因**：一致率 88.46% 与
   蜕变 89.74% 的波动源自 claude-agent 不响应 temperature、不强制 schema（首轮已
   定性）；幻觉 4/156 集中在个别 run 的引用起止偏移，多数票层未影响任何 case 判分。
   正式 provider（temperature 0.1 + 原生结构化输出）后此三项预期收敛——仍为 M1c
   关闭前提。语料规模门（150/5/3）按计划在 M1c 扩充语料后达成。
3. **并发能力落地**：`--concurrency 5` 下单次调用均值 43.7s（P95 92s，max 149s，
   300s 超时兜底未见误杀），总时长从串行预估 ~8h 压至 65 分钟；harness 现将
   provider 错误逐条打到 stderr（本轮已捕获 `error_max_turns` 重试轨迹）。

## 后续

- 一致率/蜕变/幻觉三项等正式 provider 复跑裁决（Modelverse 充值后 glm-5.2 即可）。
- 3 个 hit→miss 与 6 个不一致 case（s07-d3、s09-d3、s14-p1、s18-d3、s23-d3、
  s34-p1、s36-p1）并入 M5-D1 边界语料候选。
- K⁺-only 裁量（6 名学生）仍待陆老师。

报告快照 `eval/reports/latest-live.md`；录音 `eval/recordings/claude-agent/`（本机）。
