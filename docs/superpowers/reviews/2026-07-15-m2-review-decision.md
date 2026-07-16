# M2 里程碑评审终审决议

日期:2026-07-15
输入:Fable 5 视觉签核(实机)、opus-4.8(有条件通过,7 条)、fable-5 第二路(不通过,3 高 8 中 6 低;因 codex 额度临时耗尽顶班,codex 已恢复)
终审(Fable 5)结论:**不通过,开 M2.1。** 三方在"托盘泄答案"上完全一致;fable-5 路补齐了健壮性与语义层的关键缺陷。

## 产品裁决(三项,计入教师决策日志)

1. **角色指认交给学生**:托盘与画布一律中性物理命名(导体棒 A/B、金属连接件、可导电液体、容器、蔗糖水、绝缘连接件),无"干扰项"标签、无功能角色名;学生放置电极/连接件后在画布节点上**主动指认**功能角色(下拉,选项=拓扑引擎白名单)。四要素得分口径 = 指认正确 + 连接成立。这是前测"测选择与建构"的成立前提。
2. **拓扑实时预览只报连通性**(闭合/悬空),不报角色有效性——否则预览会替学生排除蔗糖水,D3-M2 永远测不到。预览复用 shared/scoring/topology 的路径算法,禁止口径漂移。
3. **前测阶段关闭即时对错反馈**(含答对电子流动效):诊断性测验不逐题给答案,完成整卷后统一出诊断,防重测背答案。电子流答对反馈保留给模块二训练场景。

## M2.1 修复清单

**高**
1. 托盘/画布中性命名+删"干扰项"标签(用 config label,presentation 层角色名映射删除);回归断言:builder DOM 不得出现 干扰|distractor|失电子场所|得电子场所|电子导体|离子导体 字样。(三方一致)
2. 学生角色指认 UI + assignedRole 真实来源改为学生声明(引擎白名单校验已支持);更新 topology evidence 文案与四要素口径。(opus C/fable H2/裁决 1)
3. 草稿与导入健壮性:loadDraft 按当前 config 过滤未知 componentId 及其连线;渲染跳过未知定义;补顶层 ErrorBoundary;导入时跑 buildLearnerProfile 深校验,失败拒绝导入并给中文提示。(fable H3/M5)

**中**
4. 判分信息不出服务端:选择题判分下沉服务端路由(与 extract 同模式);/api/config 下发前剥离 correct/misconceptionIds/answerGuidance/distractor.reason 等判分字段。(opus D/fable M1)
5. needs-review 第四种卡片状态("已作答,待教师复核"),不得冒充"未测到"。(fable M2)
6. 雷达图未测维度:灰色缺省标记,不画 0。(fable M3)
7. /api/assessment/extract 路由收 targetNodeIds 数组一次提交;客户端 AbortController 超时+明确重试语义(部分失败不重复记 attempt)。(fable M4)
8. localStorage:save 失败捕获并降级提示"请导出会话";版本不匹配搁置旧会话而非删除。(fable M6)
9. dev 模式令牌链路修通(Vite dev 下 token 注入);手绘 provider/mode 由服务端按部署模式决定,mock 输出加"演示占位"标记。(fable M8/opus F)

**低(一并处理)**
10. 题干排版改 body 字体(--text-lg),display 宋体仅留模块标题(Fable 5 视觉签核);容器缩略图需空烧杯素材(按 STYLE.md 生成 beaker-empty@2x,机检+签核流程)。
11. QuestionCard 维度名查 knowledgeModel 映射(device 误标"能量"bug);两选项≠判断题。
12. 组件/连线数量上限(防超大图冻结)。
13. caseId 统一为 'pretest';mergeServerSession 的 updatedAt 取 max;ZodError 转中文;雷达容器 ResizeObserver 挂载修正;电子流进度状态全局化;测试断言随 1/2 更新;字体 family 命名注释澄清。

M2.1 完成后:Fable 5 复跑视觉签核(重点:角色指认交互、needs-review 卡、无泄漏断言)→ 跨家复核 → 合并。

## M2.1 视觉复检(2026-07-15,Fable 5)

实机复检通过:托盘/画布全部中性命名,干扰项无标签混入;学生角色指认下拉(功能=不指定默认/材料)落地;空烧杯素材上岗(Batch 3 签核);焦点环 token 生效。备注:搭建器任务说明保留 display 宋体(裁定按模块任务标题处理);题目页题干字体待 M3 轮全流程抽验。待跨家复核后合并。
