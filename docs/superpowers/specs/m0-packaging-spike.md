# M0 打包 spike:Node SEA vs Bun 单文件

日期:2026-07-15

## 结论

M0 锁定 **Node SEA**。交付目录为一个平台可执行体加外置内容目录:

```text
LuminousQuest[.exe]
config/
prompts/
assets/
recordings/
.env
start.command
start.bat
```

Vite 产出的 HTML/CSS/JS 作为 SEA assets 嵌入可执行体;教学配置、提示词、素材、演示录制和密钥文件保持外置。这样既保持当前 React + Hono + Node 依赖链,又满足内容 JSON 刷新即生效。

## 方案比较

### Bun `--compile`

- 官方工具支持把 TS/JS、npm 依赖和 Bun runtime 编成单文件,也支持跨平台 target 和嵌入前端资源。
- 本机未安装 Bun。把 Bun 加入 M0 会新增第二套运行时与打包工具链,还需要重新验证 `@hono/node-server`、`node:sea` 静态资源分支和全部 Node 兼容路径。
- 跨平台编译很有吸引力,但 M0 的服务实现和验证基线已经是 Node;此时切换运行时扩大了门禁范围,收益不足以覆盖兼容性风险。

参考:Bun 官方 [Single-file executable](https://bun.sh/docs/bundler/executables)。

### Node SEA

- 与既定的本地 Node 服务同运行时;esbuild 先把 Hono、Zod、Ajv 和 provider adapters 打成单个 CommonJS 入口。
- Node SEA assets 可以内嵌 Vite 静态文件,外置内容仍由普通文件系统读取。
- Node 26.3.0 的 `--build-sea` 可直接生成目标可执行体;Node 22.20.0 至 25.4.x 由脚本回退到官方的 preparation blob + postject 流程。
- SEA 仍标记为 active development,所以每个目标平台必须保留冷启动、静态资源、配置热加载和签名验证门禁。
- 便携 Node runtime 目录最稳妥,但会交付运行时目录和外置 JS,不如 SEA 符合“可执行体 + 外置内容目录”的约束。因此只保留为 SEA 在某个目标机不可用时的应急退路。

参考:Node 官方 [Single executable applications](https://nodejs.org/api/single-executable-applications.html)。

## 实现

`pnpm run package:app` 执行以下流程:

1. 构建 Vite 前端并执行 TypeScript 检查。
2. 用 esbuild 将 `server/index.ts` 及全部 npm 依赖打成一个 CommonJS 文件。
3. 将 `dist/client` 文件登记为 SEA assets。
4. 生成 Node SEA 可执行体并在 macOS 做 ad-hoc codesign。
5. 复制外置 `config/`、`prompts/`、`assets/`、`recordings/` 和无密钥 `.env`。
6. 排除 `recordings/cache/`,避免把开发录制或敏感输入带入交付包。

本机 Homebrew Node 是 67 KB 的动态链接 launcher,不含 SEA fuse。第一次直接构建稳定复现:

```text
Error: sentinel NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 not found
```

打包脚本因此先检查目标 Node 的 SEA fuse。若本机 Node 不可注入,脚本下载同版本官方 Node 发行包、按官方 `SHASUMS256.txt` 校验后再生成 SEA。可通过 `LQ_SEA_NODE` 指定已审计的官方 Node 可执行体,离线构建时也可复用 `dist/toolchain/` 缓存。

## macOS 实测

环境:macOS arm64,Node 26.3.0,pnpm 11.4.0。

| 检查 | 结果 |
|---|---|
| `pnpm run package:app` | 通过 |
| 产物 | `release/darwin-arm64/LuminousQuest`,137 MB |
| `codesign --verify --verbose=2` | `valid on disk`,满足 designated requirement |
| `open release/darwin-arm64/start.command` | 通过;Finder 双击等价路径启动成功 |
| 监听地址 | 仅 `127.0.0.1:4173` |
| 静态首页 | 200,嵌入的 Vite HTML/JS/CSS 可读取 |
| 外置配置热加载 | 运行中将 `knowledge-model.v1` 改为 `knowledge-model.v2`,下一次 `/api/config` 立即返回 v2,无需重启 |
| 坏配置诊断 | 非法 `nodes.0.weight` 启动退出 1,输出文件、字段、原因 |
| 演示回放 | `m0-health-check` 按 step ID 命中 `demo-recording` |
| 端口占用 | 第二实例明确打印 4173 被占用并选择 `127.0.0.1:4174` |
| 退出清理 | SIGINT 后两个实例均正常关闭,监听端口释放 |

## 尚未覆盖

- 当前环境没有 Windows 目标机,所以 `start.bat` 和 Windows SEA 仍需在目标机执行同一组冷启动、端口、静态资源、热加载和退出清理验收。
- Bun 未做本机二进制实测;本次结论依据官方能力、当前 Node 架构适配成本和 Node SEA 的完整 macOS 实测。若 SEA 在 Windows 目标机出现不可接受问题,再启动 Bun 实机对照,而不是并行维护两套正式产物。
- Provider key 未到位,M0 门禁 2 按范围明确后置;打包验证使用 mock provider 与录制回放。

