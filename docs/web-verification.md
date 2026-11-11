# 签到助手验证说明

本文件记录 **v1.0.9** 的本地与 Docker 镜像验收结果、低内存部署的验收预期和可复现流程，并保留 v1.0.8 的历史本地与 GitHub CI 记录。测试使用临时安装、独立浏览器上下文和本地模拟站点，不读取日常浏览器凭据，也不对真实站点执行签到。

## v1.0.9 本地验收

验证日期为 **2026-11-11**，本地环境为 **macOS arm64、Node.js v24.13.1**。

| 检查 | 结果 |
|---|---|
| 应用构建 | 通过 |
| 前端 JavaScript 语法检查 | 通过 |
| 全部 `server/` 与后端测试的严格类型检查 | 通过 |
| 后端回归 | 214 / 214 通过 |
| 历史扩展代码回归 | 20 / 20 通过 |
| 基础网页 UI / API 回归 | 24 项通过，生成 21 张截图 |
| 账号导入导出专项 | 11 项通过，生成 9 张截图 |
| 两套网页回归的 JavaScript 错误与禁止请求 | 均为 0 |
| 账号专项的外部业务请求 | `outbound_business: 0` |

当前本地报告分别位于 `build/test-node-ui/report.json` 与 `build/test-node-account-transfer-ui/report.json`。桌面概览、手机概览与首次设置截图已更新到 `docs/images/`，仅使用 v1.0.9 模拟账号。报告与完整截图是本地验证产物，不随源码部署包分发。

## 历史基线验证记录

以下 v1.0.8 基线的验证日期为 **2026-11-11**，本地环境为 **macOS arm64、Node.js v24.13.1**。这些结果来自低内存与手动保存优化前的源码，当前版本结果见上文及 v1.0.9 Docker 验收。

| 检查 | 结果 |
|---|---|
| 应用构建 | 通过 |
| 前端 JavaScript 语法检查 | 通过 |
| 源码与测试严格类型检查 | 通过 |
| 后端回归 | 181 / 181 通过 |
| 历史浏览器扩展回归 | 20 / 20 通过 |
| 基础网页 UI / API 回归 | 22 项通过，生成 21 张截图 |
| 账号导入导出专项 | 11 项通过，生成 9 张截图 |

基线的两套网页回归记录中，JavaScript 错误和外站异常均为 **0**。当时的桌面概览、手机概览与首次设置图片使用 v1.0.8 模拟账号。

历史本地网页报告位于 `build/test-queue-after/report.json`，账号专项报告位于 `build/test-queue-accounts/report.json`。基线的后端与扩展结果沿用同日已完成的回归。

