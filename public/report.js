/* ============ 运行报告渲染 ============ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

  /* 演示模式（?demo=1）：终端名 / MAC / 短信内容替换为虚构数据，用于截图与演示 */
  const DEMO = new URLSearchParams(location.search).has('demo');
  const FAKE_NAMES = ['iPhone', 'MacBook Pro', 'Android 手机', 'iPad', '智能电视', 'Ubuntu 主机'];
  const FAKE_SMS = [
    { contact: '10086', content: '【中国移动】您本月已使用流量 12.35GB，套餐剩余 7.65GB，详情请查询掌上营业厅。' },
    { contact: '106901234567', content: '【快递提醒】您的包裹已到达小区驿站，取件码 8821，请及时领取。' },
    { contact: '10010', content: '尊敬的用户，您的话费余额为 86.50 元，感谢您的使用。' },
  ];
  const realNames = new Set();
  function scrubDemo(s) {
    let out = String(s ?? '');
    let i = 0;
    for (const n of realNames) out = out.split(n).join(FAKE_NAMES[i++ % FAKE_NAMES.length]);
    out = out.replace(/([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/g, 'A4:83:E7:**:**:**');
    return out.replace(/\*\*:\*\*:[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})+/g, '**:**:**:**:**');
  }
  function demoApply(a, snap) {
    if (!DEMO) return;
    ((snap && snap.clients) || []).forEach((c) => c.name && realNames.add(c.name));
    (a.profiles || []).forEach((p) => p.name && realNames.add(p.name));
    if (a.events) a.events = a.events.map((e) => ({ ...e, title: scrubDemo(e.title), detail: scrubDemo(e.detail) }));
    if (a.profiles) a.profiles = a.profiles.map((p, i) => ({ ...p, name: FAKE_NAMES[i % FAKE_NAMES.length], mac: 'A4:83:E7:**:**:**' }));
  }
  const demoSms = (list) => DEMO
    ? (list || []).map((m, i) => ({ ...m, contact: FAKE_SMS[i % FAKE_SMS.length].contact, content: FAKE_SMS[i % FAKE_SMS.length].content }))
    : list;

  const fmtBytes = (b) => {
    b = num(b);
    if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
    if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
    if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
    return `${b} B`;
  };
  const fmtRate = (b) => {
    b = num(b);
    if (b >= 1e6) return `${(b / 1e6).toFixed(1)} Mbps`;
    if (b >= 1e3) return `${(b / 1e3).toFixed(0)} Kbps`;
    return `${b.toFixed(0)} bps`;
  };
  const fmtDuration = (s) => {
    s = Math.max(0, num(s));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d} 天 ${h} 小时`;
    if (h) return `${h} 小时 ${m} 分`;
    if (m) return `${m} 分 ${s % 60} 秒`;
    return `${s} 秒`;
  };
  const fmtClock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  const fmtFull = (ts) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('zh-CN', { hour12: false })}`;
  };

  let windowMin = new URLSearchParams(location.search).get('window') ?? '0';
  let reportNo = '';

  /* ---------------- SVG 图表 ---------------- */
  // 分时流量：双系列柱状图，自动聚合到 ≤48 根
  function barChart(bars) {
    if (!bars || !bars.length) return '<p class="empty">暂无采样数据</p>';
    const target = 48;
    const group = Math.max(1, Math.ceil(bars.length / target));
    const agg = [];
    for (let i = 0; i < bars.length; i += group) {
      const chunk = bars.slice(i, i + group);
      agg.push({
        t: chunk[chunk.length - 1].t,
        down: chunk.reduce((s, b) => s + num(b.down), 0),
        up: chunk.reduce((s, b) => s + num(b.up), 0),
      });
    }
    const W = 880, H = 190, padL = 52, padB = 24, padT = 8;
    const innerW = W - padL - 12, innerH = H - padB - padT;
    const mx = Math.max(1, ...agg.map((a) => Math.max(a.down, a.up)));
    const maxMB = mx / 1e6;
    const step = maxMB <= 5 ? 1 : maxMB <= 10 ? 2 : maxMB <= 25 ? 5 : maxMB <= 50 ? 10 : maxMB <= 100 ? 20 : maxMB <= 250 ? 50 : maxMB <= 500 ? 100 : 250;
    const yMax = Math.ceil(maxMB / step) * step;
    const bw = innerW / agg.length;
    const barW = Math.max(1.5, Math.min(bw * 0.62, 14));
    const yOf = (v) => padT + innerH * (1 - v / 1e6 / yMax);
    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
    for (let y = 0; y <= yMax; y += step) {
      const yy = yOf(y * 1e6);
      svg += `<line x1="${padL}" y1="${yy}" x2="${W - 12}" y2="${yy}" stroke="#eef2f7"/>`;
      svg += `<text x="${padL - 7}" y="${yy + 3.5}" font-size="10" fill="#8492a9" text-anchor="end">${y}</text>`;
    }
    const tickN = Math.min(6, agg.length);
    for (let i = 0; i < tickN; i++) {
      const idx = Math.round((i / (tickN - 1 || 1)) * (agg.length - 1));
      const x = padL + idx * bw + bw / 2;
      svg += `<text x="${x}" y="${H - 8}" font-size="10" fill="#8492a9" text-anchor="middle">${fmtClock(agg[idx].t).slice(0, 5)}</text>`;
    }
    agg.forEach((a, i) => {
      const x0 = padL + i * bw + (bw - barW * 2 - 1.5) / 2;
      const dH = Math.max(0.5, padT + innerH - yOf(a.down));
      const uH = Math.max(0.5, padT + innerH - yOf(a.up));
      svg += `<rect x="${x0}" y="${yOf(a.down)}" width="${barW}" height="${dH}" rx="1.5" fill="#3f7ef2"/>`;
      svg += `<rect x="${x0 + barW + 1.5}" y="${yOf(a.up)}" width="${barW}" height="${uH}" rx="1.5" fill="#16a8a0"/>`;
    });
    svg += `<text x="${padL - 7}" y="${padT + 3}" font-size="10" fill="#8492a9" text-anchor="end">MB</text>`;
    svg += '</svg>';
    svg += `<p style="font-size:10.5px;color:#8492a9;margin-top:6px"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#3f7ef2;margin-right:4px"></i>下载 <i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#16a8a0;margin:0 4px 0 12px"></i>上传　·　每 ${group} 分钟聚合</p>`;
    return svg;
  }

  // 直方图：单系列
  function histSvg(hist, color) {
    const { labels, bins } = hist;
    const mx = Math.max(1, ...bins);
    const W = 420, H = 150, padL = 8, padB = 30, padT = 6;
    const innerW = W - padL - 8, innerH = H - padB - padT;
    const bw = innerW / bins.length;
    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
    bins.forEach((v, i) => {
      const h = Math.max(v ? 2 : 0, (v / mx) * innerH);
      const x = padL + i * bw + bw * 0.12;
      svg += `<rect x="${x}" y="${padT + innerH - h}" width="${bw * 0.76}" height="${h}" rx="2.5" fill="${color}"/>`;
      if (v) svg += `<text x="${x + bw * 0.38}" y="${padT + innerH - h - 3}" font-size="9" fill="#8492a9" text-anchor="middle">${v}</text>`;
      svg += `<text x="${padL + i * bw + bw / 2}" y="${H - 16}" font-size="8.5" fill="#8492a9" text-anchor="middle" transform="rotate(0)">${labels[i]}</text>`;
    });
    svg += '</svg>';
    return svg;
  }

  // 健康评分环
  function healthRing(total, level) {
    const color = total >= 80 ? '#2ba471' : total >= 65 ? '#3f7ef2' : total >= 45 ? '#e5a13a' : '#ea5b74';
    const r = 52, C = 2 * Math.PI * r;
    const off = C * (1 - total / 100);
    return `<svg viewBox="0 0 130 130" width="130" height="130">
      <circle cx="65" cy="65" r="${r}" fill="none" stroke="#eef2f7" stroke-width="11"/>
      <circle cx="65" cy="65" r="${r}" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round"
        stroke-dasharray="${C}" stroke-dashoffset="${off}" transform="rotate(-90 65 65)"/>
      <text x="65" y="62" text-anchor="middle" font-size="26" font-weight="700" fill="${color}">${total}</text>
      <text x="65" y="82" text-anchor="middle" font-size="11" fill="#8492a9">${esc(level)}</text>
    </svg>`;
  }

  /* ---------------- 各区块渲染 ---------------- */
  function renderOverview(a, snap) {
    const h = a.health;
    $('healthRing').innerHTML = healthRing(h.total, h.level);
    const tone = (s) => (s >= 80 ? '#2ba471' : s >= 60 ? '#3f7ef2' : s >= 40 ? '#e5a13a' : '#ea5b74');
    $('healthItems').innerHTML = h.items.map((it) => `
      <div class="hi-row">
        <div class="hi-top"><b>${esc(it.label)} <span style="color:#8492a9;font-weight:400">权重 ${it.weight}%</span></b><span>${esc(it.value)} · ${it.score} 分</span></div>
        <div class="hi-bar"><i style="width:${it.score}%;background:${tone(it.score)}"></i></div>
      </div>`).join('');

    const g = snap.global, cel = snap.cellular, wan = snap.wan, lan = snap.lan;
    const rows = [
      ['设备型号', `${snap.device.model}（${snap.device.firmware}）`],
      ['运营商 / 制式', `${cel.isp} · ${cel.mode} · ${cel.band}`],
      ['运行时长', fmtDuration(g.uptime)],
      ['SIM 卡号', cel.phone],
      ['WAN 地址', wan.ipv4 || '-', ],
      ['LAN 网段', lan.ipv4 || '-'],
      ['5G 信号 RSRP', `${cel.rsrp} dBm`, cel.rsrp <= -105 ? 'warn' : cel.rsrp >= -90 ? 'good' : ''],
      ['信噪比 SINR', `${cel.sinr} dB`, cel.sinr <= 0 ? 'warn' : cel.sinr >= 15 ? 'good' : ''],
      ['CPU / 内存', `${g.cpu}% / ${g.mem}%`, g.cpu >= 85 || g.mem >= 90 ? 'warn' : ''],
      ['设备温度', `${g.temp}°C（WiFi ${g.wifiTemp}°C）`, g.temp >= 70 ? 'warn' : ''],
    ];
    $('ovKv').innerHTML = rows.map(([k, v, cls]) => `<div><span>${esc(k)}</span><b class="${cls || ''}">${esc(v)}</b></div>`).join('');
  }

  function renderTraffic(a) {
    const s = a.session;
    const cells = [
      ['累计下载', fmtBytes(s.transferredDown), ''],
      ['累计上传', fmtBytes(s.transferredUp), ''],
      ['总传输量', fmtBytes(s.transferredTotal), ''],
      ['峰值下载', fmtRate(s.peakDown), ''],
      ['峰值上传', fmtRate(s.peakUp), ''],
      ['P95 下载', fmtRate(s.p95Down), ''],
      ['平均下载', fmtRate(s.avgDown), ''],
      ['平均上传', fmtRate(s.avgUp), ''],
      ['空闲时间占比', `${s.idleRatio}%`, ''],
      ['峰值在线终端', `${s.peakClients} 台`, `平均 ${s.avgClients} 台`],
    ];
    $('trafficStats').innerHTML = cells.map(([k, v, note]) => `
      <div class="stat-cell"><span>${esc(k)}</span><b>${esc(v)}</b>${note ? `<em>${esc(note)}</em>` : ''}</div>`).join('');
    $('barChart').innerHTML = barChart(a.minuteBars);
    $('histRow').innerHTML = `
      <div><h4>下载速率分布（采样点数）</h4>${histSvg(a.histogramDown, '#3f7ef2')}</div>
      <div><h4>上传速率分布（采样点数）</h4>${histSvg(a.histogramUp, '#16a8a0')}</div>`;
  }

  const LEVELS = [
    { key: 'cpu', label: 'CPU 占用 (%)', good: 40, bad: 85 },
    { key: 'mem', label: '内存占用 (%)', good: 55, bad: 90 },
    { key: 'temp', label: '设备温度 (°C)', good: 55, bad: 70 },
    { key: 'rsrp', label: 'RSRP (dBm，越大越好)', good: -90, bad: -108 },
    { key: 'sinr', label: 'SINR (dB，越大越好)', good: 15, bad: 3 },
    { key: 'down', label: '下载速率 (bps)', good: null, bad: null },
    { key: 'up', label: '上传速率 (bps)', good: null, bad: null },
    { key: 'clients', label: '在线终端 (台)', good: null, bad: null },
  ];
  function renderStability(a) {
    const st = a.stability;
    const fmtVal = (key, v) => {
      if (key === 'down' || key === 'up') return fmtRate(v);
      if (key === 'rsrp' || key === 'sinr') return num(v).toFixed(0);
      if (key === 'clients') return num(v).toFixed(0);
      return num(v).toFixed(1);
    };
    const rows = LEVELS.filter((l) => st[l.key]).map((l) => {
      const s = st[l.key];
      let lvl = '', cls = '';
      if (l.good !== null) {
        const higherBetter = l.key === 'rsrp' || l.key === 'sinr';
        const bad = higherBetter ? s.avg <= l.bad : s.avg >= l.bad;
        const good = higherBetter ? s.avg >= l.good : s.avg <= l.good;
        lvl = bad ? '偏高/较差' : good ? '良好' : '一般';
        cls = bad ? 'lvl-bad' : good ? 'lvl-good' : 'lvl-mid';
      } else lvl = '—';
      return `<tr>
        <td><b>${esc(l.label)}</b></td>
        <td class="num">${fmtVal(l.key, s.min)}</td>
        <td class="num">${fmtVal(l.key, s.avg)}</td>
        <td class="num">${fmtVal(l.key, s.max)}</td>
        <td class="num">${fmtVal(l.key, s.p95)}</td>
        <td class="num">${num(s.std).toFixed(2)}</td>
        <td class="${cls}">${lvl}</td>
      </tr>`;
    });
    $('stabilityTable').querySelector('tbody').innerHTML = rows.join('') || '<tr><td colspan="7" class="empty">暂无数据</td></tr>';
  }

  function renderProfiles(a) {
    const rows = a.profiles.map((p) => `
      <tr>
        <td><b>${esc(p.name)}</b>${p.online ? ' <span class="lvl-good" style="font-size:10px">在线</span>' : ''}</td>
        <td class="num">${esc(p.ip)}</td>
        <td>${esc(p.type === 'wireless' ? '无线' : p.type)}</td>
        <td class="num">${fmtFull(p.firstSeen)}</td>
        <td class="num">${fmtDuration(p.onlineSec)}</td>
        <td class="num">${p.reconnects}</td>
        <td class="num">${p.rssiMin} ~ ${p.rssiMax} dBm</td>
        <td class="num">${num(p.rateAvg).toFixed(0)} Mbps</td>
      </tr>`).join('');
    $('profileTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="8" class="empty">统计窗口内未发现终端</td></tr>';
  }

  function renderEvents(a) {
    const evs = a.events.slice(0, 40);
    $('eventNote').textContent = `共 ${a.eventCount} 条事件，展示最近 ${evs.length} 条（含终端上下线、阈值告警与系统日志解析）`;
    const tags = { info: '信息', warn: '警告', error: '错误' };
    $('eventList').innerHTML = evs.map((e) => `
      <div class="ev ${esc(e.level)}">
        <span class="ev-time">${fmtFull(e.t)}</span>
        <span class="ev-tag">${tags[e.level] || e.level}</span>
        <span class="ev-body"><b>${esc(e.title)}</b><span>${esc(e.detail)}</span></span>
      </div>`).join('') || '<p class="empty">统计窗口内无事件</p>';
  }

  function renderSimSms(a, sms) {
    const plans = a.extras.simPlans || [];
    $('simRow').innerHTML = plans.length ? plans.map((p) => {
      const pct = p.monthGB > 0 ? Math.min(100, (p.currentGB / p.monthGB) * 100) : 0;
      return `<div class="sim-card">
        <h4>${esc(p.alias)} <span class="${p.enabled ? 'on' : 'off'}">${p.enabled ? '启用' : '未启用'}</span></h4>
        <div class="sim-bar"><i style="width:${pct.toFixed(1)}%;background:${pct >= 90 ? '#ea5b74' : pct >= 70 ? '#e5a13a' : '#3f7ef2'}"></i></div>
        <div class="sim-meta"><span>已用 ${p.currentGB.toFixed(2)} GB</span><span>周期 ${p.monthGB.toFixed(1)} GB · ${pct.toFixed(0)}%</span></div>
        <div class="sim-meta" style="margin-top:4px"><span>月结日 ${esc(p.thresholdDate || '—')}</span><span>限额 ${p.thresholdEnabled ? `${p.thresholdPercent}% 提醒` : '未设置'}</span></div>
      </div>`;
    }).join('') : '<p class="empty">未获取到 SIM 套餐数据</p>';

    const msgs = demoSms((sms.messages || []).slice(0, 10));
    const cap = sms.meta || {};
    $('smsTable').querySelector('tbody').innerHTML = msgs.map((m) => `
      <tr>
        <td class="num">${fmtFull(m.t)}</td>
        <td class="num">${esc(m.contact)}</td>
        <td style="white-space:normal">${esc(m.content.length > 60 ? m.content.slice(0, 60) + '…' : m.content)}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="empty">SIM 卡暂无短信</td></tr>';
    // 表头补充容量说明
    const capNote = `短信容量 ${cap.used ?? '—'}/${cap.total ?? '—'}`;
    const th = $('smsTable').querySelector('thead tr th:nth-child(3)');
    if (th) th.textContent = `内容摘要（${capNote}）`;
  }

  function renderCell(a) {
    const c = a.extras.cellinfo;
    if (!c) { $('cellKv').innerHTML = '<p class="empty">暂未获取到模组详情</p>'; return; }
    const rows = [
      ['链路状态', c.up ? `已连接 · ${fmtDuration(c.uptime)}` : '空闲', c.up ? 'good' : 'warn'],
      ['工作模式 / 频段', `${c.mode} · ${c.band}`],
      ['RSRP / SINR', `${c.rsrp} dBm / ${c.sinr} dB`],
      ['RSRQ / CQI', `${c.rsrq} dB / ${c.cqi}`],
      ['小区 PCI / EARFCN', `${c.pci} / ${c.earfcn}`],
      ['运营商', c.isp],
      ['模组型号 / 温度', `${c.model} · ${c.modelTemp}°C`],
      ['IPv4 / IPv6', `${c.ipv4} / ${c.ipv6 || '无'}`],
      ['DNS', (c.dns || []).join(' / ') || '—'],
      ['SIM 累计流量', fmtBytes(c.simFlow)],
      ['本次下载 / 上传', `${fmtBytes(c.download)} / ${fmtBytes(c.upload)}`],
      ['IMEI / ICCID', `${c.imei} / ${c.iccid}`],
    ];
    $('cellKv').innerHTML = rows.map(([k, v, cls]) => `<div><span>${esc(k)}</span><b class="${cls || ''}">${esc(v)}</b></div>`).join('');
  }

  /* ---------------- 主流程 ---------------- */
  async function load() {
    const [aRes, sRes, mRes, hRes] = await Promise.all([
      fetch(`/api/analysis?window=${windowMin}`).then((r) => r.json()),
      fetch('/api/snapshot').then((r) => r.json()),
      fetch('/api/sms').then((r) => r.json()).catch(() => ({ messages: [], meta: {} })),
      fetch('/api/health').then((r) => r.json()).catch(() => ({})),
    ]);
    if (!aRes.ok || !sRes.ok) { $('docSub').textContent = '数据加载失败，请确认代理服务正在运行'; return; }
    const a = aRes, snap = sRes.snapshot || {};
    demoApply(a, snap);

    const start = a.session ? a.session.startAt : null;
    const winLabel = { 60: '近 1 小时', 360: '近 6 小时', 1440: '近 24 小时', 0: '服务运行以来（全部采样）' }[Number(windowMin)] || '全部';
    const now = new Date();
    $('docSub').textContent =
      `生成时间 ${now.toLocaleString('zh-CN', { hour12: false })} · 统计范围：${winLabel}` +
      (start ? ` · 采样起点 ${fmtFull(start)}` : '') +
      ` · ${a.totalPoints} 个采样点`;
    if (!reportNo) reportNo = `NR-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    $('docNo').textContent = reportNo;

    renderOverview(a, snap);
    renderTraffic(a);
    renderStability(a);
    renderProfiles(a);
    renderEvents(a);
    renderSimSms(a, mRes);
    renderCell(a);

    $('footMeta').textContent =
      `设备 ${snap.device?.model || '—'} · 固件 ${snap.device?.firmware || '—'} · 长期采样 ${num(hRes.longTermPoints, a.totalPoints)} 点（本地持久化 24 小时） · 事件 ${a.eventCount} 条 · 报告基于截至生成时刻的数据快照`;
  }

  /* 交互 */
  $('printBtn').addEventListener('click', () => window.print());
  $('rangeGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-min]');
    if (!btn) return;
    windowMin = btn.dataset.min;
    document.querySelectorAll('#rangeGroup button').forEach((b) => b.classList.toggle('active', b === btn));
    load();
  });

  load();
  setInterval(load, 30000);
})();
