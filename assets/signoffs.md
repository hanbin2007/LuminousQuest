# 素材批次签核记录

## Batch 1(试产,2026-07-15)—— ✅ 通过(Fable 5)

范围:electrode-carbon / electrode-zinc / beaker-electrolyte / salt-bridge / ammeter(各 @2x)
Checklist:透明底✅ 色板✅ 描边一致✅ 造型语言一致✅ 无文字/箭头/阴影✅ 机检✅ 纸白合成✅

批量注记(后续批次执行):
1. 溶液校青偏淡:不透明度取规范上限 35%,再深一档。
2. 电流表表盘左上有轻微噪点,批量注意 alpha/噪点清理。
3. 电极顶部蓝色接线柱造型定为全系电极统一接口语义。
4. 本批 5 件中 beaker-electrolyte 指定为后续批次的 style anchor 参考图。

## Batch 2(2026-07-15)—— ✅ 有条件通过(Fable 5)

范围:组件 8 件(copper/aluminum/porous-carbon/gas-tube/bulb/membrane/wire/sucrose-beaker)+ 案例图 6 张。机检 14/14 PASS(校青 34.9% 达注记要求,蔗糖水零校青像素)。
**组件 8 件全部通过**;案例图 3 张通过(zinc-copper 构图与化学正确性优秀、aluminum-air/hydrogen-oxygen 剖面合格),3 项修图(Batch 2R):

1. **zinc-copper/schematic**:CuSO₄ 侧溶液按化学事实着稀蓝(新增色板条目 CuSO₄ 蓝 #8FBBE8)——"物质存在形式/颜色"本身是 P3/P5 考点,双杯同色丢失教学信息。
2. **hydrogen-oxygen、methane-fuel、aluminum-air 三张 schematic**:灯泡底座为铜橙,与 zinc-copper(蓝)不一致——统一为蓝色接口语义。
3. **aluminum-air/schematic**:右上空气管管口与气泡画在罐体之外,易误读为漏气;改为管口朝向正极区域、气泡置于液内管口下方(或去除罐外气泡)。

注记:methane-fuel 图的产物表达(CO₂ 逸出+膜)隐含酸性/质子膜介质——M3 编写 methane-fuel.json 时介质必须定为 acidic,否则需改图(碱性介质 CO₂ 被吸收不得冒泡,经典考点)。CH₄ 用铜橙气泡与 O₂ 白泡区分,批准为气体区分惯例并沿用。

## Batch 2R(修图,2026-07-15)—— ✅ 通过(Fable 5)

三条修图意见全部落实:zinc-copper 双杯溶液分色(ZnSO₄ 校青/CuSO₄ 稀蓝 #8FBBE8);三张图灯泡底座统一蓝色接口;aluminum-air 空气管管口入液、气泡液内朝正极,罐外气泡移除。机检通过。案例图 6/6 全部签核完毕,素材生产阶段(组件 13 + 案例图 6)完成。

## Batch 3(beaker-empty,2026-07-15)—— ✅ 通过(Fable 5)
空烧杯组件:无液面线(与蔗糖水区分成立)、透明底、风格与 anchor 一致、机检通过。

## Batch 4(工作台半写实重画,2026-07-17)—— ✅ 通过(Fable 5)

范围:工作台 8 精灵(electrode-carbon/electrode-zinc/copper/wire/insulated-wire/beaker-empty/beaker-electrolyte/sucrose-beaker),按 STYLE.md §8(v1.3)整批重画,替换简笔画版本。绘制:codex(gpt-5.6-sol,xhigh)。

v1.3 Checklist(§8.5):
1. 尺寸机检 8/8 PASS(108×504 / 450×210 / 630×780),透明底、alpha 边缘干净 ✅
2. 几何契约实测:液体像素 12.1%/32.1%/87.9%/96.9%,电极主体宽 92.6%、底缘 95.6%——全部在 ±2% 容差内 ✅
3. 质感:金属多段渐变有体积、玻璃透(沿口双线/尖嘴/高光带/蚀刻刻度)、液体半透明渐变+弯月面 ✅
4. wire(校深蓝光泽)与 insulated-wire(深灰哑光+绝缘护套)托盘缩略图一眼可辨 ✅
5. 深灰画布(#42474d)与纸白托盘双底色合成均成立 ✅
6. 浸没实测:双电极入 electrolyte 池,裁剪线与位图液面严丝合缝,液下透青色 ✅

注记:sucrose-beaker 与 beaker-empty 在 64px 缩略图下仅靠糖粒堆区分,依赖托盘文字标签兜底——接受(器材库始终带标签)。447/447 测试、typecheck、build 全绿。