历史 Docker 源码镜像与 Linux x64 GitHub CI 的验收结果见下文。640 MiB 容器与目标主机的受控资源结果见 [低内存隔离验收实测](#低内存隔离验收实测)。

## 环境

- Node.js 24.13 或更新的 24.x 版本。
- 系统 Chrome / Chromium，用于网页测试和需要浏览器的本地模拟流程。
- Docker，用于实际镜像、权限、健康检查与重启持久化验证。

可用 `CHECKIN_BROWSER_PATH` 指定浏览器可执行文件。镜像包含自己的系统 Chromium。

## 构建与后端

```bash
npm ci
npm run build
node --check web/app.js
node --check web/providers.js
npx --no-install tsc --noEmit --target ES2023 --module NodeNext \
  --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck \
  server/*.ts tests-node/*.test.ts
npm test
node --test browser-extension/tests/*.test.mjs
```

当前后端回归覆盖管理员首次设置与登录、密码哈希、会话和来源校验；站点模板、手填字段校验与幂等保存、任务中的身份核对和结果；账号导入导出、代理、加密存储与调度。

`browser-extension/` 目录保留为历史开发资料，扩展测试可单独运行；当前网页采用手动填写与保存。

后端测试最多同时运行两个测试文件，控制系统浏览器启动时的资源占用；全部用例、断言和应用校验时限保持一致。

首次设置重点检查：

1. 无管理员的数据库允许设置自选账号和密码，不生成或要求初始化令牌。
2. 成功设置自动登录，退出后仅正确的已保存凭据可以登录。
3. 重复或并发设置只能创建一次管理员，不能覆盖已有账号或额外签发会话。
4. 管理员、密码与会话在重启后保留，可选环境变量不能覆盖已保存的管理员。

手动保存重点检查：

1. Session 换行、空值、非法用户 ID 等输入返回字段错误，并且不保存账号、不请求原站。
2. 格式正确的 Session、登录 Token 与账号密码直接加密保存，新账号余额为待同步；保存阶段没有原站请求。
3. Session / Token 保存使用相同请求标识和内容重试时，不重复添加账号；同一标识换成其他内容返回冲突。
4. 看似格式合法但站点已不接受的 Session 也能先保存；首次任务运行时才报告凭据问题，不产生虚假的余额或奖励。
5. 首次任务验证用户身份与余额；身份不一致或请求失败时不覆盖已有有效余额。AgentRouter Session 成功查询记录为余额同步，奖励保持未知。
6. `/api/login/*` 与 `/api/browser-import/*` 返回 `410`；`/api/bootstrap` 的 `authorization` 为 `null`。

## 网页 UI / API

```bash
npm run test:ui -- --output build/test-node-ui
npm run test:ui:accounts -- --output build/test-node-account-transfer-ui
```

基础网页检查覆盖首次空白表单、字段与密码确认校验、创建后进入控制台、过时创建页返回普通登录，以及错误账号和密码拒绝。继续检查账号及站点管理、额度单位、概览分布、快捷操作、定时设置、日志与 CSV，包含桌面和手机布局、键盘导航及弹窗取消。

弹窗打开期间，工作区真实 DOM 刷新不会夺走弹窗内的焦点；关闭弹窗后再次刷新，仍保留已恢复的控件焦点。

手填账号表单的保存、错误反馈和重试保留输入与焦点；首次运行前显示待同步余额，运行后按站点响应更新状态。

账号文件专项覆盖密码加密和普通 JSON 下载、当前筛选范围、错误密码与文件格式、重复和无效预览、丢失响应后的安全重试、取消与迟到响应处理，以及手机长预览和操作按钮。该专项不请求原站登录、余额或签到。

报告和演示截图写入指定的 `build/` 子目录，测试结束后清理临时数据。README 中的界面图片仅使用模拟账号。

## v1.0.9 Docker 镜像验收

**2026-11-11** 的 v1.0.9 实际镜像验收通过。容器运行环境为 **Linux arm64、Node.js v24.22.2、Chromium 156.0.8078.79**，验收镜像 ID 为：

```text
sha256:083fe0afefd0cf5d07433576ec4647932ff7c68beb183f2ba89683aca9adf42b
```

| 检查 | 结果 |
|---|---|
| 容器与持久化验收 | 12 项通过 |
| 容器基础网页 UI / API 回归 | 24 项通过，生成 21 张截图 |
| 容器账号导入导出专项 | 11 项通过，生成 9 张截图 |
| 两套网页回归的 JavaScript 错误与禁止请求 | 均为 0 |
| 账号专项的外部业务请求 | `outbound_business: 0` |
| 临时容器与数据清理 | `cleanup_errors: []` |

当前 Docker 报告位于 `build/test-v109-docker/report.json`，网页和账号专项截图分别位于同目录的 `ui/` 与 `account-transfer-ui/`。通用 Docker smoke 使用 `--memory=2g`；本次结果验证该资源配置下的运行与持久化，640 MiB 配置及目标主机的受控资源结果见 [低内存隔离验收实测](#低内存隔离验收实测)。

通用镜像验收命令：

```bash
docker build -t checkin-assistant:test .
node tests-node/docker-smoke.mjs \
  --image checkin-assistant:test \
  --output build/test-v109-docker
```

镜像验收检查生产入口、Node.js 健康检查、非 root 应用与 Chromium、私有数据文件权限及运行时资源一致性。在空数据卷验证无管理员的首次设置，并在容器重启后核对账号、管理员、密码、会话、密钥和记录。用于手动保存的 nonce 在重启后持续有效，同一请求仍可幂等重放；`/api/bootstrap` 的 `authorization` 保持为 `null`。重复设置返回 `409`，不覆盖凭据或签发会话。

同一镜像另运行基础网页和账号文件专项；生产配置检查使用隔离实例，确认测试站点覆盖不会进入生产配置。临时容器与数据已清理，报告中的 `cleanup_errors` 为空。

## 历史 Docker 镜像验收

**2026-11-11** 的历史源码镜像验收通过。容器运行环境为 **Linux arm64、Node.js v24.22.2、Chromium 156.0.8078.79**，验收镜像为 `checkin-assistant:queue-final`，该次构建的镜像 ID 为：

```text
sha256:56f485247ab58c3cd2fa53432a3aeb82dc9a449f6498ca83c4c3709b26295b0b
```

| 检查 | 结果 |
|---|---|
| 容器与持久化验收 | 12 项通过 |
| 容器基础网页 UI / API 回归 | 22 项通过，生成 21 张截图 |
| 容器账号导入导出专项 | 11 项通过，生成 9 张截图 |
| 两套网页回归的 JavaScript 错误与外站异常 | 均为 0 |
| 账号专项的外部业务请求 | 0 |
| 临时容器与数据清理 | `cleanup_errors: []` |

历史报告位于 `build/test-queue-docker/report.json`，网页和账号专项截图分别位于同目录的 `ui/` 与 `account-transfer-ui/`。这些报告和截图是本地验证产物，不随源码部署包分发。通用 Docker smoke 使用 `--memory=2g`，其通过结果不能代替 640 MiB 配置的资源验收。

## 低内存隔离验收实测

目标主机为 **Ubuntu 26.04.1、Linux x64、1 核、956 MiB RAM、2 GiB 总 Swap、Docker 29.1.3**。独立验收容器使用 **Node.js v24.22.2、Chromium 156**，以 UID 1000 运行，配置为 `--network=none`、640 MiB 内存、1280 MiB 内存与 Swap 合计上限及 512 MiB 共享内存。模拟站点只监听容器内 loopback，使用独立临时数据，未读取生产数据。

同一脚本对比 v1.0.8 与 v1.0.9，关键结果如下：

| 隔离样本 | v1.0.8 | v1.0.9 |
|---|---|---|
| 手动保存耗时 | 171 ms | 61.69 ms |
| 保存后应用进程 RSS | 164.66 MiB | 115.16 MiB |
| 20 次 HTTP 余额同步 median / p95 | 9.59 / 22.37 ms | 5.61 / 12.76 ms |

当前保存过程不请求站点，普通 HTTP 余额路径保持 Playwright 未加载。每个版本只执行一次隔离运行；20 次 HTTP 测量使用相同、无 WAF 的 loopback fixture，数据受缓存与调度噪声影响，不能据此推断长期运行或真实站点 WAF 下的性能。

实际浏览器隔离 fixture 的 **4 项检查通过**，容器内存峰值约 **536.89 MiB**，Swap 一次快照约 **167.35 MiB**，OOM 与 OOM kill 均为 **0**。测试结束后浏览器已关闭，资源计数 active / queued 均为 0，临时数据已移除。旧版同类浏览器基线峰值为 523.13 MiB，本次未观察到浏览器峰值降低；优化避免在手动保存和直接 HTTP 查询时启动浏览器，并限制需要浏览器时的并发重叠。

### 部署配置与复核

1 核 / 1 GB 主机的起始配置为 `CHECKIN_LOW_MEMORY=1`、任务并发 `1`、容器内存 `640m`、内存与 Swap 合计 `1280m`，宿主机至少提供 2 GiB 总 Swap。配置含义见 [1Panel 部署指南](deploy-1panel.md)。该配置的性能需在对应服务器单独测量；通用 2 GiB 测试容器、无 WAF 的本地接口及真实站点应分别记录。

使用与部署一致的镜像和资源上限，在独立临时数据库中完成首次设置、手动保存及余额查询；模拟站点只监听 loopback，应用进程使用镜像的非 root 用户。验收应记录以下结果：

| 检查 | 预期行为与记录 |
|---|---|
| 冷启动与手动保存 | 记录模块加载、启动、保存耗时和 RSS；保存时原站请求数为 0，浏览器保持未启动 |
| 普通 AgentRouter Session | 使用相同 HTTP fixture 顺序运行 10–20 次，记录首轮、median、p95 与 RSS；每轮只有余额读取，不发起登录或签到 |
| 站点防护 | AgentRouter Session 的 HTTP 余额查询遇 WAF 时才回退浏览器；无效 Session 与身份不一致不会触发登录或签到 |
| 浏览器峰值与关闭 | 多个任务或站点探测需要浏览器时统一排队；同时活跃的浏览器最多 1 个，任务结束和关闭应用时回收浏览器 |
| 长期运行记录 | 添加大量旧日志后，概览按时间索引读取近期窗口；自然日趋势、金额累计与最近 100 条日志保持一致 |
| 容器资源 | 记录 RAM、Swap、内存峰值及 OOM 事件；容器未被 OOM 终止，测试后临时实例和数据已清理 |

可在宿主机查看配置与资源：

```bash
free -h
docker compose ps
docker compose stats --no-stream
docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.State.OOMKilled}}' \
  "$(docker compose ps -q checkin-assistant)"
```

640 MiB / 1280 MiB 配置对应的两个字节上限为 `671088640` 和 `1342177280`。cgroup v2 环境还应记录 `memory.current`、`memory.peak`、`memory.swap.current` 和 `memory.events`；Docker stats 的一次快照不足以说明浏览器启动峰值。Swap 频繁增长意味着主机仍有内存压力，应降低其他服务负载或提高机器配置。

## 源码部署包

打包需要系统提供 `tar` 与 `unzip`，用于生成归档和解包核对。

```bash
npm run package:web -- ./release
```

打包脚本生成 ZIP、tar.gz 和 `SHA256SUMS`，解包后逐文件核对字节、源码清单与入口权限。部署包包含运行和构建源码，不包含 `.env`、数据库、密钥、依赖目录或测试生成的数据。

## 历史 GitHub CI

**2026-11-11**，[GitHub CI 运行 42972396633](https://github.com/txy1042348976/checkin-assistant/actions/runs/42972396633) 对应源码提交 `8ada716`，`verify`、`docker` 与 `package` 三个任务均通过。Runner 为 **Ubuntu 26.04.1、Linux amd64（x64）**；源码测试与 CI 镜像均使用 **Node.js v24.22.2**，Runner Chrome 和镜像 Chromium 均为 **156.0.8078.79**。

| 任务 | 结果 |
|---|---|
| `verify` | 后端 181 项、扩展 20 项、UI 22 项与账号专项 11 项全部通过；网页分别生成 21 与 9 张截图 |
| `docker` | 12 项容器检查通过；UI 22 项与账号专项 11 项全部通过，合计生成 30 张截图 |
| `package` | 116 个源码文件，ZIP 与 tar.gz 的解包、逐文件核对和 SHA-256 校验通过 |

## 验证边界

本地模拟测试验证应用的字段校验、保存、首次任务身份核对、取消和持久化行为。手动保存成功表示凭据已加密写入数据库；站点是否接受凭据以及可用余额，以任务运行时的响应为准。实际站点的网络、WAF、凭据有效期和人工验证码可能改变运行结果；应用以当次站点响应记录成功、同步、失败或奖励未知。

当前 v1.0.9 已通过结果覆盖 macOS arm64 本地安装、使用 2 GiB 内存上限的 Linux arm64 容器，以及 Linux x64 上使用 640 MiB 内存上限的独立 fixture。Linux x64 全面 GitHub CI 的已通过记录属于 v1.0.8 历史基线。隔离 fixture 的结果与真实站点、生产服务健康及长期稳定性应分别核对，各次验证的环境、版本、资源限制和通过数量以该次生成的报告为准。
