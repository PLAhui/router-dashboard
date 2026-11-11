#!/usr/bin/env node
'use strict';
/**
 * 路由器数据看板 · 本地代理服务（零第三方依赖）
 *
 * 职责：
 *   1. 模拟 LuCI 表单登录，维护 sysauth 会话，失效自动重登
 *   2. 按 2s 周期轮询运行时状态 + 累计流量计数器，差分计算实时速率
 *   3. 在内存中维护最近 N 个采样点（趋势图数据源）
 *   4. 通过同源 JSON API 提供给前端，规避浏览器跨域与鉴权问题
 *
 * 运行：node server.js      （默认监听 127.0.0.1:8787）
 * 配置：环境变量 ROUTER_HOST / ROUTER_PASSWORD / PORT / POLL_MS / BIND
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Analytics } = require('./analytics');

/* ------------------------------------------------------------------ */
/* 配置加载：环境变量优先，其次本地 config.env（不入库），无则给出提示    */
/* ------------------------------------------------------------------ */
function loadConfigFile() {
  const file = path.join(__dirname, 'config.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadConfigFile();

const ROUTER_HOST = process.env.ROUTER_HOST || '';
const ROUTER_USER = process.env.ROUTER_USER || 'root';
const ROUTER_PASSWORD = process.env.ROUTER_PASSWORD || '';
const PORT = Number(process.env.PORT || 8787);
const BIND = process.env.BIND || '127.0.0.1';
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 2000));
const MAX_POINTS = 240;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!ROUTER_HOST || !ROUTER_PASSWORD) {
  console.error('缺少路由器配置。请复制 config.env.example 为 config.env，');
  console.error('填入 ROUTER_HOST（管理地址）与 ROUTER_PASSWORD（管理密码）后重新启动。');
  process.exit(1);
}

const LOGIN_PATH = '/cgi-bin/luci';
const OVERVIEW_PATH = '/cgi-bin/luci/nradio/system/overview';
const DEFAULT_RUNTIME_PATH = '/cgi-bin/luci/nradio/status/runtime/wan,cpe_4';
const CELLINFO_PATH = '/cgi-bin/luci/nradio/cellular/cpestatus/cellinfo';
const SIMPLAN_PATH = '/cgi-bin/luci/nradio/cellular/cpedata/refresh';
const SMS_PATH = '/cgi-bin/luci/nradio/cellular/sms/unread';
const SMSLIST_PATH = '/cgi-bin/luci/nradio/cellular/sms/list';
const SYSLOG_PATH = '/cgi-bin/luci/nradioadv/system/logread';
const EXTRAS_MS = 30000;
const LOGS_MS = 60000;

let sysauth = null;
let loginPromise = null;
let bootInfo = {
  model: '',
  firmware: '',
  mac: '',
  board: '',
  runtimePath: DEFAULT_RUNTIME_PATH,
  wanNames: 'cpe',
};
let previousCounters = null;
let lastRawRuntime = null;

const state = {
  connected: false,
  lastUpdate: 0,
  lastError: '',
  pollCount: 0,
  snapshot: null,
  history: [],
  extrasAt: 0,
  logsAt: 0,
  extrasError: '',
  smsAt: 0,
  smsMessages: [],
  smsMeta: { used: 0, total: 0, unread: 0 },
};

const analytics = new Analytics(path.join(__dirname, 'data'), POLL_MS);

