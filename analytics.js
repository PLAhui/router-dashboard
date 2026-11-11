'use strict';
/**
 * 衍生数据分析模块
 *  - 24 小时采样点持久化（JSONL，重启可恢复）
 *  - 会话统计 / 稳定性 / 健康评分 / 分时聚合 / 速率分布
 *  - 终端画像、结构化事件与阈值告警、系统日志解析
 *  - CSV 导出
 * 零第三方依赖。
 */
const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 3600 * 1000;
const MAX_POINTS = 44000;      // 24h @2s ≈ 43200
const MAX_EVENTS = 300;
const ALERT_COOLDOWN = 5 * 60 * 1000;

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, n = 1) => Math.round(v * Math.pow(10, n)) / Math.pow(10, n);
const pct = (a, b) => (b > 0 ? clamp((a / b) * 100, 0, 100) : 0);

function median(sorted) { return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; }
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[clamp(Math.ceil(sorted.length * p) - 1, 0, sorted.length - 1)];
}
function statsOf(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return { min: 0, max: 0, avg: 0, std: 0, p95: 0, count: 0 };
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - avg) ** 2, 0) / v.length;
  const sorted = [...v].sort((a, b) => a - b);
  return { min: round(sorted[0]), max: round(sorted[sorted.length - 1]), avg: round(avg, 2), std: round(Math.sqrt(variance), 2), p95: round(percentile(sorted, .95)), count: v.length };
}

class Analytics {
  constructor(dataDir, pollMs = 2000) {
    this.dataDir = dataDir;
    this.pollMs = pollMs;
    this.file = path.join(dataDir, 'samples.jsonl');
    this.points = [];
    this.profiles = new Map();
    this.events = [];
    this.alertLast = new Map();
    this.thresholdState = {};
    this.lastLogTail = null;
    this.logCounts = {};
    this.extras = { cellinfo: null, simPlans: [], sms: null, logSummary: null };
    this.startedAt = Date.now();
    this.lastPrune = 0;
    this.load();
  }

