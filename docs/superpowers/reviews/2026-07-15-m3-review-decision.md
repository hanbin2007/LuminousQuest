# M3 里程碑评审终审决议

日期:2026-07-15
输入:Fable 5 视觉走查(通过,1 文案项)、opus-4.8(通过含须修订,2 中 3 低)、gpt-5.6-sol max(不通过,2 阻断 6 高 4 中)
终审(Fable 5)结论:**不通过,开 M3.1。** opus 验证了化学与状态机的正确面(甲烷三式守恒、GCD 规范化、脚手架 §13/§15/§16 行为测试),codex 的判分完整性与证据忠实性指控成立。

## 裁决

- **量表阈值恢复 0.60**:AC2 演示性修改(0.6→0.61)不留在生产配置;git 历史中的 7e9fd74 已足以作证据。裁量表维持 0.60;测试断言单一值;另在测试本地配置中补"0.60/0.61 边界行为翻转"测试,把"改配置→行为变"闭环补上(opus#2)。
- **辅导阶段绑定为服务端硬保证**:tutor 路由校验作答所属 stage,pretest 与 transfer 一律拒绝(codex#7+opus#3)。
- **素材递进配置化**:cases 配置增加剖面揭示条件(如完成 P2/P3 后解锁),默认按配置驱动而非入场即开(codex#10)。
- **对比雷达沿用诊断雷达语言**:三维度色轴、unassessed 灰色缺测、按阈值显示等级(codex#11,视觉负责人采纳)。

## M3.1 修复清单

**阻断**
1. 方程判分复合化:三道方程题(负/正/总)证据分别保留,案例级复合判定——P6 须两条半反应均衡且电子配平,P7 专属总反应,总式空答/解析失败记 P7;回归测试:"错一极,其余正确,不得整体通过"。(codex#1)
2. AC2 测试忠实化:三个真实基线案例;逐字使用提交 7e9fd74 的甲烷 JSON;经冻结客户端 defaultRuntime 请求同一 Hono 实例;方程判分走真实 /api 路由,断言新增等价式及倍数式 hit、近似错误式 miss。(codex#2/#3)

**高**
3. AC2 证据可独立验证:冻结提交内含 dist 逐文件 SHA-256 manifest;配置提交后保存比较日志;更新证据文档。(codex#4)
4. 甲烷别名表补齐:methane-Pt/CO2+H2O/methane-side/oxygen-side 四组中英文与化学式别名;D1/P4/P5/极性锚点的真实中文引用校验测试。(codex#5)
5. evaluateCasePass 接入 UI:过关判定控制进入下一案例;scaffold history 按 case/attempt 去重,幂等重试不得增加连击。(codex#6)
6. 辅导阶段服务端绑定(见裁决)。(codex#7+opus#3)
7. 量表阈值恢复 0.60 + 边界行为测试(见裁决)。(codex#8+opus#2)

**中**
8. tutor UI 消费 finalRound/terminal:终止后隐藏入口直接呈现 closing;按真实 source 区分回放降级与预设回退。(codex#9)
9. 素材递进配置化(见裁决)。(codex#10)
10. 对比雷达视觉统一(见裁决)。(codex#11)
11. 真实 e2e:前测→训练→冷迁移全路由真实判分链;UI 故障用例消费实际服务端故障响应矩阵(schema-invalid/replay-missing 等)。(codex#12)
12. medium 枚举→中文映射(acidic 酸性介质/alkaline 碱性介质/neutral 中性介质/molten 熔融),消除素材图注英文裸串。(Fable 5+opus#1)

**低**
13. 公开视图泄漏断言改白名单键集(或递归扫描),fixture 补 transfer 案例覆盖 followingAnchors。(opus#4)
14. 取最新事件统一按 sequence 比较(transfer-comparison 与 scaffold-adapter 口径一致)。(opus#5)
