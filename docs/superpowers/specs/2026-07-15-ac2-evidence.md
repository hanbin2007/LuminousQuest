# AC2 配置热加载实测证据（M3.1 复核）

## 结论

M3.1 已用可独立复核的方法重新验证 AC2。历史提交 `7e9fd74` 仍保留“只改配置即可发现
甲烷冷迁移案例并改变阈值行为”的原始证据，但生产阈值已按终审裁决恢复为 `0.60`；
`0.61` 只存在于 git 历史和忠实回放 fixture 中。

原 M3 证据只记录了 `dist/client` 聚合摘要，没有在冻结提交内保存逐文件 manifest，且测试没有
完整经过冻结客户端的真实请求路径，因此不能单独作为验收依据。本文件以下内容取代原验证方法。

## 历史输入忠实性

`tests/m3-ac2-hotload.test.tsx` 不再手写等价配置，而是逐字回放 `7e9fd74`：

- `tests/fixtures/ac2/7e9fd74/methane-fuel.json` 来自
  `git show 7e9fd74:config/cases/methane-fuel.json`。
- `tests/fixtures/ac2/7e9fd74/rubrics.patch` 来自
  `git show --format= 7e9fd74 -- config/rubrics.json`。
- 甲烷 JSON 的 SHA-256 为
  `483b3ecb760e8ddda5dd5d199e2ed9cc3ce1b667821d9f1f598789c6dacb99d9`。
- 测试逐字断言量表补丁，包含历史上的 `0.60 -> 0.61` 变更。

复核命令：

```sh
git show 7e9fd74:config/cases/methane-fuel.json \
  | shasum -a 256
git show --format= 7e9fd74 -- config/rubrics.json \
  | cmp - tests/fixtures/ac2/7e9fd74/rubrics.patch
```

## 升级后的 AC2 回放

自动化用例在一个未重启的 Hono 应用实例上执行以下链路：

1. 写入锌铜、铝空气、氢氧三个真实基线案例，基线阈值固定为 `0.60`。
2. 冻结客户端 `defaultRuntime` 首次请求 `/api/config`，确认只有三个基线案例。
3. 逐字写入历史甲烷 JSON 和量表补丁效果，不重启 Hono、不重建客户端。
4. 同一个 `defaultRuntime` 再次请求同一个 Hono 实例，确认配置摘要变化并发现 transfer 案例。
5. 三个训练案例和甲烷冷迁移的文本判分均经 `/api/assessment/extract`。
6. 负极、正极、总反应式均经真实 `/api/assessment/equation`，不使用伪造运行时判分。
7. 额外断言甲烷等价式和倍数式为 `hit`，近似但不守恒的错误式为 `miss`。

`tests/m3-real-e2e.test.tsx` 另以 `defaultRuntime` 和单个 Hono 实例完成
“前测 -> 三个训练案例 -> 冷迁移”全路由链，并验证服务端会话同时包含
`assessment`、`training`、`transfer` 三个阶段。

## 生产阈值

生产配置通过独立提交恢复：

```text
64112f30629b298a75d7fdd5cb693721fa504d7a
fix(config): 恢复阈值 0.60（AC2 演示改动回滚，证据保留于 git 历史）
```

`tests/m1a-config.test.ts` 只接受单值 `0.60`。边界行为测试使用测试本地配置构造同一
`0.60` 维度得分：阈值 `0.60` 判为 `developing`，阈值 `0.61` 判为 `weak`，不再污染生产配置。

## 冻结产物 Manifest

M3.1 的 manifest 提交为：

```text
99ba7b289e4adcb8ff2eae298b1e126aff43e2f9
build(dist): add client SHA-256 manifest
```

- 构建输入提交：`05882ef8486d4ef3b46c4b423799e112eefc9763`
- 构建命令：`pnpm build`
- 构建结果：Vite `2506` 个模块构建成功，随后 `tsc --noEmit` 通过
- 逐文件 manifest：`dist/client.sha256`
- manifest 文件数：`20`
- manifest 自身 SHA-256：
  `c449bcd94cef649c598b6c36f340289604a53d8c7a1ebaf9280171289e784f3d`
- 配置提交后的逐项比较日志：
  `docs/superpowers/evidence/2026-07-15-m3.1-dist-compare.log`

独立复核命令：

```sh
shasum -a 256 -c dist/client.sha256
```

此命令必须得到 `20/20` 个 `OK`。今后的冻结类提交必须在同一冻结提交中包含对应的
`dist` 逐文件 SHA-256 manifest；仅记录聚合摘要不再视为可独立验证。

## M3.1 验证结果

- `pnpm test`：`40` 个测试文件、`388/388` 测试通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `shasum -a 256 -c dist/client.sha256`：`20/20` 通过。
- AC2 忠实回放：同一 Hono、冻结 `defaultRuntime`、三个真实基线、逐字历史 fixture、真实方程路由。
- 生产配置：阈值为 `0.60`；历史 `0.61` 证据仍可由 fixture 与 git 提交复核。
