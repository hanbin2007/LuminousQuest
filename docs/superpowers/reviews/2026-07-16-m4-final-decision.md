# MVP 里程碑终审决议(M4 关闭裁决)

日期:2026-07-16
输入:fable-5 终审(M4 可关闭+1 必修)、gpt-5.6-sol max 终审(不可关闭,3 阻断)
终审合议(Fable 5 主持):**M4 暂不关闭,开 M4.2 收口轮;M1c 维持独立开放里程碑(外部依赖),不阻塞 M4。** 两腿分歧裁决如下。

## 分歧裁决

1. **判分红线(codex 判 FAIL,fable 判 PASS)——codex 成立。** 抽取 schema 的五个分类字段(response/terminology/contradiction/typo/syllabus)由 LLM 单方声明、未经接地校验,却经 policy 层直接改变 outcome。方向性缓解(无法伪造 hit)降低危害等级,但违反"模型输出必须可验证"的接地原则。**修复:①blank/response 由服务端确定性判定(字符串空/敷衍词表),忽略模型声明;②typo/colloquial/syllabus/contradiction 等不利判定必须附原文引用并通过归一化校验,未接地的不利声明一律降 needs-review 而非直接扣分;③补对抗测试:模型谎报 contradiction 压分→needs-review。**
2. **冻结物契约(两腿一致)。** sourceCommit 鸡生蛋 + gitignore 单机单副本。**修复(冻结协议 v2):①对冻结源提交打 tag(release/m4-rc1 → c20b243);②手册校验口径改为"双 manifest 自洽 + RELEASE.sourceCommit 与 tag 一致",不再与 HEAD 比;③发布物 zip 作为 GitHub Release 资产上传(私有仓库,Fable 5 执行)+ U 盘冷备写入彩排清单。**
3. **M1c 阻断归属**:属 MVP 整体验收(语料 150/5/3+eval:live),不属 M4;维持其独立开放状态。**MVP 整体在 M1c 关闭+AC1 实体彩排完成前不得宣告完成**(两腿一致)。

## M4.2 收口清单

**阻断级**
1. 分类字段接地(裁决 1 方案)。
2. 冻结协议 v2(裁决 2;gh release 上传由 Fable 5 亲自执行)。
3. 测试门禁转绿:m3-real-e2e 的 mkdir/copy 竞态、ac2 的 1 秒 UI 等待脆弱点修复;全套连跑 3 次全绿 + coverage ≥90% 门禁出结果。

**中低**
4. demo 硬锁:LQ_LOCK_DEMO 环境变量/启动参数使 /api/runtime/execution-mode 拒绝切换(403);手册赛前步骤加"锁定演示模式"。
5. teacher-data 直接消费 profile.selectedAssessment,清 TODO。
6. 教师教学决策日志一页汇编(docs/superpowers/specs/2026-07-16-teacher-decision-log.md,汇编裁量表状态/素材签核/量表变更/评审决议索引)。
7. 手册班级导入时间窗与 recordings/demo/README 统一;assets/manifest.draft.json 转正 manifest.json 并同步引用;m4-model-lighting 测试补"维度裁量重映射"断言。

## 关闭条件

M4.2 全部完成 + Fable 5 复验 + 跨家复核通过 → M4 关闭。MVP 状态另行跟踪:M1c(外部)、AC1 彩排(外部)、provider 门禁(外部)。

## M4 关闭(2026-07-16)

M4.2 七项收口全部完成:codex 实现(三连跑 423/423、覆盖率四轴 ≥90%)+ Fable 5 复验(红线对抗测试坐实)+ opus-4.8 跨家复核(逐项真关闭,"M4.2 通过,M4 可关闭")+ GitHub Release 云备份(release/m4-rc1 资产,Fable 5 执行)。**M4 正式关闭。**

MVP 整体开放项(外部依赖):M1c 语料与 eval:live(API key+人工样本)、AC1 实体彩排 ×3(陆老师 Mac)、provider 门禁。非阻断观察:分支覆盖率余量 0.1pp,持续监控。
