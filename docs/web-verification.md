# 签到助手验证说明

本文件记录 **v1.0.8** 的本地验证结果、可复现流程与覆盖范围。测试使用临时安装、独立浏览器上下文和本地模拟站点，不读取日常浏览器凭据，也不对真实站点执行签到。

## 本次验证记录

验证日期为 **2026-11-11**，本地环境为 **macOS arm64、Node.js v24.13.1**。

| 检查 | 结果 |
|---|---|
| 应用构建 | 通过 |
| 前端 JavaScript 语法检查 | 通过 |
| 源码与测试严格类型检查 | 通过 |
| 后端回归 | 181 / 181 通过 |
| 可选浏览器扩展回归 | 20 / 20 通过 |
| 基础网页 UI / API 回归 | 22 项通过，生成 21 张截图 |
| 账号导入导出专项 | 11 项通过，生成 9 张截图 |

两套网页回归记录的 JavaScript 错误和外站异常均为 **0**。README 的桌面概览、手机概览与首次设置图片已更新为本次 v1.0.8 的模拟账号截图。

Docker 最终源码镜像的验收结果见下文。本次未运行 GitHub Actions 工作流。

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

后端测试覆盖管理员首次设置与登录、密码哈希、会话和来源校验；站点模板、凭据校验与任务结果；账号导入导出、代理、加密存储与调度。

首次设置重点检查：

1. 无管理员的数据库允许设置自选账号和密码，不生成或要求初始化令牌。
2. 成功设置自动登录，退出后仅正确的已保存凭据可以登录。
3. 重复或并发设置只能创建一次管理员，不能覆盖已有账号或额外签发会话。
4. 管理员、密码与会话在重启后保留，可选环境变量不能覆盖已保存的管理员。

## 网页 UI / API

```bash
npm run test:ui -- --output build/test-opensource-ui
npm run test:ui:accounts -- --output build/test-opensource-accounts
```

基础网页检查覆盖首次空白表单、字段与密码确认校验、创建后进入控制台、过时创建页返回普通登录，以及错误账号和密码拒绝。继续检查账号及站点管理、额度单位、概览分布、快捷操作、定时设置、日志与 CSV，包含桌面和手机布局、键盘导航及弹窗取消。

账号文件专项覆盖密码加密和普通 JSON 下载、当前筛选范围、错误密码与文件格式、重复和无效预览、丢失响应后的安全重试、取消与迟到响应处理，以及手机长预览和操作按钮。该专项不请求原站登录、余额或签到。

报告和演示截图写入指定的 `build/` 子目录，测试结束后清理临时数据。README 中的界面图片仅使用模拟账号。

## Docker 镜像

**2026-11-11** 的最终源码镜像验收通过。容器运行环境为 **Linux arm64、Node.js v24.22.2、Chromium 156.0.8078.79**，验收镜像为 `checkin-assistant:opensource-test`，本次构建的镜像 ID 为：

```text
sha256:d9532f9b0ed55b69c0cd155ba65f4707f749e0e8db98d2cb25bb093199748424
```

| 检查 | 结果 |
|---|---|
| 容器与持久化验收 | 12 项通过 |
| 容器基础网页 UI / API 回归 | 22 项通过，生成 21 张截图 |
| 容器账号导入导出专项 | 11 项通过，生成 9 张截图 |
| 两套网页回归的 JavaScript 错误与外站异常 | 均为 0 |
| 账号专项的外部业务请求 | 0 |
| 临时容器与数据清理 | `cleanup_errors: []` |

本次报告位于 `build/test-opensource-docker-final/report.json`，网页和账号专项截图分别位于同目录的 `ui/` 与 `account-transfer-ui/`。这些报告和截图是本地验证产物，不随源码部署包分发。

复现命令：

```bash
docker build -t checkin-assistant:test .
node tests-node/docker-smoke.mjs \
  --image checkin-assistant:test \
  --output build/test-opensource-docker
```

镜像验收检查生产入口、Node.js 健康检查、非 root 应用与 Chromium、私有数据文件权限及运行时资源一致性。在空数据卷验证无管理员的首次设置，并在容器重启后核对账号、管理员、密码、会话、密钥、记录和待导入状态。重复设置应返回 `409`，不覆盖凭据或签发会话。

同一镜像另运行基础网页和账号文件专项；生产配置检查使用隔离实例，确认测试站点覆盖不会进入生产配置。临时容器与数据由测试脚本清理，完成后检查报告中的 `cleanup_errors`。

## 源码部署包

打包需要系统提供 `tar` 与 `unzip`，用于生成归档和解包核对。

```bash
npm run package:web -- ./release
```

打包脚本生成 ZIP、tar.gz 和 `SHA256SUMS`，解包后逐文件核对字节、源码清单与入口权限。部署包包含运行和构建源码，不包含 `.env`、数据库、密钥、依赖目录或测试生成的数据。

## 验证边界

本地模拟测试验证应用的校验、保存、任务、取消和持久化行为。实际站点的网络、WAF、凭据有效期和人工验证码可能改变运行结果；应用以当次站点响应记录成功、同步、失败或奖励未知。

上述结果覆盖本次 macOS arm64 本地安装及 Linux arm64 容器，其他 CPU 架构、浏览器和服务器环境尚未据此完成验收。各次验证的环境、版本和通过数量应以该次生成的报告为准；GitHub Actions 的实际运行结果需另行核对。