  /* ---------------- 持久化 ---------------- */
  load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (!fs.existsSync(this.file)) return;
      const text = fs.readFileSync(this.file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { this.points.push(JSON.parse(line)); } catch (_) { /* 跳过损坏行 */ }
      }
      const cutoff = Date.now() - DAY_MS;
      this.points = this.points.filter((p) => p.t >= cutoff).slice(-MAX_POINTS);
      if (this.points.length) this.startedAt = Math.min(this.startedAt, this.points[0].t);
    } catch (err) {
      console.warn('[analytics] 历史读取失败:', err.message);
    }
  }
  persist(point) {
    try {
      fs.appendFileSync(this.file, JSON.stringify(point) + '\n');
    } catch (err) {
      console.warn('[analytics] 历史写入失败:', err.message);
    }
    // 每小时裁剪一次，保留 24h
    if (Date.now() - this.lastPrune > 3600 * 1000) {
      this.lastPrune = Date.now();
      const cutoff = Date.now() - DAY_MS;
      this.points = this.points.filter((p) => p.t >= cutoff).slice(-MAX_POINTS);
      try { fs.writeFileSync(this.file, this.points.map((p) => JSON.stringify(p)).join('\n') + '\n'); } catch (_) {}
    }
  }

  /* ---------------- 事件 ---------------- */
  addEvent(type, level, title, detail, dedupeKey, cooldown = ALERT_COOLDOWN, at = null) {
    const now = Date.now();
    if (dedupeKey && cooldown > 0) {
      const last = this.alertLast.get(dedupeKey) || 0;
      if (now - last < cooldown) return false;
      this.alertLast.set(dedupeKey, now);
    }
    this.events.unshift({ t: at || now, type, level, title, detail: detail || '' });
    this.events.sort((a, b) => b.t - a.t);
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
    return true;
  }

  /* ---------------- 终端画像 + 阈值告警 ---------------- */
  trackDevices(snapshot, point) {
    const now = point.t;
    const macs = new Set(snapshot.clients.map((c) => c.mac));
    for (const c of snapshot.clients) {
      let p = this.profiles.get(c.mac);
      if (!p) {
        p = {
          mac: c.mac, name: c.name, ip: c.ip, type: c.type, ssid: c.ssid,
          firstSeen: now, lastSeen: now, onlineSec: 0, samples: 0,
          rssiMin: c.rssi, rssiMax: c.rssi, rssiSum: 0, rateSum: 0, rateSamples: 0,
          reconnects: 0, away: false,
        };
        this.profiles.set(c.mac, p);
        this.addEvent('device', 'info', '新设备接入', `${c.name} · ${c.ip}`, 'new:' + c.mac, 60000);
      } else {
        if (p.away) {
          p.away = false;
          p.reconnects += 1;
          this.addEvent('device', 'info', '终端重新接入', `${c.name} · 第 ${p.reconnects} 次重连`, 'rejoin:' + c.mac, 10000);
        }
        // 单次离开超过 2 个采样周期视为掉线（容忍偶发漏报）
        if (now - p.lastSeen > this.pollMs * 2500 / 1000 && !p.away) { /* noop */ }
        p.onlineSec += Math.min((now - p.lastSeen) / 1000, this.pollMs / 1000 * 3);
      }
      p.lastSeen = now;
      p.name = c.name; p.ip = c.ip; p.type = c.type;
      p.samples += 1;
      p.rssiMin = Math.min(p.rssiMin, c.rssi);
      p.rssiMax = Math.max(p.rssiMax, c.rssi);
      p.rssiSum += c.rssi;
      const rate = (c.rxrate || c.txrate) / 1000;
      if (rate > 0) { p.rateSum += rate; p.rateSamples += 1; }
    }
    for (const [mac, p] of this.profiles) {
      if (!macs.has(mac) && !p.away) {
        p.away = true;
        this.addEvent('device', 'warn', '终端离线', `${p.name} · ${p.ip}`, 'away:' + mac, 60000);
      }
    }
  }

  checkAlerts(snapshot, point, prev, counterReset) {
    const g = snapshot.global, c = snapshot.cellular;
    // 阈值类事件只在「正常 → 越界」时报告一次，避免长期高负载造成刷屏
    const checks = [
      ['cpu', g.cpu >= 85, 'alert', 'CPU 负载偏高', `当前 ${g.cpu}%`],
      ['mem', g.mem >= 90, 'alert', '内存占用偏高', `当前 ${g.mem}%`],
      ['temp', g.temp >= 72, 'alert', '设备温度偏高', `当前 ${g.temp}°C`],
      ['rsrp', c.rsrp <= -108, 'signal', '5G 信号较弱', `RSRP ${c.rsrp} dBm`],
    ];
    for (const [key, active, type, title, detail] of checks) {
      if (active && !this.thresholdState[key]) this.addEvent(type, 'warn', title, detail, 'thr:' + key, 0);
      this.thresholdState[key] = active;
    }
    if (point.down >= 50e6 || point.up >= 20e6) this.addEvent('traffic', 'info', '检测到高速传输', `↓${(point.down / 1e6).toFixed(1)} / ↑${(point.up / 1e6).toFixed(1)} Mbps`, 'burst', 60000);
    if (counterReset) this.addEvent('traffic', 'warn', '流量计数器复位', '累计字节数发生回退，已忽略该采样点', 'reset', 60000);
    if (prev && prev.clients !== point.clients) {
      this.addEvent('device', 'info', '在线终端数变化', `${prev.clients} → ${point.clients} 台`, 'clients', 5000);
    }
  }

  /* ---------------- 系统日志增量解析 ---------------- */
  ingestLogs(html) {
    const m = html.match(/<textarea[^>]*id=["']syslog["'][^>]*>([\s\S]*?)<\/textarea>/i);
    if (!m) return 0;
    const text = m[1]
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const lines = text.split('\n').filter((l) => l.trim());
    if (!lines.length) return 0;
    let fresh;
    if (this.lastLogTail) {
      const idx = lines.lastIndexOf(this.lastLogTail);
      fresh = idx >= 0 ? lines.slice(idx + 1) : lines.slice(-30);
    } else {
      fresh = lines.slice(-400);
    }
    this.lastLogTail = lines[lines.length - 1];
    let added = 0;
    for (const raw of fresh) {
      const parsed = this.classifyLog(raw);
      if (!parsed) continue;
      this.logCounts[parsed.type] = (this.logCounts[parsed.type] || 0) + 1;
      if (this.addEvent(parsed.type, parsed.level, parsed.title, parsed.detail, 'log:' + raw, 0, parsed.t)) added++;
    }
    this.extras.logSummary = { totalLines: lines.length, counts: { ...this.logCounts }, lastLine: this.lastLogTail.slice(0, 120) };
    return added;
  }

  classifyLog(raw) {
    // 调试噪音直接丢弃
    if (/AICWFDBG|at<<|at>>|\{api\.c->|\{debug\.c->|generate device info|reply payload|can't lookup network\.interface|debugfs:|aicwf_|rwnx_|payload \{/i.test(raw)) return null;
    const m = raw.match(/^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\.(\w+)\s+(\S+):\s*(.*)$/);
    const time = m ? m[1].slice(4, 19) : '';
    const body = m ? m[5] : raw;
    let logTs = Date.now();
    if (m) {
      const parsed = new Date(m[1].replace(/^\w{3}\s+/, ''));
      if (Number.isFinite(parsed.getTime())) logTs = parsed.getTime();
    }
    let type = null, title = null, level = 'info';
    if (/daemon\.crit|daemon\.err|kern\.err|kern\.warn.*(fail|error)/i.test(raw)) { type = 'alert'; title = '系统告警'; level = 'warn'; }
    else if (/hostapd.*(associated|AP-STA-CONNECTED)/i.test(raw)) { type = 'wifi'; title = 'WiFi 终端关联'; }
    else if (/hostapd.*(disassociated|deauth|AP-STA-DISCONNECTED)/i.test(raw)) { type = 'wifi'; title = 'WiFi 终端断开'; level = 'warn'; }
    else if (/dnsmasq.*DHCP(ACK|REQUEST|DISCOVER|OFFER)/i.test(raw)) { type = 'dhcp'; title = 'DHCP 地址分配'; }
    else if (/netifd|wanchk/i.test(raw)) { type = 'link'; title = '网络链路事件'; }
    else if (/CEREG|NR5G|register|5G.*mode|cell.*change/i.test(raw)) { type = 'cellular'; title = '蜂窝网络注册'; }
    else if (/terminal_trackd/i.test(raw)) { type = 'device'; title = '终端状态变更'; }
    else return null;

    // 脱敏：长数字串（ICCID/手机号/IMSI）、完整 MAC 仅保留后 5 位
    let detail = body.slice(0, 110)
      .replace(/\b\d{13,20}\b/g, '***')
      .replace(/([0-9A-Fa-f]{2}:){4}[0-9A-Fa-f]{2}/g, (s) => '**:**:' + s.slice(-5));
    return { type, level, title, t: logTs, detail: `${time} · ${detail}` };
  }

  /* ---------------- 主入口 ---------------- */
  ingest(point, snapshot, prevPoint, counterReset) {
    this.points.push(point);
    if (this.points.length > MAX_POINTS) this.points.splice(0, this.points.length - MAX_POINTS);
    this.persist(point);
    this.trackDevices(snapshot, point);
    this.checkAlerts(snapshot, point, prevPoint, counterReset);
  }
  setExtras(partial) { Object.assign(this.extras, partial); }

  /* ---------------- 统计 ---------------- */
  windowPoints(minutes) {
    if (!minutes || minutes <= 0) return this.points;
    const cut = Date.now() - minutes * 60000;
    return this.points.filter((p) => p.t >= cut);
  }
  sessionStats(pts) {
    if (!pts.length) return null;
    const downs = pts.map((p) => p.down), ups = pts.map((p) => p.up);
    const first = pts[0], last = pts[pts.length - 1];
    const transferredDown = Math.max(0, last.totalDown - first.totalDown);
    const transferredUp = Math.max(0, last.totalUp - first.totalUp);
    const idle = pts.filter((p) => p.down + p.up < 1000).length;
    const ds = statsOf(downs), us = statsOf(ups);
    return {
      samples: pts.length,
      durationSec: Math.max(0, (last.t - first.t) / 1000),
      startAt: first.t, endAt: last.t,
      transferredDown, transferredUp, transferredTotal: transferredDown + transferredUp,
      peakDown: ds.max, peakUp: us.max,
      avgDown: ds.avg, avgUp: us.avg,
      p95Down: ds.p95, p95Up: us.p95,
      idleRatio: round(pct(idle, pts.length)),
      peakClients: Math.max(...pts.map((p) => p.clients)),
      avgClients: statsOf(pts.map((p) => p.clients)).avg,
    };
  }
  minuteBars(minutes = 60) {
    const cut = Date.now() - minutes * 60000;
    const pts = this.points.filter((p) => p.t >= cut);
    const buckets = new Map();
    for (const p of pts) {
      const key = Math.floor(p.t / 60000) * 60000;
      let b = buckets.get(key);
      if (!b) { b = { t: key, down: 0, up: 0, samples: 0, peak: 0 }; buckets.set(key, b); }
      b.down += (p.down * this.pollMs) / 1000 / 8;
      b.up += (p.up * this.pollMs) / 1000 / 8;
      b.peak = Math.max(b.peak, p.down, p.up);
      b.samples += 1;
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t);
  }
  histogram(pts, key = 'down') {
    const edges = [0, 1e3, 1e4, 1e5, 1e6, 5e6, 10e6, 50e6, Infinity];
    const labels = ['<1K', '1–10K', '10–100K', '100K–1M', '1–5M', '5–10M', '10–50M', '>50M'];
    const bins = new Array(labels.length).fill(0);
    for (const p of pts) {
      const v = num(p[key]);
      for (let i = 0; i < edges.length - 1; i++) {
        if (v >= edges[i] && v < edges[i + 1]) { bins[i]++; break; }
      }
    }
    return { labels, bins, unit: 'bps' };
  }
  health(snapshot) {
    const g = snapshot.global, c = snapshot.cellular;
    // 每项 20~100 分：达到 good 满分，达到 bad 仍保留 20 分基线（高负载不等于故障）
    const scale = (v, good, bad) => 20 + 80 * (1 - clamp((v - good) / (bad - good), 0, 1));
    const items = [
      { key: 'signal', label: '信号强度', weight: 30, score: scale(-c.rsrp, 85, 115), value: `${c.rsrp} dBm` },
      { key: 'sinr', label: '信噪比', weight: 15, score: scale(-c.sinr, -20, 5), value: `${c.sinr} dB` },
      { key: 'cpu', label: 'CPU 余量', weight: 20, score: scale(g.cpu, 50, 100), value: `${g.cpu}% 占用` },
      { key: 'mem', label: '内存余量', weight: 15, score: scale(g.mem, 60, 95), value: `${g.mem}% 占用` },
      { key: 'temp', label: '温控余量', weight: 20, score: scale(g.temp, 45, 80), value: `${g.temp}°C` },
    ];
    const total = Math.round(items.reduce((a, x) => a + x.score * x.weight / 100, 0));
    const level = total >= 80 ? '优秀' : total >= 65 ? '良好' : total >= 45 ? '一般' : '需关注';
    return { total, level, items: items.map((x) => ({ ...x, score: Math.round(x.score) })) };
  }
  profileList() {
    return [...this.profiles.values()].map((p) => ({
      mac: p.mac, name: p.name, ip: p.ip, type: p.type, ssid: p.ssid,
      firstSeen: p.firstSeen, lastSeen: p.lastSeen, onlineSec: Math.round(p.onlineSec),
      samples: p.samples, reconnects: p.reconnects, online: !p.away,
      rssiMin: p.rssiMin, rssiMax: p.rssiMax,
      rssiAvg: p.samples ? round(p.rssiSum / p.samples) : 0,
      rateAvg: p.rateSamples ? round(p.rateSum / p.rateSamples) : 0,
    })).sort((a, b) => b.onlineSec - a.onlineSec);
  }

  summary(snapshot, windowMinutes = 0) {
    const pts = this.windowPoints(windowMinutes);
    const stability = {
      cpu: statsOf(pts.map((p) => p.cpu)),
      mem: statsOf(pts.map((p) => p.mem)),
      temp: statsOf(pts.map((p) => p.temp)),
      wifiTemp: statsOf(pts.map((p) => p.wifiTemp)),
      rsrp: statsOf(pts.map((p) => p.rsrp)),
      sinr: statsOf(pts.map((p) => p.sinr)),
      down: statsOf(pts.map((p) => p.down)),
      up: statsOf(pts.map((p) => p.up)),
      clients: statsOf(pts.map((p) => p.clients)),
    };
    return {
      ok: true,
      generatedAt: Date.now(),
      startedAt: this.startedAt,
      windowMinutes,
      totalPoints: this.points.length,
      persisted: true,
      session: this.sessionStats(pts),
      stability,
      health: snapshot ? this.health(snapshot) : null,
      minuteBars: this.minuteBars(60),
      histogramDown: this.histogram(pts, 'down'),
      histogramUp: this.histogram(pts, 'up'),
      profiles: this.profileList(),
      events: this.events.slice(0, 120),
      eventCount: this.events.length,
      logCounts: { ...this.logCounts },
      extras: this.extras,
    };
  }

  csv(windowMinutes = 0) {
    const head = 'time,down_bps,up_bps,cpu_pct,mem_pct,temp_c,wifi_temp_c,rsrp_dbm,sinr_db,clients,total_down_bytes,total_up_bytes\n';
    const rows = this.windowPoints(windowMinutes).map((p) =>
      [new Date(p.t).toISOString(), p.down, p.up, p.cpu, p.mem, p.temp, p.wifiTemp, p.rsrp, p.sinr, p.clients, p.totalDown, p.totalUp].join(',')
    ).join('\n');
    return head + rows + '\n';
  }
}

module.exports = { Analytics };
