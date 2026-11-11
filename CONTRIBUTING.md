# 参与开发

签到助手使用 Node.js 24、TypeScript 与原生网页前端。安装 Node.js 24.13 或更新的 24.x 版本，以及系统 Chrome / Chromium 后，在项目目录执行：

```bash
npm ci
npm run build
npm test
node --test browser-extension/tests/*.test.mjs
```

后端代码位于 `server/`，界面位于 `web/`，生产回归位于 `tests-node/`。`browser-extension/` 只提供可选的历史兼容功能，日常手填凭据流程无需扩展。

修改界面或账号流程时，执行独立的网页回归。测试会创建临时安装与模拟站点，结束后清理数据：

```bash
npm run test:ui
npm run test:ui:accounts
```

测试自动寻找系统浏览器，也可通过 `CHECKIN_BROWSER_PATH` 指定 Chrome / Chromium 可执行文件。不要让回归测试使用个人数据目录或真实站点账号。

修改部署、存储或运行环境时，验证实际 Docker 镜像：

```bash
docker build -t checkin-assistant:ci .
node tests-node/docker-smoke.mjs --image checkin-assistant:ci
npm run package:web -- release
```

提交前检查源码与测试的严格类型：

```bash
npx --no-install tsc --noEmit --target ES2023 --module NodeNext \
  --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck \
  server/*.ts tests-node/*.test.ts
```

Pull Request 请说明具体问题、修改后的行为和已完成的验证。与账号相关的日志、截图和示例使用模拟数据；密码、Session、登录 Token、代理认证、`.env`、数据库和密钥不应进入提交或问题附件。保留项目及第三方许可声明。

## 版本与发布

发布前同步更新 `package.json`、`package-lock.json` 与 `server/config.ts` 的版本，确认 CI 通过后推送与应用版本一致的 `v*` 标签，例如 `v1.0.8`。工作流生成 ZIP、tar.gz 与校验文件，并创建 GitHub Release 草稿。

草稿需要维护者核对部署包和说明后手动发布。重复执行标签工作流可以更新同一草稿，已经正式发布的版本不会由该工作流覆盖。CI 和 Release 工作流不向镜像仓库推送镜像。
