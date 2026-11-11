# 在 1Panel 部署签到助手

本指南适用于签到助手 **v1.0.9**。应用使用 Node.js 24 + TypeScript，一个 Docker Compose 服务包含应用与系统无头 Chromium。网页负责手动保存和管理账号，服务器在任务运行时核对身份、查询余额并执行签到。

## 1. 准备目录与配置

在 Linux 服务器上安装 Docker；使用 1Panel 管理时还需配置 OpenResty。**1 核 / 1 GB 主机可从少量账号、单任务的低内存配置开始**，并在宿主机配置至少 2 GiB 总 Swap。1Panel、OpenResty 和其他服务也会占用内存；账号多、频繁使用浏览器或同时运行其他服务时，使用 2 核 / 4 GB 及以上配置更合适。首次构建需要访问 Debian 与 npm 软件源，也会比稳定运行占用更多资源。

下载本仓库源码，或解压 `checkin-assistant-1panel.zip` / `.tar.gz` 到 `/opt/checkin-assistant`。该目录应包含 `Dockerfile`、`docker-compose.yml`、`package.json`、锁文件、`tsconfig.json`、`server/`、`web/`、`deploy/`、`browser-extension/` 和许可文件。

在 1Panel 文件管理中复制 `.env.example` 为同目录的 `.env`，填写实际访问网址：

```dotenv
CHECKIN_PUBLIC_URL=https://checkin.example.com
CHECKIN_ADMIN_USER=
CHECKIN_ADMIN_PASSWORD=
CHECKIN_BIND_IP=127.0.0.1
CHECKIN_PORT=8765
CHECKIN_TIMEZONE=Asia/Shanghai
CHECKIN_MAX_CONCURRENT_RUNS=1
CHECKIN_LOW_MEMORY=1
CHECKIN_MEMORY_LIMIT=640m
CHECKIN_MEMORY_SWAP_LIMIT=1280m
```

`CHECKIN_PUBLIC_URL` 必须是实际访问的完整根网址，只包含协议、域名及可选端口，不带路径。应用按根路径部署，例如 `https://checkin.example.com/`。默认绑定 `127.0.0.1`，适合在同一服务器上设置反向代理。

上述示例是 1 GB 主机的起始配置。`CHECKIN_MEMORY_LIMIT=640m` 限制容器的物理内存使用；`CHECKIN_MEMORY_SWAP_LIMIT=1280m` 限制容器的**内存与 Swap 合计**，约允许额外使用 640 MiB Swap，并非再增加 1280 MiB Swap。先在宿主机运行 `free -h`，确认 Swap 总量至少 2 GiB；已有足够 Swap 时无需重复添加，配置应在服务器重启后继续生效。Docker 的上限只允许使用已有 Swap，不会创建 Swap 文件。

低内存模式统一限制同时使用的浏览器，任务结束后释放浏览器；普通 AgentRouter Session 余额同步先尝试 HTTP，遇站点防护再启用浏览器。并发保持为 1。Swap 用来缓解内存峰值，持续换页仍会拖慢网站与任务，不能据此保证所有站点都能流畅运行。若首次构建在小主机上内存不足，可在相同 CPU 架构的另一台机器构建镜像，再通过 `docker save` / `docker load` 迁移。

内存更充裕的主机可设置 `CHECKIN_LOW_MEMORY=0`、`CHECKIN_MEMORY_LIMIT=2g`、`CHECKIN_MEMORY_SWAP_LIMIT=0`，使用通用 Compose 默认配置。Swap 上限为 `0` 表示采用 Docker 默认行为，不表示禁用 Swap。`shm_size: 512mb` 是共享内存容量上限，实际使用的内存仍计入容器限制。

## 2. 创建编排

在 1Panel 进入 **容器 → 编排 → 创建编排 → 路径选择**，选择 `/opt/checkin-assistant/docker-compose.yml`。使用路径选择可让 Docker 的构建目录、`.env` 和 `./data` 对应同一个项目目录。

如果面板没有自动执行首次构建，在服务器终端运行：

```bash
cd /opt/checkin-assistant
docker compose build --pull
docker compose up -d
docker compose ps
```

服务名为 `checkin-assistant`，本地构建镜像为 `checkin-assistant:local`。等容器进入 `healthy` 后访问网站。应用监听容器内的 8765 端口，默认映射到宿主机 `127.0.0.1:8765`。

## 3. 配置 HTTPS 反向代理

在 **网站 → 创建网站 → 反向代理** 中绑定你的域名，上游填写 `http://127.0.0.1:8765`，绑定证书并启用 HTTPS。以下设置可用于代理配置：

```nginx
client_max_body_size 10m;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_read_timeout 90s;
proxy_send_timeout 90s;
proxy_buffering off;
```

修改现有代理 location 中的对应指令，避免重复配置。项目也提供 `deploy/nginx-location.conf`。`client_max_body_size 10m` 为最大 8 MiB 的账号导入文件及请求包装预留空间，接口响应不应缓存。

项目模板对 CSS、JavaScript 和 SVG 使用一级 gzip 压缩，减少静态文件传输量，并控制压缩的 CPU 开销。

OpenResty 若运行在隔离的 Docker bridge 网络中，其中的 `127.0.0.1` 指 OpenResty 容器。可把两个服务接入同一个 Docker 网络，以上游 `http://checkin-assistant:8765` 访问；按面板中实际网络名称配置 Compose 的 external network。

更改域名或协议后，同步更新 `.env` 的 `CHECKIN_PUBLIC_URL`，执行 `docker compose up -d` 更新容器配置。

