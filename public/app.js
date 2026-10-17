/*
 * Wave Journal（Cloudflare 版）の画面。
 * 旧版 wave-journal.html（React + Babel を CDN から読む単一HTML）と同じ見た目・同じ言葉・同じ操作を、
 * ライブラリ無しの素の JS で作り直したもの。スタイルの値は旧版のインラインスタイルをそのまま写している。
 * 記録は localStorage ではなくサーバー（D1）に置く。
 */
(() => {
  'use strict';

  const STATE_OPTIONS = [
    { value: -3, label: '理性の極', sub: '計画ばかり、手が動かない', color: '#3B82F6' },
    { value: -2, label: '理性寄り', sub: 'やや構造化モード', color: '#60A5FA' },
    { value: -1, label: '理性よりの核', sub: '核にいる、少し構造的', color: '#A5B4FC' },
    { value: 1, label: '感性よりの核', sub: '核にいる、少し自由', color: '#E879F9' },
    { value: 2, label: '感性寄り', sub: 'やや自由モード', color: '#F9A8D4' },
    { value: 3, label: '感性の極', sub: '些事に夢中、目的からそれる', color: '#FB7185' },
  ];

  const RANGE_OPTIONS = [
    { key: 'week', label: '一週間', days: 7 },
    { key: 'month', label: '一か月', days: 30 },
    { key: '3month', label: '3か月', days: 90 },
    { key: '6month', label: '半年', days: 180 },
    { key: 'all', label: '全期間', days: null },
  ];

  const POINT_SPACING = 44;

  // ------------------------------------------------------------------ 小道具

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  /** 端末の日付で「今日」（旧版は UTC だったので、日本の朝9時前は前日扱いになっていた） */
  const todayStr = () => ymd(new Date());

  function getStateOption(value) {
    return STATE_OPTIONS.find((o) => o.value === Number(value)) || STATE_OPTIONS[2];
  }
  function formatDate(dateStr) {
    const [, m, d] = String(dateStr).split('-').map(Number);
    return `${m}/${d}`;
  }

  class AuthError extends Error {}

  async function api(path, opts = {}) {
    const init = { ...opts, headers: { ...(opts.headers || {}) } };
    if (init.body !== undefined && typeof init.body !== 'string') {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const res = await fetch(path, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* JSON でない */ }
    if (res.status === 401 && data && data.code === 'auth') { showGate(); throw new AuthError('合言葉を入れてください'); }
    if (!res.ok) throw new Error((data && data.error) || `通信に失敗しました（${res.status}）`);
    return data;
  }

  // ------------------------------------------------------------------ 状態

  const S = {
    mode: 'loading',       // loading | gate | app
    gateMsg: '',
    gateNoKey: false,
    entries: [],           // 生きている記録（日付順）
    view: 'input',
    logRange: 'week',
    targetDate: todayStr(),
    selected: null,
    note: '',
    saved: false,
    saving: false,
    saveError: '',
    importMessage: '',
    trash: [],
    trashOpen: false,
  };

  const targetEntry = () => S.entries.find((e) => e.date === S.targetDate);

  /** 記録する日を変えたとき・記録を読み直したときに、選択とメモをその日の記録に合わせる（旧版の useEffect と同じ） */
  function syncFromTarget() {
    const t = targetEntry();
    S.selected = t ? Number(t.value) : null;
    S.note = t ? t.note || '' : '';
  }

  // ------------------------------------------------------------------ スタイル（旧版の値そのまま）

  const ST = {
    outer: "min-height:100vh;background:linear-gradient(160deg, #0F0F1A 0%, #1A1025 50%, #0F1A1A 100%);color:#E2E8F0;font-family:'Inter', sans-serif;padding:0;",
    inner: 'max-width:480px;margin:0 auto;padding:32px 20px 80px;',
    label: (mb) => `font-size:11px;color:#6B7280;letter-spacing:0.1em;margin-bottom:${mb}px;`,
    field: 'width:100%;background:#1A1A2E;border:1.5px solid #2D2D44;border-radius:10px;padding:12px 14px;color:#E2E8F0;font-size:14px;outline:none;box-sizing:border-box;font-family:inherit;',
    tab: (on) => `flex:1;padding:8px 0;border-radius:7px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:all 0.2s;background:${on ? '#2D2D44' : 'transparent'};color:${on ? '#E2E8F0' : '#6B7280'};`,
    stateBtn: (opt, on) => `display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;border:none;cursor:pointer;background:${on ? opt.color + '18' : '#1A1A2E'};outline:${on ? `1.5px solid ${opt.color}60` : '1.5px solid transparent'};transition:all 0.15s;text-align:left;`,
    stateDot: (opt, on) => `width:10px;height:10px;border-radius:50%;background:${on ? opt.color : '#374151'};box-shadow:${on ? `0 0 8px ${opt.color}80` : 'none'};transition:all 0.15s;flex-shrink:0;`,
    stateLabel: (opt, on) => `font-size:14px;font-weight:500;color:${on ? opt.color : '#9CA3AF'};`,
    saveBtn: (sel) => {
      const c = sel !== null ? getStateOption(sel).color : null;
      return 'width:100%;padding:14px;border-radius:12px;border:none;'
        + `cursor:${sel === null ? 'not-allowed' : 'pointer'};font-size:14px;font-weight:600;letter-spacing:0.05em;`
        + `background:${c ? `linear-gradient(135deg, ${c}CC, ${c}88)` : '#1E1E2E'};`
        + `color:${c ? '#0F0F1A' : '#4B5563'};transition:all 0.2s;`
        + `box-shadow:${c ? `0 4px 20px ${c}40` : 'none'};`;
    },
    rangeBtn: (on) => `padding:6px 14px;border-radius:8px;border:none;cursor:pointer;font-size:12px;font-weight:500;background:${on ? '#2D2D44' : '#1A1A2E'};color:${on ? '#E2E8F0' : '#6B7280'};`,
    backupBtn: (disabled) => `flex:1;padding:10px;border-radius:10px;border:1.5px solid #2D2D44;cursor:${disabled ? 'not-allowed' : 'pointer'};background:#1A1A2E;color:${disabled ? '#4B5563' : '#9CA3AF'};font-size:12px;font-weight:500;`,
    // 旧版に無かった小さな操作（消す・ゴミ箱・戻す）。目立たないよう文字だけのボタンにする
    quietBtn: 'background:none;border:none;padding:6px 0;margin:0;cursor:pointer;font-size:11px;color:#6B7280;text-decoration:underline;text-underline-offset:3px;',
  };

  // ------------------------------------------------------------------ 波のグラフ（旧版 WaveGraph と同じ）

  function waveGraph(entries, scrollable) {
    if (entries.length === 0) return '';
    const height = 120;
    const padding = { left: 32, right: 32, top: 20, bottom: 20 };
    const innerH = height - padding.top - padding.bottom;
    const width = scrollable
      ? Math.max(600, padding.left + padding.right + (entries.length - 1) * POINT_SPACING)
      : 600;
    const innerW = width - padding.left - padding.right;
    const valueToIndex = { '-3': 0, '-2': 1, '-1': 2, '1': 3, '2': 4, '3': 5 };

    const points = entries.map((e, i) => {
      const x = scrollable
        ? padding.left + i * POINT_SPACING
        : padding.left + (entries.length === 1 ? innerW / 2 : (i / (entries.length - 1)) * innerW);
      const idx = valueToIndex[String(e.value)] ?? 2;
      const y = padding.top + (idx / 5) * innerH;
      return { x, y, entry: e };
    });

    const pathD = points.length === 1
      ? `M ${points[0].x} ${points[0].y}`
      : points.reduce((acc, p, i) => {
        if (i === 0) return `M ${p.x} ${p.y}`;
        const prev = points[i - 1];
        const cx = (prev.x + p.x) / 2;
        return acc + ` C ${cx} ${prev.y}, ${cx} ${p.y}, ${p.x} ${p.y}`;
      }, '');

    const centerY = padding.top + (2.5 / 5) * innerH;
    const svgStyle = scrollable
      ? `width:${width}px;height:${height}px;display:block;flex-shrink:0;`
      : 'width:100%;height:120px;display:block;';

    const svg = `<svg viewBox="0 0 ${width} ${height}"${scrollable ? '' : ' preserveAspectRatio="none"'} style="${svgStyle}">`
      + `<line x1="${padding.left}" y1="${centerY}" x2="${width - padding.right}" y2="${centerY}" stroke="#4B5563" stroke-width="1" stroke-dasharray="4 4"></line>`
      + `<text x="8" y="${padding.top + 6}" fill="#60A5FA" font-size="9" opacity="0.6">理性</text>`
      + `<text x="8" y="${height - padding.bottom + 2}" fill="#FB7185" font-size="9" opacity="0.6">感性</text>`
      + `<path d="${pathD}" fill="none" stroke="url(#waveGrad)" stroke-width="2" stroke-linecap="round"></path>`
      + '<defs><linearGradient id="waveGrad" x1="0" y1="0" x2="1" y2="0">'
      + '<stop offset="0%" stop-color="#60A5FA"></stop><stop offset="50%" stop-color="#A78BFA"></stop><stop offset="100%" stop-color="#FB7185"></stop>'
      + '</linearGradient></defs>'
      + points.map((p) => `<g><circle cx="${p.x}" cy="${p.y}" r="4" fill="${getStateOption(p.entry.value).color}" opacity="0.9"></circle>`
        + `<text x="${p.x}" y="${height - 4}" fill="#6B7280" font-size="8" text-anchor="middle">${formatDate(p.entry.date)}</text></g>`).join('')
      + '</svg>';

    if (!scrollable) return svg;
    return `<div class="wave-scroll" style="overflow-x:auto;-webkit-overflow-scrolling:touch;">${svg}</div>`;
  }

  // ------------------------------------------------------------------ 描画

  function headerHtml() {
    return `<div style="margin-bottom:40px;">
      <div style="font-size:11px;letter-spacing:0.15em;color:#6B7280;margin-bottom:6px;">WAVE JOURNAL</div>
      <div style="font-size:26px;font-weight:300;letter-spacing:-0.02em;color:#F1F5F9;">今日の波はどこにいる？</div>
    </div>`;
  }

  function gateHtml() {
    return `<form id="loginForm" autocomplete="on">
      ${S.gateNoKey ? '' : `<div style="margin-bottom:24px;">
        <div style="${ST.label(10)}">合言葉</div>
        <input id="keyInput" name="password" type="password" autocomplete="current-password" required
          style="${ST.field}font-size:16px;color-scheme:dark;">
      </div>
      <button type="submit" style="width:100%;padding:14px;border-radius:12px;border:none;cursor:pointer;font-size:14px;font-weight:600;letter-spacing:0.05em;background:linear-gradient(135deg, #A78BFACC, #A78BFA88);color:#0F0F1A;box-shadow:0 4px 20px #A78BFA40;">開く</button>`}
      ${S.gateMsg ? `<div style="margin-top:14px;font-size:12px;color:${S.gateNoKey ? '#9CA3AF' : '#FB7185'};line-height:1.6;">${esc(S.gateMsg)}</div>` : ''}
    </form>`;
  }

  function inputViewHtml() {
    const today = todayStr();
    const t = targetEntry();
    const notice = t && !S.saved
      ? `<div style="background:#1E1E2E;border-radius:12px;padding:12px 16px;margin-bottom:24px;font-size:12px;color:#9CA3AF;border-left:3px solid ${getStateOption(t.value).color};">
          ${S.targetDate === today ? '今日' : formatDate(S.targetDate)}はもう記録済み（${esc(getStateOption(t.value).label)}）。上書きできる。
          <div><button type="button" data-act="delete-day" style="${ST.quietBtn}">この日の記録を消す</button></div>
        </div>`
      : '';
    const states = STATE_OPTIONS.map((opt) => {
      const on = S.selected === opt.value;
      return `<button type="button" data-act="pick" data-v="${opt.value}" style="${ST.stateBtn(opt, on)}">
          <div data-part="dot" style="${ST.stateDot(opt, on)}"></div>
          <div>
            <div data-part="label" style="${ST.stateLabel(opt, on)}">${esc(opt.label)}</div>
            <div style="font-size:11px;color:#4B5563;margin-top:2px;">${esc(opt.sub)}</div>
          </div>
        </button>`;
    }).join('');

    return `<div>
      <div style="margin-bottom:24px;">
        <div style="${ST.label(10)}">記録する日</div>
        <input id="dateInput" type="date" value="${esc(S.targetDate)}" max="${today}" style="${ST.field}color-scheme:dark;">
      </div>
      ${notice}
      <div style="margin-bottom:28px;">
        <div style="${ST.label(14)}">今日の状態</div>
        <div style="display:flex;flex-direction:column;gap:8px;">${states}</div>
      </div>
      <div style="margin-bottom:28px;">
        <div style="${ST.label(10)}">根拠となる事実（一行）</div>
        <textarea id="noteInput" rows="2" placeholder="今日一番時間を使った活動は？" maxlength="1000"
          style="${ST.field}resize:none;line-height:1.6;transition:border-color 0.15s;">${esc(S.note)}</textarea>
      </div>
      <button type="button" id="saveBtn" data-act="save" ${S.selected === null ? 'disabled' : ''} style="${ST.saveBtn(S.selected)}">${S.saved ? '✓ 記録した' : '記録する'}</button>
      ${S.saveError ? `<div style="margin-top:10px;font-size:12px;color:#FB7185;">${esc(S.saveError)}</div>` : ''}
    </div>`;
  }

  function visibleEntries() {
    const today = todayStr();
    const r = RANGE_OPTIONS.find((x) => x.key === S.logRange);
    if (!r || r.days == null) return S.entries;
    const start = new Date();
    start.setDate(start.getDate() - (r.days - 1));
    const startStr = ymd(start);
    return S.entries.filter((e) => e.date >= startStr && e.date <= today);
  }

  function logViewHtml() {
    const vis = visibleEntries();
    const activeRange = RANGE_OPTIONS.find((r) => r.key === S.logRange);
    const ranges = RANGE_OPTIONS.map(({ key, label }) =>
      `<button type="button" data-act="range" data-k="${key}" style="${ST.rangeBtn(S.logRange === key)}">${label}</button>`).join('');

    const body = vis.length > 0
      ? `<div style="background:#1A1A2E;border-radius:14px;padding:20px 16px 12px;margin-bottom:24px;overflow:hidden;">
          <div style="font-size:11px;color:#6B7280;margin-bottom:12px;letter-spacing:0.1em;">波の軌跡</div>
          ${waveGraph(vis, S.logRange === 'all')}
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${[...vis].reverse().map((e) => {
            const opt = getStateOption(e.value);
            return `<div style="background:#1A1A2E;border-radius:10px;padding:12px 16px;border-left:3px solid ${opt.color};display:flex;gap:14px;align-items:flex-start;">
              <div style="font-size:11px;color:#6B7280;min-width:32px;padding-top:2px;">${formatDate(e.date)}</div>
              <div>
                <div style="font-size:13px;color:${opt.color};font-weight:500;margin-bottom:3px;">${esc(opt.label)}</div>
                <div style="font-size:12px;color:#6B7280;line-height:1.5;">${esc(e.note || '—')}</div>
              </div>
            </div>`;
          }).join('')}
        </div>`
      : `<div style="text-align:center;padding:60px 20px;color:#4B5563;font-size:13px;">
          ${S.entries.length === 0 ? 'まだ記録がない。<br>「記録する」タブから始めよう。' : `この${activeRange ? activeRange.label : '期間'}の記録はまだない。`}
        </div>`;

    const none = S.entries.length === 0;
    const trash = S.trash.length > 0 || S.trashOpen
      ? `<div style="margin-top:14px;">
          <button type="button" data-act="toggle-trash" style="${ST.quietBtn}">${S.trashOpen ? 'ゴミ箱を閉じる' : `ゴミ箱（${S.trash.length}件）`}</button>
          ${S.trashOpen ? `<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
            ${S.trash.length === 0 ? '<div style="font-size:12px;color:#4B5563;">ゴミ箱は空。</div>' : S.trash.map((e) => {
              const opt = getStateOption(e.value);
              return `<div style="background:#1A1A2E;border-radius:10px;padding:12px 16px;border-left:3px solid ${opt.color}66;display:flex;gap:14px;align-items:flex-start;opacity:0.85;">
                <div style="font-size:11px;color:#6B7280;min-width:32px;padding-top:2px;">${formatDate(e.date)}</div>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:13px;color:${opt.color};font-weight:500;margin-bottom:3px;">${esc(opt.label)}</div>
                  <div style="font-size:12px;color:#6B7280;line-height:1.5;overflow-wrap:anywhere;">${esc(e.note || '—')}</div>
                </div>
                <button type="button" data-act="restore" data-id="${esc(e.id)}" style="${ST.backupBtn(false)}flex:none;padding:6px 12px;">戻す</button>
              </div>`;
            }).join('')}
          </div>` : ''}
        </div>`
      : '';

    return `<div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;row-gap:8px;margin-bottom:20px;">${ranges}</div>
      ${body}
      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #2D2D44;">
        <div style="${ST.label(10)}">データのバックアップ（全${S.entries.length}件）</div>
        <div style="display:flex;gap:8px;">
          <button type="button" data-act="export" ${none ? 'disabled' : ''} style="${ST.backupBtn(none)}">書き出す</button>
          <button type="button" data-act="import" style="${ST.backupBtn(false)}">読み込む</button>
          <input id="importFile" type="file" accept="application/json,.json" style="display:none;">
        </div>
        ${S.importMessage ? `<div style="margin-top:10px;font-size:12px;color:#9CA3AF;line-height:1.6;">${esc(S.importMessage)}</div>` : ''}
        ${trash}
      </div>
    </div>`;
  }

  function render() {
    const root = $('#root');
    let main = '';
    if (S.mode === 'gate') main = gateHtml();
    else if (S.mode === 'app') {
      main = `<div style="display:flex;gap:4px;margin-bottom:32px;background:#1E1E2E;border-radius:10px;padding:4px;">
          ${['input', 'log'].map((v) => `<button type="button" data-act="view" data-v="${v}" style="${ST.tab(S.view === v)}">${v === 'input' ? '記録する' : '波を見る'}</button>`).join('')}
        </div>
        ${S.view === 'input' ? inputViewHtml() : logViewHtml()}`;
    }
    root.innerHTML = `<div style="${ST.outer}"><div style="${ST.inner}">${headerHtml()}${main}</div></div>`;

    // 全期間の波は右端（いちばん新しい日）から見せる
    const sc = $('.wave-scroll', root);
    if (sc) sc.scrollLeft = sc.scrollWidth;
  }

  /** 状態ボタンを押したときは描き直さず、その場で色だけ変える（旧版と同じくふわっと変わるように） */
  function applySelection() {
    for (const btn of document.querySelectorAll('[data-act="pick"]')) {
      const opt = getStateOption(Number(btn.dataset.v));
      const on = S.selected === opt.value;
      btn.style.cssText = ST.stateBtn(opt, on);
      $('[data-part="dot"]', btn).style.cssText = ST.stateDot(opt, on);
      $('[data-part="label"]', btn).style.cssText = ST.stateLabel(opt, on);
    }
    const save = $('#saveBtn');
    if (save) {
      save.disabled = S.selected === null;
      save.style.cssText = ST.saveBtn(S.selected);
    }
  }

  // ------------------------------------------------------------------ 操作

  async function loadEntries() {
    const r = await api('/api/entries');
    S.entries = (r.entries || []).map((e) => ({ ...e, value: Number(e.value) }));
  }
  async function loadTrash() {
    try { S.trash = (await api('/api/trash')).entries || []; } catch (e) { if (!(e instanceof AuthError)) S.trash = []; }
  }

  async function handleSave() {
    if (S.selected === null || S.saving) return;
    S.saving = true;
    S.saveError = '';
    try {
      await api(`/api/days/${S.targetDate}`, { method: 'PUT', body: { value: S.selected, note: S.note } });
      await loadEntries();
      S.saved = true;
      render();
      clearTimeout(handleSave.t);
      handleSave.t = setTimeout(() => { S.saved = false; if (S.mode === 'app' && S.view === 'input') render(); }, 2000);
    } catch (e) {
      if (!(e instanceof AuthError)) {
        S.saveError = `保存できなかった。${e.message === 'Failed to fetch' ? '通信を確認して、もう一度押してください。' : e.message}`;
        render();
      }
    } finally {
      S.saving = false;
    }
  }

  async function handleDeleteDay() {
    const t = targetEntry();
    if (!t) return;
    if (!confirm(`${formatDate(t.date)} の記録（${getStateOption(t.value).label}）を消しますか？\n消した記録は「波を見る」の下のゴミ箱から戻せます。`)) return;
    try {
      await api(`/api/entries/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      await loadEntries();
      syncFromTarget();
      render();
    } catch (e) {
      if (!(e instanceof AuthError)) alert(e.message);
    }
  }

  async function handleRestore(id) {
    try {
      await api(`/api/entries/${encodeURIComponent(id)}/restore`, { method: 'POST' });
      await Promise.all([loadEntries(), loadTrash()]);
      syncFromTarget();
      render();
    } catch (e) {
      if (!(e instanceof AuthError)) alert(e.message);
    }
  }

  async function handleExport() {
    try {
      const data = await api('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wave-journal-backup-${todayStr()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (!(e instanceof AuthError)) alert(e.message);
    }
  }

  function showImportMessage(msg, ms) {
    S.importMessage = msg;
    render();
    clearTimeout(showImportMessage.t);
    showImportMessage.t = setTimeout(() => { S.importMessage = ''; if (S.view === 'log') render(); }, ms);
  }

  async function handleImportFile(file) {
    if (!file) return;
    let imported;
    try {
      imported = JSON.parse(await file.text());
    } catch {
      showImportMessage('読み込みに失敗した。正しいバックアップファイルか確認してください。', 5000);
      return;
    }
    try {
      const r = await api('/api/import', { method: 'POST', body: imported });
      await Promise.all([loadEntries(), loadTrash()]);
      syncFromTarget();
      let msg = `${r.read}件を読み込み、統合しました（合計${r.total}件）`;
      if (r.replaced > 0) msg += `。同じ日の記録${r.replaced}件は読み込んだ方に置き換え、元の記録はゴミ箱に移しました`;
      showImportMessage(msg, r.replaced > 0 ? 9000 : 5000);
    } catch (e) {
      if (e instanceof AuthError) return;
      showImportMessage(e.message === 'Failed to fetch'
        ? '読み込みに失敗した。通信を確認して、もう一度試してください。'
        : '読み込みに失敗した。正しいバックアップファイルか確認してください。', 5000);
    }
  }

  // クリックはまとめて受ける
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'view') {
      S.view = el.dataset.v;
      if (S.view === 'log') loadTrash().then(() => { if (S.view === 'log') render(); });
      render();
    } else if (act === 'pick') {
      S.selected = Number(el.dataset.v);
      applySelection();
    } else if (act === 'save') {
      handleSave();
    } else if (act === 'range') {
      S.logRange = el.dataset.k;
      render();
    } else if (act === 'export') {
      handleExport();
    } else if (act === 'import') {
      $('#importFile').click();
    } else if (act === 'delete-day') {
      handleDeleteDay();
    } else if (act === 'toggle-trash') {
      S.trashOpen = !S.trashOpen;
      render();
    } else if (act === 'restore') {
      handleRestore(el.dataset.id);
    }
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'dateInput') {
      if (!t.value) return;
      S.targetDate = t.value;
      S.saveError = '';
      syncFromTarget();
      render();
    } else if (t.id === 'importFile') {
      const file = t.files[0];
      t.value = '';
      handleImportFile(file);
    }
  });

  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'noteInput') S.note = ev.target.value;
  });
  // メモ欄の枠は、選んでいる状態の色に光る（旧版と同じ）
  document.addEventListener('focusin', (ev) => {
    if (ev.target.id === 'noteInput') {
      ev.target.style.borderColor = S.selected !== null ? getStateOption(S.selected).color : '#A78BFA';
    }
  });
  document.addEventListener('focusout', (ev) => {
    if (ev.target.id === 'noteInput') ev.target.style.borderColor = '#2D2D44';
  });

  document.addEventListener('submit', async (ev) => {
    if (ev.target.id !== 'loginForm') return;
    ev.preventDefault();
    const btn = ev.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      await api('/api/login', { method: 'POST', body: { key: $('#keyInput').value } });
      S.gateMsg = '';
      await startApp();
    } catch (e) {
      S.gateMsg = e.message;
      render();
      const k = $('#keyInput');
      if (k) k.focus();
    }
  });

  // ------------------------------------------------------------------ 起動

  function showGate(msg) {
    S.mode = 'gate';
    S.gateNoKey = false;
    if (msg) S.gateMsg = msg;
    render();
    setTimeout(() => { const k = $('#keyInput'); if (k) k.focus(); }, 50);
  }

  async function startApp() {
    S.mode = 'app';
    S.targetDate = todayStr();
    try {
      await loadEntries();
    } catch (e) {
      if (e instanceof AuthError) return;
      S.saveError = `記録を読み込めなかった。${e.message === 'Failed to fetch' ? '通信を確認して、開き直してください。' : e.message}`;
    }
    syncFromTarget();
    render();
  }

  async function showEnvBanner() {
    try {
      const r = await api('/api/env');
      if (r && r.env === 'dev') {
        const b = document.createElement('div');
        b.className = 'env-banner';
        b.innerHTML = '<span>検証用の環境です（本番の記録とは別のデータベース）</span>';
        document.body.prepend(b);
        document.title = '[検証] ' + document.title;
      }
    } catch { /* 何もしない */ }
  }

  async function boot() {
    render();
    showEnvBanner();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    let s;
    try { s = await api('/api/session'); } catch { showGate('つながりませんでした。通信を確認して、開き直してください。'); return; }
    if (!s.configured) {
      S.mode = 'gate';
      S.gateNoKey = true;
      S.gateMsg = '合言葉がまだ設定されていません。設定のしかたは README にあります。';
      render();
      return;
    }
    if (!s.authed) { showGate(); return; }
    await startApp();
  }

  boot();
})();
