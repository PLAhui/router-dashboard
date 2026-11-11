# 部署使用说明

本文介绍如何在生产/日常环境中部署和长期使用 Router Dashboard。开发与二次开发请看 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 一、环境要求

| 项目 | 要求 |
|---|---|
| 运行主机 | 任意能访问路由器管理地址的机器（NAS / 树莓派 / Mac / Linux / Windows） |
| Node.js | ≥ 18（零第三方依赖，无需 `npm install`） |
| 路由器 | nradio 定制固件的 5G CPE（LuCI 表单登录）；其它 OpenWrt 需按 DEVELOPMENT.md 适配 |

## 二、标准部署步骤

```bash
# 1. 获取代码
git clone https://github.com/<你的用户名>/router-dashboard.git
cd router-dashboard

# 2. 配置
cp config.env.example config.env
vi config.env    # 填 ROUTER_HOST 与 ROUTER_PASSWORD

# 3. 启动
node server.js   # 或 npm start
# 数据看板: http://127.0.0.1:8787/
# 深度分析: http://127.0.0.1:8787/analysis
# 运行报告: http://127.0.0.1:8787/report
```

macOS 也可以直接双击 `start.command`（首次会引导创建配置文件）。

### config.env 配置项

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `ROUTER_HOST` | ✅ | — | 路由器管理地址，如 `192.168.1.1`（不带 `http://`） |
| `ROUTER_PASSWORD` | ✅ | — | LuCI 管理密码 |
| `ROUTER_USER` | | `root` | 登录用户名 |
| `PORT` | | `8787` | 服务端口 |
| `BIND` | | `127.0.0.1` | 监听地址 |
| `POLL_MS` | | `2000` | 实时轮询周期（毫秒，不建议 < 1000） |

环境变量优先级高于 `config.env` 文件，容器 / systemd 部署可直接用环境变量。

## 三、开机自启

### macOS（launchd）

创建 `~/Library/Launchers/router-dashboard.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>router-dashboard</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/router-dashboard/server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/router-dashboard.log</string>
  <key>StandardErrorPath</key><string>/tmp/router-dashboard.log</string>
</dict></plist>
```

```bash
# 路径按实际情况修改后：
launchctl load ~/Library/Launchers/router-dashboard.plist
```

> 注意：launchd 不读取 shell 的环境变量，配置请写入 `config.env`，或用 `EnvironmentVariables` 键注入。

### Linux（systemd）

`/etc/systemd/system/router-dashboard.service`：

```ini
[Unit]
Description=Router Dashboard
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/router-dashboard
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
# 也可以不写 Environment，直接用 /opt/router-dashboard/config.env
User=youruser

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now router-dashboard
journalctl -u router-dashboard -f     # 查看日志
```

### Docker（可选）

零依赖应用，镜像非常小，项目根目录已附带 `Dockerfile`：

```bash
docker build -t router-dashboard .
docker run -d --name router-dashboard \
  -p 8787:8787 \
  -e ROUTER_HOST=192.168.1.1 \
  -e ROUTER_PASSWORD=your-password \
  -v router-dashboard-data:/app/data \
  router-dashboard
```

> 容器内默认监听 `0.0.0.0`（容器场景必须），请务必配合防火墙 / 端口映射策略使用。

## 四、局域网访问（让其它设备打开看板）

默认只监听本机。想让手机 / 其它电脑访问：

**方式 A：直接对外开放（简单，注意风险）**

```bash
# config.env 中设置
BIND=0.0.0.0
PORT=8787
```

⚠️ 注意：看板**没有登录认证**，任何能访问该端口的人都能看到你的网络数据（短信内容会脱敏展示吗——不会，短信正文是明文的）。务必只在可信内网使用，或改用方式 B。

**方式 B：反向代理 + Basic Auth（推荐）**

nginx 示例：

```nginx
server {
  listen 8080;
  server_name dashboard.lan;

  auth_basic "Router Dashboard";
  auth_basic_user_file /etc/nginx/htpasswd;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;   # SSE/长轮询友好
  }
}
```

## 五、数据与运维

| 路径 | 说明 |
|---|---|
| `data/samples.jsonl` | 长期采样落盘（保留 24 小时，重启自动恢复），定期会被清理，无需维护 |
| `data/minute-*.json` | 按分钟聚合的归档（供 24h 视图使用） |
| `/api/health` | 服务健康检查（连接状态、错误信息、采样点数），可接入监控探针 |
| `/api/export.csv?window=分钟` | 导出采样数据为 CSV |

日常运维要点：

- **日志**：代理服务的告警输出到 stdout（`[extras]` / `[poll]` 前缀），systemd / launchd 场景已重定向到日志文件
- **会话失效**：路由器重启后代理会自动重新登录，无需人工干预
- **换密码**：路由器管理密码修改后，同步更新 `config.env` 并重启服务即可
- **停止服务**：`lsof -ti tcp:8787 | xargs kill`（macOS/Linux）

## 六、常见问题

| 现象 | 排查 |
|---|---|
| 启动即退出并提示「缺少路由器配置」 | 未创建 `config.env` 或字段为空 |
| 一直显示「连接中」，health 里 lastError 有超时 | 检查运行主机能否 `ping` 通路由器；确认 `ROUTER_HOST` 正确 |
| 数据正常但 `/analysis` 补充区块为空 | 低频接口（模组/SIM/短信）暂时超时，属正常容错，下一周期自动恢复 |
| 页面打开但无数据 | 确认访问的是服务地址 `127.0.0.1:8787`，而不是直接打开 `index.html` 静态文件 |
| 速率数值为 0 | 路由器侧计数器被复位时单点会被丢弃，2 秒后自动恢复 |