/* ------------------------------------------------------------------ */
/* 底层 HTTP：使用 node:http 直连，不经过系统 HTTP_PROXY                */
/* ------------------------------------------------------------------ */
function rawRequest(method, pathname, body, cookie) {
  return new Promise((resolve, reject) => {
    const headers = {
      Host: ROUTER_HOST,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (cookie) headers.Cookie = `sysauth=${cookie}`;
    if (body != null) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { host: ROUTER_HOST, port: 80, method, path: pathname, headers, timeout: 12000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('路由器请求超时')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function looksLikeLoginPage(res) {
  // 403/401 或返回登录表单 => 会话失效；404(No page is registered) 属于路径问题，不重登
  return res.status === 403 || res.status === 401 || /name=["']luci_password["']/i.test(res.text);
}

/* ------------------------------------------------------------------ */
/* 登录 + 从状态页解析设备信息与接口参数                                 */
/* ------------------------------------------------------------------ */
function parseBootInfo(html) {
  const info = {};
  let m = html.match(/Model:\s*<\/div>\s*<div[^>]*>\s*([^<]*?)\s*<\/div>/);
  if (m) info.model = m[1].trim();
  m = html.match(/Firmware Version:\s*<\/div>\s*<div[^>]*>\s*([^<]*?)\s*<\/div>/);
  if (m) info.firmware = m[1].trim();
  m = html.match(/var\s+board_name\s*=\s*["']([^"']+)["']/);
  if (m) info.board = m[1];
  m = html.match(/secret_show\(\("([0-9A-Fa-f:]{17})"/);
  if (m) info.mac = m[1].toUpperCase();
  m = html.match(/(\/cgi-bin\/luci\/nradio\/status\/runtime\/[^'"\s]+)/);
  if (m) info.runtimePath = m[1];
  m = html.match(/var\s+g_data\s*=\s*(\{.*?\});/s);
  if (m) {
    try {
      const g = JSON.parse(m[1]);
      const names = (g.wans || [])
        .filter((w) => w.disabled !== '1' && w.disabled !== 1)
        .map((w) => w.name)
        .filter(Boolean);
      if (names.length) info.wanNames = names.join(',');
    } catch (_) {
      /* 保留默认值 */
    }
  }
  return info;
}

async function login() {
  const body =
    `luci_username=${encodeURIComponent(ROUTER_USER)}` +
    `&luci_password=${encodeURIComponent(ROUTER_PASSWORD)}` +
    `&luci_channel=`;
  const res = await rawRequest('POST', LOGIN_PATH, body, null);
  const setCookie = res.headers['set-cookie'] || [];
  const found = setCookie.map((s) => s.match(/sysauth=([^;]+)/)).find(Boolean);
  if (!found) throw new Error('登录失败：未返回 sysauth（请确认密码）');
  sysauth = found[1];
  try {
    const overview = await rawRequest('GET', OVERVIEW_PATH, null, sysauth);
    if (overview.status === 200) Object.assign(bootInfo, parseBootInfo(overview.text));
  } catch (_) {
    /* 解析失败不影响主流程，使用默认接口路径 */
  }
  state.lastError = '';
  return sysauth;
}

function ensureLogin() {
  if (sysauth) return Promise.resolve(sysauth);
  if (!loginPromise) {
    loginPromise = login().finally(() => {
      loginPromise = null;
    });
  }
  return loginPromise;
}

async function authedRequest(method, pathname, body, retried = false) {
  const cookie = await ensureLogin();
  const res = await rawRequest(method, pathname, body, cookie);
  if (looksLikeLoginPage(res) && !retried) {
    sysauth = null;
    await ensureLogin();
    return authedRequest(method, pathname, body, true);
  }
  if (res.status >= 400) throw new Error(`接口 ${pathname} 返回 HTTP ${res.status}`);
  return res;
}

/* ------------------------------------------------------------------ */
/* 数据整理                                                            */
/* ------------------------------------------------------------------ */
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const maskPhone = (p) => {
  if (!p || typeof p !== 'string') return '';
  return p.length > 8 ? p.slice(0, 6) + '****' + p.slice(-4) : '****';
};
const maskId = (v) => {
  if (!v) return '';
  const s = String(v);
  return s.length > 8 ? s.slice(0, 4) + '••••••' + s.slice(-4) : '••••';
};

function buildSnapshot(result, rates, counters, now) {
  const g = result.global || {};
  const cpe = (result.cpe || [])[0] || {};
  const wans = result.wans || [];
  const wan = wans[0] || {};
  const lan = (result.lans || [])[0] || {};
  const term = result.terminal_all || {};
  const wlan = result.wlan || {};
  const radio = (wlan.radio || [])[0] || {};

  const clients = Object.entries(term.client || {}).map(([mac, c]) => ({
    name: c.hostname || c.ipaddr || mac,
    ip: c.ipaddr || '',
    mac: c.mac || mac,
    type: c.type || 'unknown',
    rssi: num(c.rssi, -100),
    txrate: num(c.txrate),
    rxrate: num(c.rxrate),
    ssid: c.ssid || radio.ssid || '',
    channel: c.channel || radio.channel || '',
    frequency: c.frequency || radio.frequency || '',
    assoctime: num(c.assoctime),
    blocked: c.switch_off === 1 || c.switch === 0,
    ifname: c.ifname || '',
  }));
  clients.sort((a, b) => b.rssi - a.rssi);

  const ipList = (arr) =>
    (arr || []).map((x) => (typeof x === 'string' ? x : x.ipaddr)).filter(Boolean);

  return {
    time: now,
    device: {
      model: bootInfo.model || '路由器',
      firmware: bootInfo.firmware || '-',
      board: bootInfo.board || '-',
      mac: bootInfo.mac || cpe.mac || '',
    },
    global: {
      uptime: num(g.uptime),
      cpu: num(g.cpu_percent),
      mem: num(g.mem_percent),
      temp: num(g.device_temp),
      wifiTemp: num(g.wifi_temp),
      netType: g.net_type || cpe.mode || '-',
    },
    rates: { down: rates.down, up: rates.up },
    totals: {
      download: counters.download,
      upload: counters.upload,
      simMonth: num(cpe.sim_mon || cpe.sim_flow),
      deviceTraffic: num(cpe.device_traffic),
      traffic: num(cpe.traffic),
    },
    cellular: {
      isp: cpe.isp_company_lng || cpe.isp_company || cpe.sim_company || '-',
      mode: cpe.mode || '-',
      band: cpe.band ? 'n' + cpe.band : '-',
      rsrp: num(cpe.rsrp, -110),
      rsrq: num(cpe.rsrq, -20),
      sinr: num(cpe.sinr),
      rssi: num(cpe.rssi, -110),
      cqi: num(cpe.cqi),
      pci: cpe.pci || '-',
      earfcn: cpe.earfcn || '-',
      cell: maskId(cpe.cell),
      tac: maskId(cpe.tac),
      ambrDown: num(cpe.NR5G_AMBR_DL),
      ambrUp: num(cpe.NR5G_AMBR_UL),
      simNo: cpe.simno || '-',
      phone: maskPhone(cpe.simnumber),
      iccid: maskId(cpe.iccid),
      status: cpe.status,
      model: cpe.model || '-',
    },
    wan: {
      name: wan.name || '-',
      proto: wan.proto || '-',
      device: wan.device || '-',
      ip: ipList(wan.ipaddrs).filter((s) => !s.includes(':'))[0] || '-',
      ipv6: ipList(wan.ipaddrs).find((s) => s.includes(':')) || '-',
      dns: wan.dns || [],
      gateway: wan.gateway || '-',
      uptime: num(wan.uptime),
      status: wan.status,
    },
    lan: {
      ip: ipList(lan.ipaddrs).filter((s) => !s.includes(':'))[0] || '-',
      ipv6: ipList(lan.ipaddrs).find((s) => s.includes(':')) || ipList(cpe.V6?.ipaddrs)[0] || '-',
      proto: lan.proto || '-',
      device: lan.device || '-',
      uptime: num(lan.uptime),
    },
    wifi: {
      ssid: radio.ssid || '-',
      channel: radio.channel || '-',
      frequency: radio.frequency || '-',
      encryption: radio.encryption || '-',
      hidden: !!radio.hidden,
      clients: num(radio.sta, clients.length),
      radios: (wlan.radio || []).map((r) => ({
        name: r.name,
        ssid: r.ssid,
        channel: r.channel,
        frequency: r.frequency,
        sta: num(r.sta),
      })),
      radio5Disabled: !!wlan.radio5_disabled,
      radio2Disabled: !!wlan.radio2_disabled,
    },
    clients,
    clientCount: num(term.count, clients.length),
    link: (result.link || []).map((l) => ({ port: l.port, status: l.status, speed: l.speed, mode: l.mode })),
    battery: result.bat || null,
    meta: {
      runtimePath: bootInfo.runtimePath,
      wanNames: bootInfo.wanNames,
      pollMs: POLL_MS,
      historyPoints: state.history.length,
      host: ROUTER_HOST,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 轮询                                                                */
/* ------------------------------------------------------------------ */
async function poll() {
  try {
    const runtimeRes = await authedRequest('POST', bootInfo.runtimePath, 'sms_unread=0');
    const speedRes = await authedRequest(
      'GET',
      `/cgi-bin/luci/nradio/status/speed/${bootInfo.wanNames}`,
      null
    );
    const runtimeJson = JSON.parse(runtimeRes.text);
    const speedJson = JSON.parse(speedRes.text);
    const result = runtimeJson.result || {};
    const list = (speedJson.result && speedJson.result.list) || [];

    const now = Date.now();
    const download = list.reduce((s, x) => s + num(x.download), 0);
    const upload = list.reduce((s, x) => s + num(x.upload), 0);
    const counters = { download, upload };

    let rates = { down: 0, up: 0 };
    let counterReset = false;
    if (previousCounters) {
      const dt = (now - previousCounters.t) / 1000;
      if (dt > 0 && dt < 30) {
        const dd = download - previousCounters.download;
        const du = upload - previousCounters.upload;
        counterReset = dd < 0 || du < 0;
        // 计数器复位 / 异常跳变时忽略该采样点，避免出现尖峰
        if (dd >= 0 && dd < 5e10) rates.down = (dd * 8) / dt;
        if (du >= 0 && du < 5e10) rates.up = (du * 8) / dt;
      }
    }
    previousCounters = { t: now, download, upload };
    const prevPoint = state.history.length ? state.history[state.history.length - 1] : null;

    lastRawRuntime = runtimeJson;
    const snapshot = buildSnapshot(result, rates, counters, now);
    state.snapshot = snapshot;
    state.connected = true;
    state.lastError = '';
    state.lastUpdate = now;
    state.pollCount += 1;

    const point = {
      t: now,
      down: Math.round(rates.down),
      up: Math.round(rates.up),
      cpu: snapshot.global.cpu,
      mem: snapshot.global.mem,
      temp: snapshot.global.temp,
      wifiTemp: snapshot.global.wifiTemp,
      rsrp: snapshot.cellular.rsrp,
      sinr: snapshot.cellular.sinr,
      clients: snapshot.clientCount,
      totalDown: download,
      totalUp: upload,
    };
    state.history.push(point);
    if (state.history.length > MAX_POINTS) state.history.splice(0, state.history.length - MAX_POINTS);
    snapshot.meta.historyPoints = state.history.length;
    analytics.ingest(point, snapshot, prevPoint, counterReset);
    snapshot.health = analytics.health(snapshot);
  } catch (err) {
    state.connected = false;
    state.lastError = String(err && err.message ? err.message : err);
    sysauth = null; // 下轮强制重新登录
    console.warn(`[poll] ${state.lastError}`);
  }
}

/* ------------------------------------------------------------------ */
/* 低频补充数据源（30s / 60s，避免加重路由器负担）                       */
/* ------------------------------------------------------------------ */
const extractIps = (arr) => (arr || []).map((x) => (typeof x === 'string' ? x : x.ipaddr)).filter(Boolean);

async function safeExtra(method, p, body, label) {
  try { return await authedRequest(method, p, body); }
  catch (err) {
    console.warn(`[extras] ${label}: ${err.message}`);
    return null;
  }
}

async function fetchExtras() {
  // 三个接口彼此独立：单个超时不影响其它数据，失败时保留上一次结果
  const [cellRes, planRes, smsRes, listRes] = await Promise.all([
    safeExtra('GET', CELLINFO_PATH, null, '模组详情'),
    safeExtra('POST', SIMPLAN_PATH, 'channel=cpe', 'SIM 套餐'),
    safeExtra('GET', SMS_PATH, null, '短信容量'),
    safeExtra('GET', SMSLIST_PATH, null, '短信列表'),
  ]);
  const patch = {};
  let ok = 0, fail = 0;

  if (cellRes) {
    try {
      const c0 = ((JSON.parse(cellRes.text).result || {}).cellinfo || [])[0] || {};
      const st = c0.status || {};
      patch.cellinfo = {
        up: c0.up, uptime: num(c0.uptime),
        rsrp: num(st.rsrp, -110), sinr: num(st.sinr), rsrq: num(st.rsrq, -20),
        rssi: num(st.rssi, -110), cqi: num(st.cqi), pci: st.pci || '-', earfcn: st.earfcn || '-',
        band: st.band ? 'n' + st.band : '-', mode: st.mode || '-',
        isp: st.isp_company || st.sim_company || '-', modelTemp: num(st.model_temp),
        ipv4: extractIps(st.V4 && st.V4.ipaddrs)[0] || '-',
        ipv6: extractIps(st.V6 && st.V6.ipaddrs)[0] || '-',
        dns: [...(st.V4 && st.V4.dns || []), ...(st.V6 && st.V6.dns || [])],
        simFlow: num(st.sim_flow), traffic: num(st.traffic),
        download: num(st.download), upload: num(st.upload),
        imei: maskId(st.imei), iccid: maskId(st.iccid), phone: maskPhone(st.simnumber),
        model: st.model || '-', status: st.status,
      };
      ok++;
    } catch (_) { fail++; }
  } else fail++;

  if (planRes) {
    try {
      const rawPlans = (JSON.parse(planRes.text).result || {}).data || [];
      patch.simPlans = rawPlans.flat().map((x) => ({
        index: num(x.index), alias: x.alias || `SIM ${num(x.index)}`,
        enabled: !!num(x.enabled), thresholdEnabled: !!num(x.threshold_enabled),
        thresholdType: num(x.threshold_type), thresholdDate: x.threshold_date || '',
        thresholdPercent: num(x.threshold_percent),
        currentGB: num(x.threshold_cds), monthGB: num(x.threshold_smds),
        thresholdGB: num(x.threshold_data), crossFlow: num(x.cross_flow),
        model: x.modelname || '',
      }));
      ok++;
    } catch (_) { fail++; }
  } else fail++;

  if (smsRes) {
    try {
      const u = ((JSON.parse(smsRes.text).result || {}).sms_unread || [])[0] || {};
      patch.sms = { max: num(u.max), used: num(u.used), unread: num(u.count), iface: u.iface || '' };
      ok++;
    } catch (_) { fail++; }
  } else fail++;

  if (listRes) {
    try {
      const r = (JSON.parse(listRes.text).result || {});
      const msgs = [];
      for (const box of r.smslist || []) {
        for (const m of box.list || []) {
          msgs.push({
            contact: box.contact || '-',
            stat: num(m.stat),
            role: num(m.role),
            t: num(m.timestamp) * 1000,
            content: String(m.content || ''),
          });
        }
      }
      msgs.sort((a, b) => b.t - a.t);
      state.smsMessages = msgs.slice(0, 60);
      state.smsMeta = { used: num(r.used), total: num(r.total), unread: num(r.count) };
      state.smsAt = Date.now();
      ok++;
    } catch (_) { fail++; }
  } else fail++;

  if (Object.keys(patch).length) analytics.setExtras(patch);
  if (ok) state.extrasAt = Date.now();
  state.extrasError = fail ? `${fail} 个补充接口暂不可用（已保留上次数据）` : '';
}

async function fetchLogs() {
  try {
    const res = await authedRequest('GET', SYSLOG_PATH, null);
    const added = analytics.ingestLogs(res.text);
    state.logsAt = Date.now();
    state.extrasError = '';
    if (added) console.log(`[logs] 新增 ${added} 条结构化事件`);
  } catch (err) {
    console.warn('[logs]', String(err && err.message ? err.message : err));
  }
}

/* ------------------------------------------------------------------ */
/* 对外 API + 静态资源                                                  */
/* ------------------------------------------------------------------ */
const MIME = {
  'index.html': 'text/html; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
  'app.js': 'application/javascript; charset=utf-8',
  'analysis.html': 'text/html; charset=utf-8',
  'analysis.css': 'text/css; charset=utf-8',
  'analysis.js': 'application/javascript; charset=utf-8',
  'report.html': 'text/html; charset=utf-8',
  'report.css': 'text/css; charset=utf-8',
  'report.js': 'application/javascript; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 脱敏后的原始运行时数据，便于核对接口字段
function sanitize(value) {
  const secret = /^(key|password|passwd|pin|imei|imsi|iccid|simnumber|secret|token|auth)$/i;
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = secret.test(k) ? '***' : sanitize(v);
    return out;
  }
  if (typeof value === 'string' && /^(\+?\d{11,15})$/.test(value)) return value.slice(0, 6) + '****' + value.slice(-4);
  return value;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/snapshot') {
    return sendJson(res, 200, {
      ok: true,
      connected: state.connected,
      lastUpdate: state.lastUpdate,
      lastError: state.lastError,
      pollCount: state.pollCount,
      pollMs: POLL_MS,
      maxPoints: MAX_POINTS,
      boot: bootInfo,
      snapshot: state.snapshot,
      history: state.history,
    });
  }
  if (pathname === '/api/history') {
    const limit = Math.min(MAX_POINTS, Math.max(1, Number(url.searchParams.get('limit') || MAX_POINTS)));
    return sendJson(res, 200, { ok: true, history: state.history.slice(-limit) });
  }
  if (pathname === '/api/raw') {
    return sendJson(res, 200, { ok: true, raw: sanitize(lastRawRuntime) });
  }
  if (pathname === '/api/sms') {
    return sendJson(res, 200, {
      ok: true,
      at: state.smsAt,
      meta: state.smsMeta,
      messages: state.smsMessages,
    });
  }
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      connected: state.connected,
      host: ROUTER_HOST,
      lastUpdate: state.lastUpdate,
      lastError: state.lastError,
      points: state.history.length,
      longTermPoints: analytics.points.length,
      extrasAt: state.extrasAt,
      logsAt: state.logsAt,
      extrasError: state.extrasError,
      events: analytics.events.length,
    });
  }
  if (pathname === '/api/analysis') {
    const windowMinutes = Math.max(0, Number(url.searchParams.get('window') || 0));
    return sendJson(res, 200, analytics.summary(state.snapshot, windowMinutes));
  }
  if (pathname === '/api/export.csv') {
    const windowMinutes = Math.max(0, Number(url.searchParams.get('window') || 0));
    const body = '\ufeff' + analytics.csv(windowMinutes);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="router-samples.csv"',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    return res.end(body);
  }
  if (pathname === '/api/refresh-logs') {
    fetchLogs()
      .then(() => sendJson(res, 200, { ok: true, logsAt: state.logsAt, events: analytics.events.length }))
      .catch((err) => sendJson(res, 500, { ok: false, error: String(err.message || err) }));
    return;
  }

  const rel = pathname === '/' ? 'index.html'
    : (pathname === '/analysis' || pathname === '/analysis.html') ? 'analysis.html'
      : (pathname === '/report' || pathname === '/report.html') ? 'report.html'
        : path.basename(pathname);
  if (MIME[rel]) {
    const file = path.join(PUBLIC_DIR, rel);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('静态资源读取失败');
      }
      res.writeHead(200, {
        'Content-Type': MIME[rel],
        'Cache-Control': 'no-cache',
        'Content-Length': buf.length,
      });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, BIND, async () => {
  console.log(`路由器数据看板已启动: http://${BIND}:${PORT}`);
  console.log(`上游路由器: http://${ROUTER_HOST}  主轮询: ${POLL_MS}ms  补充数据: ${EXTRAS_MS / 1000}s  日志: ${LOGS_MS / 1000}s`);
  console.log(`已恢复长历史采样点: ${analytics.points.length}`);
  await poll();
  setInterval(poll, POLL_MS);
  fetchExtras();
  // 日志页体积较大，与 30s 补充接口错开 8 秒，避免同时压到路由器
  setTimeout(fetchLogs, 8000);
  setInterval(fetchExtras, EXTRAS_MS);
  setTimeout(() => setInterval(fetchLogs, LOGS_MS), 8000);
});