## 4. 首次设置并登录

管理员账号与密码默认留空。首次打开数据库尚无管理员的安装，网页显示设置表单：填写登录账号、密码与确认密码，成功后直接进入控制台。以后在各设备使用这组凭据登录。

- 账号：2–40 个英文字母、数字、点、下划线或连字符。
- 新密码：12–1024 个字符，包含字母、数字、符号中的至少两类，避免常见默认密码。

需要预设管理员时，可在首次启动前填写 `CHECKIN_ADMIN_USER` 与 `CHECKIN_ADMIN_PASSWORD`；只填写密码时账号使用 `admin`。预设仅初始化没有管理员的数据库，已有账号与密码不会被环境变量或重复设置请求覆盖。以后可在网页的工作空间设置中修改登录密码。

## 5. 添加站点账号

| 站点 | 推荐填写 |
|---|---|
| AnyRouter | 本站 `session` Cookie 与站内用户 ID |
| AgentRouter | 本站用户名或邮箱与站内密码；也可填 Session 与用户 ID |
| Sub2API | 本站登录 Token 与用户 ID，可选本站刷新 Token |
| 自定义站点 | 按所选 New API / Sub2API / 余额模板填写 |

在自己的浏览器登录原站，用开发者工具复制本站 `session` Cookie 及 Local Storage 中 `user.id`；Sub2API 通常使用 `auth_token` 与 `user.id`。完成后在账号表单手工填写凭据。

Session、登录 Token 和账号密码均先检查字段格式与完整性，再加密保存。保存时不连接原站，新账号余额显示为待同步；首次手动运行或后台定时任务执行时，才核对登录状态并更新余额。表面格式正确但失效的凭据也会先保存，之后根据运行日志重新填写。通过第三方登录注册、尚无站内密码的账号，可使用 Session，或先在原站设置密码。

AgentRouter 的 Session 方式只同步余额；账号密码方式只有当次登录响应明确确认签到时才记为签到成功。余额同步和奖励未知不会显示为已领取奖励。服务器出口、站点防护与人工验证码可能影响任务，具体原因在运行日志中查看。

每个账号可设置执行间隔与代理。服务器任务使用服务器网络；容器内的 `127.0.0.1` 指容器本身，宿主机代理可使用 `host.docker.internal:端口`，并允许容器访问。

## 6. 导入、导出与备份

账号页可导出全部账号或当前筛选结果，默认下载密码加密的 JSON，也支持普通 JSON。导入先预览，再确认保存，单文件最多 500 个账号、8 MiB。已有账号不被覆盖，新账号默认暂停自动运行，可选择恢复文件里的启用状态。导入文件不请求原站，首次任务运行时才核对凭据并更新余额。

账号文件包含站点凭据与配置，跨安装导入时用目标安装的密钥重新加密；它不包含管理员、余额、运行历史和原安装密钥。迁移完整安装时，应备份整个 `data/` 目录，其中包括 `checkin-assistant.db` 与 `secret.key`。

升级前停止应用并备份数据，例如：

```bash
docker compose stop checkin-assistant
tar -czf checkin-assistant-data-backup.tar.gz data
docker compose build --pull
docker compose up -d
```

备份文件包含敏感数据，保存到受控位置。恢复时应停止服务，保持数据库与原密钥配对。不要让多个应用进程同时写一份 SQLite 数据库。

## 配置参考

| 变量 | 未配置时的默认值 | 用途 |
|---|---|---|
| `CHECKIN_PUBLIC_URL` | 空 | 浏览器实际访问的根网址 |
| `CHECKIN_ADMIN_USER` | 空 | 可选首次预设账号；仅有预设密码时回退为 `admin` |
| `CHECKIN_ADMIN_PASSWORD` | 空 | 可选首次预设密码；留空使用网页首次设置 |
| `CHECKIN_BIND_IP` | `127.0.0.1` | Compose 的宿主机端口绑定地址 |
| `CHECKIN_PORT` | `8765` | 宿主机端口；直接 Node.js 运行时为监听端口 |
| `CHECKIN_DATA_DIR` | `data/` | 直接运行的数据目录；Compose 中固定为 `/data` |
| `CHECKIN_TIMEZONE` | `Asia/Shanghai` | 任务与记录时区 |
| `CHECKIN_MAX_CONCURRENT_RUNS` | `1` | 同时运行的任务数 |
| `CHECKIN_LOW_MEMORY` | `0` | `1` 开启低内存模式；1 GB 主机保持任务并发为 1 |
| `CHECKIN_MEMORY_LIMIT` | `2g` | Compose 的内存上限 |
| `CHECKIN_MEMORY_SWAP_LIMIT` | `0` | Compose 的内存与 Swap 合计上限；1 GB 示例为 `1280m`，需宿主机先提供 Swap |
| `CHECKIN_PROXY_URL` | 空 | AgentRouter 默认服务器代理；独立账号配置优先 |
| `CHECKIN_SESSION_HOURS` | `24` | 管理员登录会话有效时间，直接运行时可配置 |
| `CHECKIN_BROWSER_PATH` | 自动检测 | 直接运行时的 Chrome / Chromium 路径 |

## 查看状态

```bash
docker compose ps
docker compose logs --tail 100 checkin-assistant
curl http://127.0.0.1:8765/api/health
free -h
docker compose stats --no-stream
```

应用和 Chromium 在容器中以非 root 用户运行。健康检查由 Node.js 执行；网页需要重新登录时，使用已保存的管理员账号与密码。
