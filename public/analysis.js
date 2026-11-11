/* ============================================================
   深度数据分析页 · 前端
   依赖同源 API：/api/analysis /api/snapshot /api/raw
   ============================================================ */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const hexToRgba = (hex, a) => {
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return h.length === 6 && Number.isFinite(n) ? `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` : `rgba(120,130,150,${a})`;
  };

  /* ---------------- 格式化 ---------------- */
  function fmtRate(bps) {
    let v = Math.max(0, num(bps)), i = 0; const u = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return { val: v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2), unit: u[i] };
  }
  function fmtBytes(b) {
    let v = Math.max(0, num(b)), i = 0; const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return { val: v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2), unit: u[i] };
  }
  const rateStr = (v) => { const r = fmtRate(v); return `${r.val} ${r.unit}`; };
  const byteStr = (v) => { const r = fmtBytes(v); return `${r.val} ${r.unit}`; };
  const pair = (s) => { const p = String(s).split(' '); return { val: p[0], unit: p.slice(1).join(' ') }; };
  function fmtDuration(s) {
    s = Math.max(0, num(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    if (h >= 24) return `${Math.floor(h / 24)}天 ${h % 24}小时`;
    if (h) return `${h}小时 ${m}分`;
    if (m) return `${m}分 ${sec}秒`;
    return `${sec}秒`;
  }
  const fmtDateTime = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtClock = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
  const fmtHM = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const dash = (v) => (v === undefined || v === null || v === '' ? '—' : String(v));

  /* ---------------- 分时柱状图 ---------------- */
  function niceCeil(v) {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v)), base = Math.pow(10, exp), n = v / base;
    return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => n <= s) || 10) * base;
  }
  const minuteCanvas = $('minuteChart');
  let minuteBars = [];
  let hoverBar = -1;

  function drawMinuteBars() {
    const r = minuteCanvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    minuteCanvas.width = Math.round(r.width * dpr); minuteCanvas.height = Math.round(r.height * dpr);
    const ctx = minuteCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const padL = 66, padR = 12, padT = 12, padB = 24;
    const cw = r.width - padL - padR, ch = r.height - padT - padB;
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    if (!minuteBars.length) {
      ctx.fillStyle = cssVar('--text-3'); ctx.textAlign = 'center'; ctx.font = '12px -apple-system, sans-serif';
      ctx.fillText('暂无分时数据 · 服务运行后逐分钟累积', padL + cw / 2, padT + ch / 2);
      return;
    }
    const max = niceCeil(Math.max(...minuteBars.map((b) => Math.max(b.down, b.up))) * 1.15);
    const yOf = (v) => padT + ch - (v / max) * ch;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4, y = yOf(v);
      ctx.strokeStyle = cssVar('--grid'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y + .5); ctx.lineTo(r.width - padR, y + .5); ctx.stroke();
      ctx.fillStyle = cssVar('--text-3'); ctx.fillText(byteStr(v), padL - 8, y);
    }
    const groupW = cw / minuteBars.length;
    const barW = Math.max(1.5, Math.min(13, groupW * .34));
    minuteBars.forEach((b, i) => {
      const cx = padL + groupW * (i + .5);
      const hD = Math.max(0, padT + ch - yOf(b.down)), hU = Math.max(0, padT + ch - yOf(b.up));
      ctx.fillStyle = cssVar('--c-blue');
      ctx.fillRect(cx - barW - 1, padT + ch - hD, barW, hD);
      ctx.fillStyle = cssVar('--c-teal');
      ctx.fillRect(cx + 1, padT + ch - hU, barW, hU);
    });
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = cssVar('--text-3');
    const step = Math.max(1, Math.ceil(minuteBars.length / 6));
    minuteBars.forEach((b, i) => {
      if (i % step === 0 || i === minuteBars.length - 1) ctx.fillText(fmtHM(b.t), padL + groupW * (i + .5), r.height - padB + 6);
    });
    if (hoverBar >= 0 && minuteBars[hoverBar]) {
      const b = minuteBars[hoverBar], cx = padL + groupW * (hoverBar + .5);
      ctx.fillStyle = hexToRgba(cssVar('--c-blue'), .09);
      ctx.fillRect(cx - groupW / 2, padT, groupW, ch);
    }
  }
  minuteCanvas.addEventListener('mousemove', (e) => {
    if (!minuteBars.length) return;
    const r = minuteCanvas.getBoundingClientRect(), padL = 66, padR = 12;
    const cw = r.width - padL - padR, x = e.clientX - r.left - padL;
    hoverBar = clamp(Math.floor((x / cw) * minuteBars.length), 0, minuteBars.length - 1);
    drawMinuteBars();
    const b = minuteBars[hoverBar];
    const tip = $('tooltip');
    tip.innerHTML = `<div class="tt-time">${fmtHM(b.t)} · ${b.samples} 个采样点</div>` +
      `<div class="tt-row"><i style="background:${cssVar('--c-blue')}"></i><span>下载</span><b>${byteStr(b.down)}</b></div>` +
      `<div class="tt-row"><i style="background:${cssVar('--c-teal')}"></i><span>上传</span><b>${byteStr(b.up)}</b></div>` +
      `<div class="tt-row"><i style="background:${cssVar('--c-violet')}"></i><span>分钟峰值</span><b>${rateStr(b.peak)}</b></div>`;
    tip.style.left = e.clientX + 'px'; tip.style.top = (e.clientY - 8) + 'px'; tip.classList.add('show');
  });
  minuteCanvas.addEventListener('mouseleave', () => {
    hoverBar = -1; drawMinuteBars(); $('tooltip').classList.remove('show');
  });

  /* ---------------- 渲染辅助 ---------------- */
  function kv(container, items) {
    container.innerHTML = items.map(([k, v, mono]) =>
      `<div><span>${esc(k)}</span><b class="${mono ? 'mono' : ''}" title="${esc(v)}">${esc(v)}</b></div>`
    ).join('');
  }
  function statCard(label, valueObj, note, tone) {
    return `<div class="stat-item" style="--tone:${cssVar(tone)}">
      <div class="st-label"><i></i>${esc(label)}</div>
      <div class="st-value">${esc(valueObj.val)}<em>${esc(valueObj.unit || '')}</em></div>
      <div class="st-note">${esc(note)}</div></div>`;
  }

  /* ---------------- 各区块渲染 ---------------- */
  let windowMin = 0;
  let activeFilter = 'all';
  let analysisData = null;
  let snapshotData = null;

  function renderTop(s, a) {
    $('topModel').textContent = s ? s.device.model : '—';
    $('topFirmware').textContent = s ? s.device.firmware : '—';
    $('heroTitle').textContent = a.session
      ? `已累计 ${a.totalPoints.toLocaleString()} 个采样点 · ${fmtDuration(a.session.durationSec)}`
      : '正在汇总采样数据…';
    $('heroSub').textContent = `数据每 2 秒采集并落盘 · 当前窗口 ${windowMin ? windowMin + ' 分钟' : '全部历史'} · 生成于 ${fmtClock(a.generatedAt)}`;
    $('sumPoints').textContent = a.totalPoints.toLocaleString();
    $('sumDuration').textContent = a.session ? fmtDuration(a.session.durationSec) : '—';
    $('sumEvents').textContent = a.eventCount;
    $('sumStart').textContent = new Date(a.startedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    $('windowTag').textContent = windowMin ? `最近 ${fmtDuration(windowMin * 60)}` : '全部数据';
    $('statsSubtitle').textContent = `基于${windowMin ? '最近 ' + fmtDuration(windowMin * 60) : '全部'} ${a.session ? a.session.samples.toLocaleString() : 0} 个采样点计算`;
    $('persistState').textContent = a.persisted ? `${a.totalPoints.toLocaleString()} 点` : '未启用';
    $('footStatus').textContent = s ? `正常 · 上游 ${s.meta.host} · 长历史 ${a.totalPoints} 点` : '等待数据…';
    $('footHost').textContent = s ? `运行时接口 ${s.meta.runtimePath.split('/').pop()}` : '上游路由器';
    const pill = $('livePill');
    pill.dataset.state = s ? 'online' : 'offline';
    $('liveText').textContent = s ? '数据正常' : '连接异常';
  }

  function renderStats(a) {
    const q = a.session;
    if (!q) { $('statGrid').innerHTML = '<p class="empty">等待采样数据…</p>'; return; }
    const items = [
      ['采样点数', { val: q.samples.toLocaleString(), unit: '个' }, '每 2 秒一个点', '--c-blue'],
      ['统计时长', { val: fmtDuration(q.durationSec), unit: '' }, '首末采样点间隔', '--c-violet'],
      ['累计下载', pair(byteStr(q.transferredDown)), '窗口内计数器增量', '--c-blue'],
      ['累计上传', pair(byteStr(q.transferredUp)), '窗口内计数器增量', '--c-teal'],
      ['总传输量', pair(byteStr(q.transferredTotal)), '下载 + 上传合计', '--c-green'],
      ['峰值下载', pair(rateStr(q.peakDown)), '窗口内最高瞬时速率', '--c-blue'],
      ['峰值上传', pair(rateStr(q.peakUp)), '窗口内最高瞬时速率', '--c-teal'],
      ['平均下载', pair(rateStr(q.avgDown)), '算术平均', '--c-blue'],
      ['平均上传', pair(rateStr(q.avgUp)), '算术平均', '--c-teal'],
      ['P95 下载', pair(rateStr(q.p95Down)), '95% 时间不超过此值', '--c-violet'],
      ['空闲占比', { val: q.idleRatio, unit: '%' }, '速率 < 1Kbps 的采样比例', '--c-amber'],
      ['峰值在线', { val: q.peakClients, unit: '台' }, `平均 ${q.avgClients} 台`, '--c-green'],
    ];
    $('statGrid').innerHTML = items.map(([l, v, n, t]) => statCard(l, v, n, t)).join('');
  }

  function renderHealth(a) {
    const h = a.health;
    if (!h) return;
    const color = h.total >= 80 ? '--c-green' : h.total >= 65 ? '--c-blue' : h.total >= 45 ? '--c-amber' : '--c-red';
    const C = 515.2, arc = $('healthArc');
    arc.style.strokeDasharray = C; arc.style.strokeDashoffset = C * (1 - h.total / 100);
    arc.style.stroke = cssVar(color);
    $('healthScore').textContent = h.total;
    $('healthLevel').textContent = h.level;
    $('healthLevel').style.background = `color-mix(in srgb, ${cssVar(color)} 12%, transparent)`;
    $('healthLevel').style.color = cssVar(color);
    $('healthTag').textContent = `${h.level} · ${h.total} 分`;
    $('healthItems').innerHTML = h.items.map((x) => {
      const c = x.score >= 75 ? '--c-green' : x.score >= 50 ? '--c-blue' : x.score >= 35 ? '--c-amber' : '--c-red';
      return `<div class="health-item"><div class="hi-top"><span>${esc(x.label)}</span><em>权重 ${x.weight}%</em><b>${x.score}</b></div>
        <div class="bar"><i style="width:${x.score}%;background:${cssVar(c)}"></i></div>
        <div class="hi-top"><em>${esc(x.value)}</em></div></div>`;
    }).join('');
  }

  function renderStability(a) {
    const defs = [
      ['CPU 负载', 'cpu', '%'], ['内存占用', 'mem', '%'], ['设备温度', 'temp', '°C'],
      ['WiFi 芯片温度', 'wifiTemp', '°C'], ['RSRP', 'rsrp', 'dBm'], ['SINR', 'sinr', 'dB'],
      ['下载速率', 'down', ''], ['上传速率', 'up', ''], ['在线终端', 'clients', '台'],
    ];
    const fmt = (v, k, unit) => (k === 'down' || k === 'up') ? rateStr(v) : `${v}${unit}`;
    $('stabilityRows').innerHTML = defs.map(([label, key, unit]) => {
      const s = a.stability[key] || {};
      return `<tr><td><span class="ind-name">${esc(label)}</span> <span class="ind-unit">${esc(unit || 'bps')}</span></td>
        <td>${fmt(s.min ?? 0, key, unit)}</td><td><b>${fmt(s.avg ?? 0, key, unit)}</b></td>
        <td>${fmt(s.max ?? 0, key, unit)}</td><td>${fmt(s.p95 ?? 0, key, unit)}</td>
        <td>${(key === 'down' || key === 'up') ? rateStr(s.std ?? 0) : esc(s.std ?? 0)}</td></tr>`;
    }).join('');
  }

  function renderMinute(a) {
    minuteBars = a.minuteBars || [];
    drawMinuteBars();
    const total = minuteBars.reduce((x, b) => x + b.down + b.up, 0);
    const peak = minuteBars.reduce((x, b) => Math.max(x, b.down, b.up), 0);
    $('minutePeak').textContent = byteStr(peak);
    $('minuteTotal').textContent = byteStr(total);
    $('minuteCount').textContent = `${minuteBars.length} 分钟`;
  }

  function renderHist(elId, hist, tone, tagId) {
    const max = Math.max(1, ...hist.bins);
    const color = cssVar(tone);
    $(elId).innerHTML = hist.labels.map((l, i) => `
      <div class="hist-row"><div class="hist-label">${esc(l)}</div>
        <div class="hist-track"><i style="width:${(hist.bins[i] / max) * 100}%;background:${color};opacity:${.55 + .45 * (hist.bins[i] / max)}"></i></div>
        <div class="hist-count">${hist.bins[i]}</div></div>`).join('');
    $(tagId).textContent = `${hist.bins.reduce((a, b) => a + b, 0)} 个采样点`;
  }

  function renderProfiles(a) {
    const list = a.profiles || [];
    $('profileCount').textContent = `${list.length} 台设备`;
    $('profileRows').innerHTML = list.length ? list.map((p) => `
      <tr>
        <td><div class="dev-cell"><div class="dev-icon">${p.type === 'wireless'
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/></svg>'}</div>
          <div><div class="dev-name">${esc(p.name)}</div><div class="dev-sub">${esc(p.ip)} · ${esc(p.mac)}</div></div></div></td>
        <td>${new Date(p.firstSeen).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${fmtDuration(p.onlineSec)}</td>
        <td>${p.samples}</td>
        <td>${p.reconnects}</td>
        <td class="mono-cell">${p.rssiMin} ~ ${p.rssiMax}</td>
        <td>${p.rssiAvg} dBm</td>
        <td>${p.rateAvg} Mbps</td>
        <td><span class="pill-ok ${p.online ? '' : 'pill-off'}">${p.online ? '在线' : '离线'}</span></td>
      </tr>`).join('') : '<tr><td colspan="9" class="empty">暂无终端画像</td></tr>';
  }

  const TYPE_META = {
    device: ['设备', '--c-blue'], alert: ['告警', '--c-red'], wifi: ['WiFi', '--c-violet'],
    dhcp: ['DHCP', '--c-teal'], link: ['链路', '--c-amber'], cellular: ['蜂窝', '--c-green'],
    traffic: ['流量', '--c-blue'], signal: ['信号', '--c-violet'],
  };
  const FILTERS = [['all', '全部'], ['device', '设备'], ['alert', '告警'], ['wifi', 'WiFi'], ['dhcp', 'DHCP'], ['link', '链路'], ['cellular', '蜂窝'], ['traffic', '流量'], ['signal', '信号']];

  function renderEvents(a) {
    $('eventFilter').innerHTML = FILTERS.map(([k, l]) => `<button data-type="${k}" class="${k === activeFilter ? 'active' : ''}">${l}</button>`).join('');
    const all = a.events || [];
    const list = activeFilter === 'all' ? all : all.filter((e) => e.type === activeFilter);
    $('eventList').innerHTML = list.length ? list.map((e) => {
      const [label, tone] = TYPE_META[e.type] || [e.type, '--c-blue'];
      const c = cssVar(e.level === 'warn' ? '--c-amber' : tone);
      return `<div class="event-item" style="--ev-color:${c}">
        <div class="ev-dot"></div>
        <div class="ev-body"><div class="ev-top"><span class="ev-title">${esc(e.title)}</span>
          <span class="ev-type">${esc(label)}${e.level === 'warn' ? ' · 注意' : ''}</span>
          <span class="ev-time">${fmtDateTime(e.t)}</span></div>
          <div class="ev-detail">${esc(e.detail || '—')}</div></div></div>`;
    }).join('') : '<p class="empty">该分类暂无事件</p>';

    const counts = {};
    for (const e of all) counts[e.type] = (counts[e.type] || 0) + 1;
    $('eventStats').innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
      const [label, tone] = TYPE_META[k] || [k, '--c-blue'];
      return `<div class="side-row"><i style="background:${cssVar(tone)}"></i><span>${esc(label)}</span><b>${v}</b></div>`;
    }).join('') || '<div class="side-note">暂无事件</div>';
    const warns = all.filter((e) => e.level === 'warn').length;
    $('logSummary').innerHTML = `<div class="side-row"><span>累计事件</span><b>${a.eventCount}</b></div>
      <div class="side-row"><span>需注意事件</span><b>${warns}</b></div>
      <div class="side-row"><span>系统日志分类数</span><b>${Object.keys(a.logCounts || {}).length}</b></div>
      <div class="side-note">系统日志每 60 秒增量解析一次，仅提取结构化事件并脱敏，不展示原始内容。</div>`;
  }

  function renderExtras(a, s) {
    const c = a.extras.cellinfo;
    const linkOk = !!(c && c.ipv4 && c.ipv4 !== '-');
    if (c) {
      $('cellModeTag').textContent = `${c.mode} · ${c.band}`;
      kv($('cellKv'), [
        ['链路状态', linkOk ? '已连接（已获取 IP）' : '未连接'], ['链路时长', fmtDuration(c.uptime)],
        ['模组型号', c.model, true], ['运营商', c.isp],
        ['RSRP', `${c.rsrp} dBm`], ['RSRQ', `${c.rsrq} dB`],
        ['SINR', `${c.sinr} dB`], ['RSSI / CQI', `${c.rssi} dBm / ${c.cqi}`],
        ['频段 / PCI', `${c.band} / ${c.pci}`], ['EARFCN', c.earfcn, true],
        ['IPv4', c.ipv4, true], ['IPv6', c.ipv6, true],
        ['DNS', (c.dns || []).join(' / ') || '—', true], ['模组温度', `${c.modelTemp} °C`],
        ['SIM 累计流量', byteStr(c.simFlow)], ['模组统计流量', byteStr(c.traffic)],
        ['IMEI', c.imei, true], ['ICCID', c.iccid, true],
        ['模组标志 up', String(c.up)], ['状态字 status', String(c.status)],
      ]);
    } else {
      $('cellKv').innerHTML = '<div><span>模组详情</span><b>等待 30 秒周期刷新…</b></div>';
    }

    const plans = a.extras.simPlans || [];
    $('simCountTag').textContent = `${plans.length} 张卡`;
    const maxGB = Math.max(1, ...plans.map((p) => p.currentGB));
    $('simCards').innerHTML = plans.length ? plans.map((p, i) => `
      <div class="sim-card">
        <div class="sim-top"><strong>${esc(p.alias)}</strong><span>SIM ${p.index}</span><b>${p.currentGB.toFixed(2)} GB</b></div>
        <div class="bar"><i style="width:${clamp((p.currentGB / maxGB) * 100, 2, 100)}%;background:${cssVar(i % 2 ? '--c-teal' : '--c-blue')}"></i></div>
        <div class="sim-meta"><span>本月 ${p.monthGB.toFixed(2)} GB</span>
          <span>${p.thresholdGB ? '额度 ' + p.thresholdGB.toFixed(1) + ' GB' : '未设额度'}</span>
          <span>月结日 ${esc(p.thresholdDate || '—')}</span>
          <span>${p.thresholdEnabled ? '限额已启用' : '限额未启用'}</span></div>
      </div>`).join('') : '<p class="empty">等待 SIM 数据…</p>';

    const sms = a.extras.sms;
    kv($('smsKv'), [
      ['短信容量', sms ? `${sms.max} 条` : '—'],
      ['已存储', sms ? `${sms.used} 条` : '—'],
      ['未读短信', sms ? `${sms.unread} 条` : '—'],
      ['归属接口', sms ? sms.iface : '—'],
      ['蜂窝链路', c ? (linkOk ? '已连接' : '未连接') : '—'],
      ['链路时长', c ? fmtDuration(c.uptime) : '—'],
      ['长历史采样', `${a.totalPoints.toLocaleString()} 点`],
      ['结构化事件', `${a.eventCount} 条`],
    ]);
    if (sms) {
      $('smsCapText').textContent = `${sms.used} / ${sms.max} 条`;
      $('smsCapBar').style.width = clamp((sms.used / Math.max(1, sms.max)) * 100, 0, 100) + '%';
    }
  }

  function renderApiList(s) {
    const rp = s ? s.meta.runtimePath : '/cgi-bin/luci/nradio/status/runtime/wan,cpe_4';
    const wn = s ? s.meta.wanNames : 'cpe';
    const items = [
      ['登录鉴权', 'POST /cgi-bin/luci', '表单 luci_username / luci_password → sysauth Cookie'],
      ['运行时状态', `POST ${rp}`, '2 秒 · 完整状态 JSON（主数据源）'],
      ['累计流量计数', `GET /cgi-bin/luci/nradio/status/speed/${wn}`, '2 秒 · 差分计算实时速率'],
      ['状态页解析', 'GET /cgi-bin/luci/nradio/system/overview', '启动时 · 型号/固件/WAN 参数'],
      ['5G 模组详情', 'GET /cgi-bin/luci/nradio/cellular/cpestatus/cellinfo', '30 秒 · 模组信号与地址'],
      ['SIM 套餐用量', 'POST /cgi-bin/luci/nradio/cellular/cpedata/refresh', '30 秒 · 双卡流量统计'],
      ['短信容量', 'GET /cgi-bin/luci/nradio/cellular/sms/unread', '30 秒 · 短信与未读数'],
      ['系统日志', 'GET /cgi-bin/luci/nradioadv/system/logread', '60 秒 · 结构化事件解析'],
      ['本地分析 API', 'GET /api/analysis?window=<分钟>', '衍生指标 / 长历史 / 事件'],
      ['CSV 导出', 'GET /api/export.csv?window=<分钟>', '全部采样点，可导入 Excel'],
    ];
    $('apiList').innerHTML = items.map(([n, p, note]) =>
      `<div class="api-item"><div class="api-name">${esc(n)}</div><code>${esc(p)}</code><div class="api-note">${esc(note)}</div></div>`
    ).join('');
  }

  /* ---------------- 原始数据 ---------------- */
  let rawText = '';
  function renderRaw() {
    const q = $('rawSearch').value.trim().toLowerCase();
    if (!q) { $('rawJson').textContent = rawText; return; }
    const lines = rawText.split('\n');
    const hit = lines.map((l, i) => l.toLowerCase().includes(q) ? i : -1).filter((i) => i >= 0);
    if (!hit.length) { $('rawJson').textContent = `没有匹配「${q}」的字段`; return; }
    const keep = new Set();
    for (const i of hit) { keep.add(i); if (i > 0) keep.add(i - 1); }
    $('rawJson').textContent = [...keep].sort((a, b) => a - b).map((i) => lines[i]).join('\n') + `\n\n… 共 ${hit.length} 处匹配`;
  }
  async function loadRaw() {
    try {
      const r = await fetch('/api/raw', { cache: 'no-store' });
      const d = await r.json();
      rawText = JSON.stringify(d.raw || {}, null, 2);
      renderRaw();
    } catch (e) { $('rawJson').textContent = '原始数据载入失败：' + e.message; }
  }

  /* ---------------- 数据拉取 ---------------- */
  async function refresh() {
    try {
      const [ar, sr] = await Promise.all([
        fetch(`/api/analysis?window=${windowMin}`, { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/snapshot', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      analysisData = ar; snapshotData = sr.snapshot;
      renderTop(snapshotData, ar);
      renderStats(ar); renderHealth(ar); renderStability(ar);
      renderMinute(ar);
      renderHist('histDown', ar.histogramDown, '--c-blue', 'histDownTotal');
      renderHist('histUp', ar.histogramUp, '--c-teal', 'histUpTotal');
      renderProfiles(ar); renderEvents(ar);
      renderExtras(ar, snapshotData);
      renderApiList(snapshotData);
    } catch (err) {
      const pill = $('livePill');
      pill.dataset.state = 'offline'; $('liveText').textContent = '服务未响应';
      $('footStatus').textContent = '无法连接本地代理服务：' + err.message;
    }
  }

  /* ---------------- 交互 ---------------- */
  $('windowGroup').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-win]');
    if (!b) return;
    windowMin = Number(b.dataset.win);
    [...$('windowGroup').children].forEach((x) => x.classList.toggle('active', x === b));
    refresh();
  });
  $('eventFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b || !analysisData) return;
    activeFilter = b.dataset.type;
    [...$('eventFilter').children].forEach((x) => x.classList.toggle('active', x === b));
    renderEvents(analysisData);
  });
  $('exportBtn').addEventListener('click', () => { window.location.href = `/api/export.csv?window=${windowMin}`; });
  $('refreshLogsBtn').addEventListener('click', async (e) => {
    e.target.textContent = '刷新中…'; e.target.disabled = true;
    try { await fetch('/api/refresh-logs', { method: 'POST' }); await refresh(); } catch (_) {}
    e.target.textContent = '刷新日志'; e.target.disabled = false;
  });
  $('rawReloadBtn').addEventListener('click', loadRaw);
  $('rawSearch').addEventListener('input', renderRaw);

  const savedTheme = new URLSearchParams(location.search).get('theme') || localStorage.getItem('nros-theme');
  if (savedTheme === 'dark') document.documentElement.dataset.theme = 'dark';
  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('nros-theme', next);
    if (analysisData) { renderHealth(analysisData); renderMinute(analysisData); renderEvents(analysisData); }
  });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawMinuteBars, 120); });

  refresh();
  loadRaw();
  setInterval(refresh, 10000);
})();
