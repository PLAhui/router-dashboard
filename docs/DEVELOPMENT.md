# 开发指南

面向想阅读代码、调试或二次开发（适配其它路由器、增加新指标）的开发者。部署使用请看 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 一、开发环境

```bash
# 前置：Node.js >= 18（用了 node: 前缀内置模块），无任何 npm 依赖
git clone https://github.com/<你的用户名>/router-dashboard.git
cd router-dashboard

cp config.env.example config.env   # 填入你路由器的地址与密码
node server.js                     # 启动，默认 127.0.0.1:8787
```

推荐的本地开发流程：

```bash
node --check server.js             # 语法检查（改完随手跑）
node server.js                     # 启动服务
curl -s http://127.0.0.1:8787/api/health | jq   # 看连接状态
curl -s http://127.0.0.1:8787/api/snapshot | jq   # 看原始快照
curl -s "http://127.0.0.1:8787/api/raw" | jq      # 路由器原始返回（已脱敏）
```

无头浏览器整页验证（改前端后确认渲染效果）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --no-proxy-server \
  --hide-scrollbars --window-size=1600,1200 --virtual-time-budget=6000 \
  --screenshot=/tmp/dashboard.png http://127.0.0.1:8787/
```

> 若你的 shell 配置了 `HTTP_PROXY`，访问内网路由器必须 `--no-proxy-server` 或 `curl --noproxy '*'`，否则内网地址会被代理拦截。

## 二、目录结构

```
router-dashboard/
├── server.js          # 代理服务：登录保活、轮询、差分、脱敏、API 路由
├── analytics.js       # 衍生分析：采样落盘、统计、健康评分、事件解析
├── config.env         # 本地私密配置（git 忽略）
├── config.env.example # 配置模板（入库）
├── start.command      # macOS 双击启动脚本
├── data/              # 运行数据（git 忽略）
│   └── samples.jsonl  # 24h 采样落盘
├── docs/              # 文档与截图
└── public/            # 前端（无构建步骤，原生 HTML/CSS/JS）
    ├── index.html / app.js / styles.css          # 实时看板
    ├── analysis.html / analysis.js / analysis.css # 深度分析
    └── report.html / report.js / report.css       # 运行报告
```

## 三、架构说明

```
浏览器（原生 JS，15s/30s 独立轮询）
   │  同源 fetch：/api/snapshot /api/analysis /api/sms ...
   ▼
server.js（Node 零依赖）
   │  · 登录保活：POST /cgi-bin/luci 表单 → sysauth cookie，403 自动重登
   │  · 分层轮询：实时 2s（runtime + 流量计数器差分）
   │              低频 30s（模组/SIM/短信）→ 60s（系统日志）
   │  · 容错：低频接口彼此独立，单个超时保留上次数据
   │  · 脱敏：IMEI/ICCID/手机号/小区号在接口层掩码后才下发
   ▼
analytics.js
   · 2s 采样点落盘 samples.jsonl（保留 24h，重启恢复）
   · 衍生指标：峰值/P95/空闲率、稳定性 σ、健康评分、分钟聚合、
     终端画像、事件与告警（状态跃变才报一次）
```

关键代码位置速查：

| 想改什么 | 位置 |
|---|---|
| 轮询周期 / 采样点上限 | `server.js` 顶部 `POLL_MS` / `MAX_POINTS` |
| 上游接口路径 | `server.js` 顶部 `*_PATH` 常量 |
| 快照字段解析 | `server.js` 的 `buildSnapshot()` |
| 补充数据源解析 | `server.js` 的 `fetchExtras()` |
| 日志→事件分类规则 | `analytics.js` 的 `classifyLog()` |
| 健康评分权重 | `analytics.js` 的 `health()` |
| 前端折线图（Canvas） | `public/app.js` 的 `LineChart` 类 |

## 四、二次开发：新增一个数据源

以「接入一个新接口并在看板展示」为例，标准步骤：

1. **抓包确认**：在 LuCI 页面打开浏览器开发者工具 → Network，找到 XHR 请求（方法、参数、返回结构）；或 `curl -b <cookie>` 直接验证
2. **加路径常量**：`server.js` 顶部新增 `const XXX_PATH = '/cgi-bin/luci/...'`
3. **接入轮询**：
   - 高频数据 → 加进 `poll()` 里的主循环解析
   - 低频数据 → 在 `fetchExtras()` 的 `Promise.all` 中加一路 `safeExtra(...)`，解析结果放入 `patch.xxx`（`safeExtra` 自带容错，失败不影响其它数据源）
4. **（可选）进分析**：`analytics.js` 的采样点里加字段即可自动获得 min/avg/max/P95/σ 等统计
5. **前端展示**：在对应页面 HTML 加容器，JS 里从快照字段取值渲染

### 适配其它 OpenWrt 设备

本项目针对 nradio 定制固件。适配标准 OpenWrt 的思路：

- 登录方式不同：LuCI2/令牌机制需改写 `server.js` 的登录与 `looksLikeLoginPage()` 判定
- 数据源不同：标准 LuCI 可用 `admin/status/realtime/bandwidth_status` 等接口替换 `buildSnapshot()` 的解析
- 保持对外 API（`/api/snapshot` 等）字段结构不变，前端就完全不用改——**建议适配时以现有快照字段为「契约」**

## 五、前端约定

- **无构建、无依赖**：改完保存刷新即生效；不要引入 npm 包或 CDN
- **主题**：所有颜色用 `styles.css` 顶部 `:root` 的 CSS 变量，深色主题在 `[data-theme="dark"]` 下覆盖；新增元素必须用变量而不是硬编码颜色
- **图表**：
  - 折线图复用 `app.js` 的 `LineChart` 类（支持 `zeroBase`、`yFormat`、悬停 tooltip）
  - 报告页的 SVG 图是临时生成的字符串，改起来很直观
- **敏感值**：页面上永远不要直接展示未脱敏的 IMEI/ICCID/手机号，服务端已掩码，前端只需照常渲染

## 六、提交规范

- 功能：`feat: ...`；修复：`fix: ...`；文档：`docs: ...`
- 提交前自检：`node --check` 全部 JS、无 `config.env`/`data/` 进入暂存区（`git status` 确认）
- 新增依赖是不被接受的（保持零依赖是本项目的核心卖点）
