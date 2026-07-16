# M4 里程碑评审终审决议

日期:2026-07-16
输入:opus-4.8(有条件通过,2 高 2 中 4 低)、gpt-5.6-sol max(不通过,3 阻断 + 多高)
终审(Fable 5)结论:**不通过,开 M4.1,双线分修。** codex 实测复现的 executionMode 信任漏洞与"手册照稿点不下去"成立;两评审在冻结物陈旧、手册与 UI 矛盾上完全一致(合流教训:改代码必须同步改"关于代码的承诺"——冻结物与手册今后列入合并 checklist)。

## 裁决

1. **执行模式服务端唯一**:/api/llm 及一切 LLM 入口强制使用全局 workflow.executionMode,demo 下覆盖/拒绝请求声明;为 chat/vision/structured 全入口加 provider-spy 测试。(阻断)
2. **冻结物在最终 HEAD 重做**:完整打包+签名+双 manifest;RELEASE.json 增加 sourceCommit 并校验 === HEAD;shasum -c 实测通过后才准写入手册。(阻断)
3. **演示起点版本化**:demo 一键装载完整 UI 起点(含训练反馈轮次/页面状态,或由会话推导);新增"按手册逐字点击"的端到端测试;手册 /model 段落、Q7、证据索引改述为 3D 实装。(阻断)
4. demo 会话不得覆盖 latest;原会话/模式持久化可恢复,补刷新恢复测试。(高)
5. 红队手绘用例用真实含隐藏文字 PNG;手绘点评响应改结构化 schema(仅 comment 字段,不可能含评分),替代关键词黑名单;三类对抗变体进 eval。(高)
6. 教师视图 AC3:分数为可聚焦入口,证据保留 start/end 并高亮区间;错误率与误区 TopN 共享 profile 选中的同一评分事件(profile 增暴露 selectedAssessment,additive)。(高)
7. AC6 统计单位裁决为**学生**:按匿名 ID 合并(取最新会话),均值/错误率/人数/误区全部同口径;文案一致。(中)
8. 班级导入:文件数/大小上限、Promise.allSettled 逐文件反馈;错误提示不回显原文件名与 session ID(匿名批次序号)。(中)
9. 班级演示会话(≥3 份匿名)打进 recordings/demo/class/ 并纳入 manifest 与点击脚本。(高)
10. 演示会话与教师 fixture 的 id 撞车分离。(低)

## 3D 实装修复(Fable 5 亲自)

A. lighting.ts:节点维度采用 profile 裁量结果(policyDimension 输出);边遍历 knowledgeModel.edges(保留 kind/crossAxisNodeIds,如无该结构则维持 dependsOn 但读裁量后的维度);点亮顺序与点亮状态同源(profile 暴露 selectedAssessment.sequence,additive 变更)。
B. KnowledgeScene:全部 CanvasTexture/BufferGeometry memoize + cleanup dispose;useFrame 零分配;拖拽-点击位移阈值;reduced-motion 停止一切周期动画(呼吸/脉冲取稳态);ModelPage 的 scene 按 [session, config] memoize。
C. 可达性:常驻可聚焦节点清单(与 3D 选中双向同步),Canvas aria-hidden;键盘可选。

## 分工

- 交付线修复(裁决 1-10):codex(worktree 分支 codex/m4-fixes,自 fable/m4-3d HEAD)。
- 3D 修复(A/B/C):Fable 5 于 fable/m4-3d。
- 完成后合流 → 复核 → 里程碑终审(gpt-5.6-sol max + fable-5 双报告)。
