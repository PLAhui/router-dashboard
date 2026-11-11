/* ============================================================
   NROS 路由器数据看板 · 前端
   纯原生 Canvas 绘图，无第三方依赖，可完全离线运行
   ============================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  const hexToRgba = (hex, a) => {
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    if (!Number.isFinite(n) || h.length !== 6) return `rgba(120,130,150,${a})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  /* ---------------- 格式化 ---------------- */
  const RATE_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  function fmtRate(bps) {
    let v = Math.max(0, Number(bps) || 0), i = 0;
    while (v >= 1000 && i < RATE_UNITS.length - 1) { v /= 1000; i++; }
    return { val: v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2), unit: RATE_UNITS[i] };
  }
  function fmtBytes(b) {
    let v = Math.max(0, Number(b) || 0), i = 0;
    while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
    return { val: v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2), unit: BYTE_UNITS[i] };
  }
  const rateStr = (v) => { const r = fmtRate(v); return `${r.val} ${r.unit}`; };
  const byteStr = (v) => { const r = fmtBytes(v); return `${r.val} ${r.unit}`; };
  const rateAxis = (v) => {
    if (v <= 0) return '0';
    if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)} Gbps`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)} Mbps`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)} Kbps`;
    return `${Math.round(v)} bps`;
  };
  function fmtUptime(s) {
    s = Math.max(0, Number(s) || 0);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d} 天 ${h} 小时`;
    if (h) return `${h} 小时 ${m} 分`;
    return `${m} 分 ${s % 60} 秒`;
  }
  const fmtClock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const dash = (v) => (v === undefined || v === null || v === '' ? '—' : String(v));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* 演示模式（?demo=1）：终端名 / MAC / 短信内容替换为虚构数据，用于截图与演示 */
  const DEMO = new URLSearchParams(location.search).has('demo');
  const FAKE_NAMES = ['iPhone', 'MacBook Pro', 'Android 手机', 'iPad', '智能电视', 'Ubuntu 主机'];
  const FAKE_SMS = [
    { contact: '10086', content: '【中国移动】您本月已使用流量 12.35GB，套餐剩余 7.65GB，详情请查询掌上营业厅。' },
    { contact: '106901234567', content: '【快递提醒】您的包裹已到达小区驿站，取件码 8821，请及时领取。' },
    { contact: '10010', content: '尊敬的用户，您的话费余额为 86.50 元，感谢您的使用。' },
  ];
  const demoClients = (list) => DEMO
    ? (list || []).map((c, i) => ({ ...c, name: FAKE_NAMES[i % FAKE_NAMES.length], mac: 'A4:83:E7:**:**:**', ssid: 'Home-5G' }))
    : list;
  const demoSms = (list) => DEMO
    ? (list || []).map((m, i) => ({ ...m, contact: FAKE_SMS[i % FAKE_SMS.length].contact, content: FAKE_SMS[i % FAKE_SMS.length].content }))
    : list;

  /* ---------------- Canvas 折线图 ---------------- */
  function niceCeil(v) {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v)), base = Math.pow(10, exp), n = v / base;
    // 细粒度刻度，避免 5.1 -> 100 造成曲线被压扁
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    return (steps.find((s) => n <= s) || 10) * base;
  }

  class LineChart {
    constructor(canvas, options) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign({ gridLines: 4, zeroBase: true, padL: 50, padR: 12, padT: 12, padB: 22 }, options);
      this.data = [];
      this.hover = -1;
      this.dpr = 1;
      this.resize();
      canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const { padL, padR } = this.opts;
        const w = r.width - padL - padR;
        if (this.data.length < 2 || w <= 0) return;
        this.hover = clamp(Math.round(((x - padL) / w) * (this.data.length - 1)), 0, this.data.length - 1);
        this.draw();
        this.showTooltip(e.clientX, e.clientY);
      });
      canvas.addEventListener('mouseleave', () => {
        this.hover = -1;
        this.draw();
        $('tooltip').classList.remove('show');
      });
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(r.width * this.dpr);
      this.canvas.height = Math.round(r.height * this.dpr);
      this.w = r.width; this.h = r.height;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    setData(points) { this.data = points || []; if (this.hover >= this.data.length) this.hover = -1; this.draw(); }
    bounds() {
      const o = this.opts;
      if (o.yMin != null && o.yMax != null) return [o.yMin, o.yMax];
      let mn = Infinity, mx = -Infinity;
      for (const p of this.data) for (const s of o.series) {
        const v = Number(p[s.key]);
        if (Number.isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
      }
      if (!Number.isFinite(mn)) { mn = 0; mx = 1; }
      if (o.zeroBase) { mn = 0; mx = niceCeil(Math.max(mx * 1.18, 1)); }
      else {
        const pad = (mx - mn) * 0.28 || 3;
        mn = Math.floor(mn - pad); mx = Math.ceil(mx + pad);
      }
      return [o.yMin != null ? o.yMin : mn, o.yMax != null ? o.yMax : mx];
    }
    draw() {
      const { ctx, w, h, opts: o } = this;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);
      const padL = o.padL, padR = o.padR, padT = o.padT, padB = o.padB;
      const cw = w - padL - padR, ch = h - padT - padB;
      const [mn, mx] = this.bounds();
      const span = mx - mn || 1;
      const yOf = (v) => padT + ch - ((v - mn) / span) * ch;
      const xOf = (i) => padL + (this.data.length < 2 ? 0 : (i / (this.data.length - 1)) * cw);

      // 网格 + Y 轴刻度
      ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let i = 0; i <= o.gridLines; i++) {
        const v = mn + (span * i) / o.gridLines, y = yOf(v);
        ctx.strokeStyle = cssVar('--grid');
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, y + .5); ctx.lineTo(w - padR, y + .5); ctx.stroke();
        ctx.fillStyle = cssVar('--text-3');
        ctx.fillText(o.yFormat ? o.yFormat(v) : String(Math.round(v)), padL - 8, y);
      }
      if (this.data.length < 2) {
        ctx.fillStyle = cssVar('--text-3'); ctx.textAlign = 'center';
        ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText('正在采集数据…', padL + cw / 2, padT + ch / 2);
        return;
      }
      // X 轴时间刻度
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = cssVar('--text-3');
      const labels = Math.min(4, this.data.length);
      for (let i = 0; i < labels; i++) {
        const idx = Math.round((i / (labels - 1 || 1)) * (this.data.length - 1));
        ctx.fillText(fmtClock(this.data[idx].t).slice(3), xOf(idx), h - padB + 6);
      }
      // 序列
      for (const s of o.series) {
        const color = cssVar(s.color);
        const pts = this.data.map((p, i) => [xOf(i), yOf(clamp(Number(p[s.key]) || 0, mn, mx))]);
        const path = () => {
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length - 1; i++) {
            const mxp = (pts[i][0] + pts[i + 1][0]) / 2, myp = (pts[i][1] + pts[i + 1][1]) / 2;
            ctx.quadraticCurveTo(pts[i][0], pts[i][1], mxp, myp);
          }
          ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        };
        if (s.fill !== false) {
          path();
          ctx.lineTo(pts[pts.length - 1][0], padT + ch);
          ctx.lineTo(pts[0][0], padT + ch);
          ctx.closePath();
          const grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
          grad.addColorStop(0, hexToRgba(color, .26));
          grad.addColorStop(1, hexToRgba(color, .005));
          ctx.fillStyle = grad; ctx.fill();
        }
        path();
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.stroke();
        // 末端圆点
        const last = pts[pts.length - 1];
        ctx.fillStyle = cssVar('--card'); ctx.beginPath(); ctx.arc(last[0], last[1], 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(last[0], last[1], 2.4, 0, Math.PI * 2); ctx.fill();
      }
      // 悬停十字线
      if (this.hover >= 0 && this.hover < this.data.length) {
        const x = xOf(this.hover);
        ctx.strokeStyle = cssVar('--text-3'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke(); ctx.setLineDash([]);
        for (const s of o.series) {
          const y = yOf(clamp(Number(this.data[this.hover][s.key]) || 0, mn, mx));
          ctx.fillStyle = cssVar(s.color); ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = cssVar('--card'); ctx.lineWidth = 2; ctx.stroke();
        }
      }
    }
    showTooltip(clientX, clientY) {
      const p = this.data[this.hover];
      if (!p) return;
      const rows = this.opts.series.map((s) =>
        `<div class="tt-row"><i style="background:${cssVar(s.color)}"></i><span>${esc(s.label)}</span><b>${esc(s.format ? s.format(p[s.key]) : p[s.key])}</b></div>`
      ).join('');
      const tip = $('tooltip');
      tip.innerHTML = `<div class="tt-time">${fmtClock(p.t)}</div>${rows}`;
      tip.style.left = clientX + 'px';
      tip.style.top = (clientY - 8) + 'px';
      tip.classList.add('show');
    }
  }

  /* ---------------- 迷你趋势线 ---------------- */
  const sparks = [];
  function drawSpark(canvas, values, varName) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const v = (values || []).filter(Number.isFinite);
    if (v.length < 2) return;
    let mn = Math.min(...v), mx = Math.max(...v);
    const pad = (mx - mn) * .25 || 1; mn -= pad; mx += pad;
    const color = cssVar(varName);
    const pts = v.map((x, i) => [2 + (i / (v.length - 1)) * (r.width - 4), r.height - 3 - ((x - mn) / (mx - mn || 1)) * (r.height - 7)]);
    const path = () => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
      }
      ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    };
    path(); ctx.lineTo(pts[pts.length - 1][0], r.height); ctx.lineTo(pts[0][0], r.height); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, r.height);
    g.addColorStop(0, hexToRgba(color, .3)); g.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = g; ctx.fill();
    path(); ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
    const last = pts[pts.length - 1];
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(last[0], last[1], 2.2, 0, Math.PI * 2); ctx.fill();
  }

  /* ---------------- 图表实例 ---------------- */
  const R = (v) => rateStr(v);
  const seriesDefs = {
    down: { key: 'down', color: '--c-blue', label: '下载', format: R, fill: true },
    up: { key: 'up', color: '--c-teal', label: '上传', format: R, fill: true },
    cpu: { key: 'cpu', color: '--c-amber', label: 'CPU', format: (v) => `${Math.round(v)}%` },
    mem: { key: 'mem', color: '--c-rose', label: '内存', format: (v) => `${Math.round(v)}%` },
    temp: { key: 'temp', color: '--c-green', label: '设备温度', format: (v) => `${Math.round(v)} °C` },
    wifiTemp: { key: 'wifiTemp', color: '--c-blue', label: 'WiFi 芯片', format: (v) => `${Math.round(v)} °C` },
    rsrp: { key: 'rsrp', color: '--c-violet', label: 'RSRP', format: (v) => `${Math.round(v)} dBm` },
  };
  const charts = {
    traffic: new LineChart($('trafficChart'), { series: [seriesDefs.down, seriesDefs.up], yFormat: rateAxis, gridLines: 4, zeroBase: true, padL: 64 }),
    load: new LineChart($('loadChart'), { series: [seriesDefs.cpu, seriesDefs.mem], yMin: 0, yMax: 100, yFormat: (v) => `${Math.round(v)}%`, gridLines: 4 }),
    temp: new LineChart($('tempChart'), { series: [seriesDefs.temp, seriesDefs.wifiTemp], yFormat: (v) => `${Math.round(v)}°`, gridLines: 3, zeroBase: false }),
    signal: new LineChart($('signalChart'), { series: [seriesDefs.rsrp], yFormat: (v) => `${Math.round(v)}`, gridLines: 3, zeroBase: false }),
  };
  const sparkDefs = [
    ['spDown', 'down', '--c-blue'], ['spUp', 'up', '--c-teal'], ['spClients', 'clients', '--c-violet'],
    ['spCpu', 'cpu', '--c-amber'], ['spMem', 'mem', '--c-rose'], ['spTemp', 'temp', '--c-green'],
  ];

  let rangeMin = 1;
  let POLL_MS = 2000;
  let latest = null;
  let lastRenderedUpdate = 0;

  function slicedHistory(hist, minutes) {
    const n = Math.max(2, Math.round((minutes * 60000) / POLL_MS));
    return hist.slice(-n);
  }

  /* ---------------- DOM 辅助 ---------------- */
  function kv(container, items) {
    container.innerHTML = items.map(([k, v, mono]) =>
      `<div><span>${esc(k)}</span><b class="${mono ? 'mono' : ''}" title="${esc(v)}">${esc(v)}</b></div>`
    ).join('');
  }
  const deviceIcon = (type) => type === 'wireless'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 19v2m8-2v2M4 10h16"/></svg>';

  /* ---------------- 渲染 ---------------- */
  function render(d) {
    const s = d.snapshot;
    const hist = d.history || [];
    POLL_MS = d.pollMs || 2000;
    const view = slicedHistory(hist, rangeMin);

    // 连接状态
    const fresh = d.connected && Date.now() - d.lastUpdate < 12000;
    const pill = $('livePill');
    pill.dataset.state = fresh ? 'online' : 'offline';
    $('liveText').textContent = fresh ? `实时 · ${POLL_MS / 1000}s` : (d.lastError ? '连接异常' : '离线');
    $('footStatus').textContent = fresh
      ? `正常 · 已采样 ${d.pollCount} 次`
      : `中断 · ${d.lastError || '等待路由器响应'}`;
    $('footHost').textContent = `上游 ${d.boot?.host || d.snapshot?.meta?.host || '路由器'} · 会话由服务端持有`;
    $('footInterval').textContent = `${POLL_MS / 1000}s`;
    if (s) {
      $('footRuntime').textContent = `POST ${s.meta.runtimePath}`;
      $('footSpeed').textContent = `GET /cgi-bin/luci/nradio/status/speed/${s.meta.wanNames}`;
    }

    if (!s) return;

    /* 顶栏 & 概览 */
    $('topModel').textContent = s.device.model;
    $('topFirmware').textContent = s.device.firmware;
    const mode = s.cellular.mode || s.global.netType || '—';
    $('heroNet').textContent = `${s.global.netType || '蜂窝网络'} · ${mode}`;
    $('heroIsp').textContent = `${s.cellular.isp} · SIM${s.cellular.simNo} · ${s.cellular.band} ${s.cellular.phone || ''}`;
    $('heroUptime').textContent = fmtUptime(s.global.uptime);
    $('heroTotalDown').textContent = byteStr(s.totals.download);
    $('heroTotalUp').textContent = byteStr(s.totals.upload);
    $('heroPoints').textContent = `${hist.length} / ${d.maxPoints}`;
    const hEl = $('heroHealth');
    if (s.health) {
      hEl.textContent = `${s.health.total} 分 · ${s.health.level}`;
      hEl.style.color = s.health.total >= 80 ? cssVar('--c-green')
        : s.health.total >= 65 ? cssVar('--c-blue') : s.health.total >= 45 ? cssVar('--c-amber') : cssVar('--c-red');
    }

    /* KPI */
    const dl = fmtRate(s.rates.down), ul = fmtRate(s.rates.up);
    $('kDownVal').textContent = dl.val; $('kDownUnit').textContent = dl.unit;
    $('kUpVal').textContent = ul.val; $('kUpUnit').textContent = ul.unit;
    const recent = hist.slice(-Math.round(60000 / POLL_MS));
    const peakD = recent.length ? Math.max(...recent.map((p) => p.down)) : 0;
    const peakU = recent.length ? Math.max(...recent.map((p) => p.up)) : 0;
    $('kDownNote').textContent = `1 分钟峰值 ${rateStr(peakD)}`;
    $('kUpNote').textContent = `1 分钟峰值 ${rateStr(peakU)}`;
    $('kClientVal').textContent = s.clientCount;
    const wireless = s.clients.filter((c) => c.type === 'wireless').length;
    $('kClientNote').textContent = `无线 ${wireless} · 其他 ${s.clientCount - wireless}`;
    $('kCpuVal').textContent = s.global.cpu;
    $('kCpuNote').textContent = s.global.cpu >= 80 ? '负载较高' : s.global.cpu >= 50 ? '负载正常' : '较为空闲';
    $('kMemVal').textContent = s.global.mem;
    $('kMemNote').textContent = s.global.mem >= 85 ? '内存紧张' : '内存充足';
    $('kTempVal').textContent = s.global.temp;
    $('kTempNote').textContent = `WiFi ${s.global.wifiTemp}°C`;
    const sparkHist = hist.slice(-40);
    for (const [id, key, color] of sparkDefs) drawSpark($(id), sparkHist.map((p) => p[key]), color);

    /* 图表 */
    charts.traffic.setData(view);
    charts.load.setData(view);
    charts.temp.setData(view);
    charts.signal.setData(view);
    $('peakDown').textContent = view.length ? rateStr(Math.max(...view.map((p) => p.down))) : '—';
    $('peakUp').textContent = view.length ? rateStr(Math.max(...view.map((p) => p.up))) : '—';
    const avg = view.length ? view.reduce((a, p) => a + p.down, 0) / view.length : 0;
    $('avgDown').textContent = rateStr(avg);
    $('lastUpdate').textContent = fmtClock(d.lastUpdate);

    /* 信号仪表 */
    const rsrp = s.cellular.rsrp;
    const quality = clamp((rsrp + 115) / 60, 0, 1);
    const CIRC = 515.2;
    const arc = $('gaugeArc');
    arc.style.strokeDasharray = CIRC;
    arc.style.strokeDashoffset = CIRC * (1 - quality);
    const level = rsrp >= -80 ? '信号优秀' : rsrp >= -95 ? '信号良好' : rsrp >= -105 ? '信号一般' : '信号较弱';
    const levelColor = quality > .65 ? '--c-green' : quality > .4 ? '--c-amber' : '--c-red';
    arc.style.stroke = cssVar(levelColor);
    $('signalLevel').textContent = level;
    $('signalLevel').style.background = `color-mix(in srgb, ${cssVar(levelColor)} 12%, transparent)`;
    $('signalLevel').style.color = cssVar(levelColor);
    $('rsrpVal').textContent = Math.round(rsrp);
    $('sinrVal').textContent = `${s.cellular.sinr} dB`;
    $('rsrqVal').textContent = `${s.cellular.rsrq} dB`;
    $('cqiVal').textContent = s.cellular.cqi;
    $('sinrBar').style.width = clamp((s.cellular.sinr + 5) / 30 * 100, 0, 100) + '%';
    $('rsrqBar').style.width = clamp((s.cellular.rsrq + 20) / 18 * 100, 0, 100) + '%';
    $('cqiBar').style.width = clamp(s.cellular.cqi / 15 * 100, 0, 100) + '%';
    $('netModeTag').textContent = `${mode} · ${s.cellular.band}`;
    $('bandVal').textContent = s.cellular.band;
    $('pciVal').textContent = s.cellular.pci;
    $('earfcnVal').textContent = s.cellular.earfcn;
    $('ambrDlVal').textContent = s.cellular.ambrDown ? `${s.cellular.ambrDown / 1000} Mbps` : '—';

    /* 蜂窝网络 */
    $('ispTag').textContent = s.cellular.isp;
    kv($('cellularKv'), [
      ['运营商', s.cellular.isp], ['网络制式', `${mode} / ${s.cellular.band}`],
      ['RSRP', `${rsrp} dBm`], ['RSRQ', `${s.cellular.rsrq} dB`],
      ['SINR', `${s.cellular.sinr} dB`], ['RSSI', `${s.cellular.rssi} dBm`],
      ['PCI / EARFCN', `${s.cellular.pci} / ${s.cellular.earfcn}`], ['小区 / TAC', `${s.cellular.cell} / ${s.cellular.tac}`],
      ['AMBR 下行', s.cellular.ambrDown ? `${s.cellular.ambrDown / 1000} Mbps` : '—'],
      ['AMBR 上行', s.cellular.ambrUp ? `${s.cellular.ambrUp / 1000} Mbps` : '—'],
      ['SIM 卡位', `SIM ${s.cellular.simNo}`], ['号码', s.cellular.phone || '—'],
      ['ICCID', s.cellular.iccid || '—'], ['模组', s.cellular.model, true],
    ]);

    /* WAN / LAN */
    $('wanProtoTag').textContent = String(s.wan.proto).toUpperCase();
    $('wanDevice').textContent = s.wan.device;
    kv($('wanKv'), [
      ['接口', s.wan.name], ['协议', s.wan.proto],
      ['IPv4', s.wan.ip, true], ['IPv6', s.wan.ipv6, true],
      ['DNS', (s.wan.dns || []).join(' / ') || '—', true], ['连接时长', fmtUptime(s.wan.uptime)],
    ]);
    $('lanDevice').textContent = s.lan.device;
    kv($('lanKv'), [
      ['接口', s.lan.device], ['协议', s.lan.proto],
      ['IPv4', s.lan.ip, true], ['IPv6', s.lan.ipv6, true],
      ['设备 MAC', s.device.mac, true], ['固件', s.device.firmware],
    ]);

    /* 流量用量 */
    const dlB = s.totals.download, ulB = s.totals.upload;
    const total = dlB + ulB;
    const dlDeg = total > 0 ? (dlB / total) * 360 : 320;
    $('trafficDonut').style.background = `conic-gradient(${cssVar('--c-blue')} 0deg ${dlDeg}deg, ${cssVar('--c-teal')} ${dlDeg}deg 360deg)`;
    $('totalTraffic').textContent = byteStr(total).replace(' ', '\u00a0');
    $('dlTotal').textContent = byteStr(dlB);
    $('ulTotal').textContent = byteStr(ulB);
    $('simMonth').textContent = s.totals.simMonth ? byteStr(s.totals.simMonth) : '—';

    /* WiFi */
    $('wifiStaTag').textContent = `${s.wifi.clients} 台在线`;
    $('wifiSsid').textContent = s.wifi.ssid;
    $('wifiBand').textContent = `${s.wifi.frequency} GHz · 信道 ${s.wifi.channel}`;
    kv($('wifiKv'), [
      ['加密方式', s.wifi.encryption], ['信道', s.wifi.channel],
      ['频率', `${s.wifi.frequency} GHz`], ['接入终端', `${s.wifi.clients} 台`],
      ['5G 射频', s.wifi.radio5Disabled ? '已关闭' : '启用'], ['2.4G 射频', s.wifi.radio2Disabled ? '已关闭' : '启用'],
    ]);

    /* 终端速率排行 */
    const clients = demoClients(s.clients);
    const ranked = clients.map((c) => ({ ...c, rate: (c.rxrate || c.txrate) / 1000 }))
      .sort((a, b) => b.rate - a.rate).slice(0, 5);
    const maxRate = Math.max(1, ...ranked.map((c) => c.rate));
    $('clientRank').innerHTML = ranked.length ? ranked.map((c) => `
      <div class="rank-row">
        <div class="rank-top"><span class="rank-name">${esc(c.name)}</span><span class="rank-val">${c.rate.toFixed(0)} Mbps</span></div>
        <div class="rank-track"><i style="width:${clamp(c.rate / maxRate * 100, 2, 100)}%"></i></div>
      </div>`).join('') : '<p class="empty">暂无已连接终端</p>';

    /* 终端表 */
    $('clientCountTag').textContent = `${s.clientCount} 台`;
    $('clientSummary').textContent = `共 ${s.clientCount} 台设备接入 · ${wireless} 台无线 · 按信号强度排序`;
    $('clientRows').innerHTML = clients.length ? clients.map((c) => {
      const bars = c.rssi >= -55 ? 4 : c.rssi >= -68 ? 3 : c.rssi >= -80 ? 2 : 1;
      const cls = bars >= 3 ? 'on' : bars === 2 ? 'on mid' : 'on low';
      const signalBars = [1, 2, 3, 4].map((i) => `<i class="${i <= bars ? cls : ''}"></i>`).join('');
      const rate = ((c.rxrate || c.txrate) / 1000).toFixed(0);
      return `<tr>
        <td><div class="dev-cell"><div class="dev-icon">${deviceIcon(c.type)}</div><div><div class="dev-name">${esc(c.name)}</div><div class="dev-sub">${esc(c.type === 'wireless' ? '无线接入' : '有线接入')} · ${esc(c.ssid || c.ifname)}</div></div></div></td>
        <td class="mono-cell">${esc(c.ip)}</td>
        <td class="mono-cell">${esc(c.mac)}</td>
        <td><div class="signal-cell"><div class="signal-bars">${signalBars}</div><span>${c.rssi} dBm</span></div></td>
        <td>${rate} Mbps</td>
        <td>${fmtUptime(c.assoctime)}</td>
        <td class="mono-cell">${esc(c.frequency ? c.frequency + ' GHz' : '—')} / ${esc(c.channel)}</td>
        <td><span class="pill-ok ${c.blocked ? 'pill-off' : ''}">${c.blocked ? '已禁用' : '在线'}</span></td>
      </tr>`;
    }).join('') : '<tr><td colspan="8" class="empty">暂无已连接终端</td></tr>';
  }

  /* ---------------- 轮询与倒计时 ---------------- */
  async function tick() {
    try {
      const res = await fetch('/api/snapshot', { cache: 'no-store' });
      const d = await res.json();
      latest = d;
      if (d.lastUpdate !== lastRenderedUpdate || !d.connected) {
        lastRenderedUpdate = d.lastUpdate;
        render(d);
      }
    } catch (err) {
      const pill = $('livePill');
      pill.dataset.state = 'offline';
      $('liveText').textContent = '代理服务未响应';
      $('footStatus').textContent = '无法连接本地代理服务：' + err.message;
    }
  }

  function countdown() {
    if (!latest) return;
    const elapsed = Date.now() - latest.lastUpdate;
    const ratio = clamp(elapsed / POLL_MS, 0, 1);
    $('refreshArc').style.strokeDashoffset = 94.25 * ratio;
    $('refreshSec').textContent = Math.max(0, Math.ceil((POLL_MS - elapsed) / 1000));
  }

  /* ---------------- 交互 ---------------- */
  $('rangeGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-min]');
    if (!btn) return;
    rangeMin = Number(btn.dataset.min);
    [...$('rangeGroup').children].forEach((b) => b.classList.toggle('active', b === btn));
    if (latest) render(latest);
  });

  const savedTheme = new URLSearchParams(location.search).get('theme') || localStorage.getItem('nros-theme');
  if (savedTheme === 'dark') document.documentElement.dataset.theme = 'dark';
  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('nros-theme', next);
    if (latest) render(latest);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      Object.values(charts).forEach((c) => { c.resize(); c.draw(); });
      if (latest && latest.snapshot) {
        const h = latest.history.slice(-40);
        for (const [id, key, color] of sparkDefs) drawSpark($(id), h.map((p) => p[key]), color);
      }
    }, 120);
  });

  /* ---------------- 短信收件箱 ---------------- */
  const fmtSmsTime = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const hm = d.toLocaleTimeString('zh-CN', { hour12: false });
    return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };

  function renderSms(d) {
    const list = demoSms(d.messages || []);
    const meta = d.meta || {};
    const unread = meta.unread || list.filter((m) => m.stat === 0).length;
    $('smsUnreadTag').textContent = `未读 ${unread}`;
    $('smsSummary').textContent = list.length
      ? `共 ${list.length} 条（容量 ${meta.used || 0}/${meta.total || 0}）· 每 15 秒同步`
      : 'SIM 卡短信 · 每 15 秒同步';
    const box = $('smsList');
    if (!list.length) { box.innerHTML = '<p class="empty">暂无短信</p>'; return; }
    box.innerHTML = list.map((m) => `
      <div class="sms-item${m.stat === 0 ? ' unread' : ''}">
        <div class="sms-meta">
          <span class="sms-sender">${esc(m.contact)}</span>
          <span class="sms-time">${fmtSmsTime(m.t)}</span>
        </div>
        <div class="sms-content">${esc(m.content)}</div>
      </div>`).join('');
  }

  async function loadSms() {
    try {
      const res = await fetch('/api/sms');
      const d = await res.json();
      if (d.ok) renderSms(d);
    } catch (_) { /* 下个周期重试 */ }
  }

  // 首屏先渲染一次骨架，随后立即拉数据
  tick();
  loadSms();
  setInterval(tick, 1000);
  setInterval(countdown, 200);
  setInterval(loadSms, 15000);
})();
