'use strict';

/* ============================================================
   血圧・体重トラッカー  app.js
   - IndexedDB によるローカル保存
   - Web Bluetooth (血圧サービス 0x1810 / 測定値 0x2A35) 取り込み
   - Chart.js による推移グラフ + 目安ライン
   - 一覧表示 + CSV エクスポート
   ============================================================ */

/* ---------- IndexedDB ---------- */
const DB_NAME = 'health-log';
const STORE = 'entries';
let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // 日付(YYYY-MM-DD)を主キーにする = 1日1レコード
        db.createObjectStore(STORE, { keyPath: 'date' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function putEntry(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteEntry(date) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(date);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getEntry(date) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(date);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function getAllEntries() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => {
      // 日付昇順
      resolve(req.result.sort((a, b) => a.date.localeCompare(b.date)));
    };
    req.onerror = () => reject(req.error);
  });
}

/* ---------- タブ切替 ---------- */
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === 'tab-' + tab);
    });
    if (tab === 'chart') renderCharts();
    if (tab === 'list') renderList();
  });
});

/* ---------- 入力フォーム ---------- */
const form = document.getElementById('entry-form');
const $ = (id) => document.getElementById(id);

function todayStr() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
$('f-date').value = todayStr();

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = $('f-date').value;
  if (!date) return;

  // 入力された項目だけを反映し、空欄は既存の値を残す（朝=血圧 / 夜=体重 の二度書きに対応）。
  const existing = (await getEntry(date)) || { date };
  const memo = $('f-memo').value.trim();
  const entry = {
    date,
    systolic: numOrNull($('f-sys').value) ?? existing.systolic ?? null,
    diastolic: numOrNull($('f-dia').value) ?? existing.diastolic ?? null,
    pulse: numOrNull($('f-pulse').value) ?? existing.pulse ?? null,
    weight: numOrNull($('f-weight').value) ?? existing.weight ?? null,
    memo: memo || existing.memo || '',
  };
  await putEntry(entry);
  const msg = $('save-msg');
  msg.textContent = '保存しました ✓';
  setTimeout(() => (msg.textContent = ''), 2000);
  // 入力欄は日付以外クリア
  ['f-sys', 'f-dia', 'f-pulse', 'f-weight', 'f-memo'].forEach((id) => ($(id).value = ''));
});

/* ============================================================
   Web Bluetooth: 標準血圧サービス取り込み
   Service 0x1810, Characteristic 0x2A35 (Blood Pressure Measurement)
   ============================================================ */
const btBtn = document.getElementById('bt-btn');
const btStatus = document.getElementById('bt-status');

function setBtStatus(text) { btStatus.textContent = text; }

/* IEEE-11073 16bit SFLOAT のパース
   上位4bit = 指数(符号付き), 下位12bit = 仮数(符号付き)。
   特殊値 (NaN 等) は null を返す。 */
function parseSFLOAT(value, offset) {
  const raw = value.getUint16(offset, /* littleEndian */ true);
  let mantissa = raw & 0x0fff;
  let exponent = raw >> 12;
  // 特殊値
  if (exponent === 0x0 && mantissa === 0x07ff) return null; // NaN
  if (exponent === 0x0 && mantissa === 0x0800) return null; // NRes
  if (exponent === 0x0 && mantissa === 0x07fe) return Infinity;
  if (exponent === 0x0 && mantissa === 0x0802) return -Infinity;
  // 符号拡張: 仮数 12bit, 指数 4bit
  if (mantissa >= 0x0800) mantissa -= 0x1000;
  if (exponent >= 0x0008) exponent -= 0x0010;
  return mantissa * Math.pow(10, exponent);
}

/* Blood Pressure Measurement (0x2A35) のパース
   byte0: flags
     bit0 単位 (0=mmHg, 1=kPa)
     bit1 時刻あり
     bit2 脈拍あり
   以降: SFLOAT×3 (収縮期/拡張期/平均), [時刻7byte], [脈拍 SFLOAT] */
function parseBPMeasurement(value) {
  const flags = value.getUint8(0);
  const kPa = flags & 0x01;
  const hasTimestamp = flags & 0x02;
  const hasPulse = flags & 0x04;

  let i = 1;
  const systolic = parseSFLOAT(value, i); i += 2;
  const diastolic = parseSFLOAT(value, i); i += 2;
  i += 2; // 平均血圧 (MAP) は使わないので読み飛ばし

  // 測定時刻 (機器が保存しているデータ日付)。複数レコードから最新を選ぶのに使う。
  let ts = null, dateStr = null;
  if (hasTimestamp) {
    const year = value.getUint16(i, true);
    const month = value.getUint8(i + 2);
    const day = value.getUint8(i + 3);
    const hour = value.getUint8(i + 4);
    const min = value.getUint8(i + 5);
    const sec = value.getUint8(i + 6);
    if (year > 0) {
      ts = new Date(year, month - 1, day, hour, min, sec).getTime();
      const p2 = (n) => String(n).padStart(2, '0');
      dateStr = `${year}-${p2(month)}-${p2(day)}`;
    }
    i += 7;
  }

  let pulse = null;
  if (hasPulse) { pulse = parseSFLOAT(value, i); i += 2; }

  const conv = (v) => (v == null ? null : kPa ? v * 7.50062 : v); // kPa→mmHg
  return {
    systolic: systolic == null ? null : Math.round(conv(systolic)),
    diastolic: diastolic == null ? null : Math.round(conv(diastolic)),
    pulse: pulse == null ? null : Math.round(pulse),
    ts,       // 比較用のミリ秒 (時刻が無ければ null)
    dateStr,  // YYYY-MM-DD (時刻が無ければ null)
  };
}

btBtn.addEventListener('click', async () => {
  if (!navigator.bluetooth) {
    setBtStatus('この端末は Web Bluetooth 非対応です。手入力をご利用ください。');
    return;
  }
  try {
    setBtStatus('デバイスを検索中…');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [0x1810] }],
    });
    // Windows では初回の gatt.connect が NetworkError になりやすいので数回リトライする。
    let server = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        setBtStatus(`${device.name || 'デバイス'} に接続中…（${attempt}/4）`);
        server = await device.gatt.connect();
        break;
      } catch (e) {
        console.warn(`[BT] connect attempt ${attempt} failed:`, e && e.message);
        if (attempt === 4) throw e;
        await new Promise((r) => setTimeout(r, 800)); // 少し待って再試行
      }
    }
    const service = await server.getPrimaryService(0x1810);
    const ch = await service.getCharacteristic(0x2a35);

    // UA-651BLE 等は接続直後に保存済みの測定データを Indicate で一気に送ってくる。
    // 受信した全レコードを日付ごとにまとめ（同一日は時刻が新しい方を採用）、
    // 取り込み完了時にまとめて一覧へ保存する。
    const byDate = new Map(); // dateStr -> { systolic, diastolic, pulse, ts, dateStr }
    let best = null;          // 画面表示用の最新レコード
    let received = 0;

    // ★ 重要: 通知の取りこぼしを防ぐため、リスナーは startNotifications より前に付ける。
    ch.addEventListener('characteristicvaluechanged', (ev) => {
      const dv = ev.target.value;
      const m = parseBPMeasurement(dv);
      received++;
      if (m.systolic == null) return; // 血圧が読めないフレームは無視

      // 日付単位で集約（時刻が無いものは今日扱い）。同一日は新しい時刻を優先。
      const key = m.dateStr || todayStr();
      const prev = byDate.get(key);
      if (!prev || (m.ts != null && (prev.ts == null || m.ts >= prev.ts))) byDate.set(key, m);

      // 全体で最も新しいものを画面プレビューに反映
      if (!best || (m.ts != null && (best.ts == null || m.ts >= best.ts))) best = m;
      if (best.systolic != null) $('f-sys').value = best.systolic;
      if (best.diastolic != null) $('f-dia').value = best.diastolic;
      if (best.pulse != null) $('f-pulse').value = best.pulse;
      if (best.dateStr) $('f-date').value = best.dateStr;
      setBtStatus(`受信中… ${best.systolic}/${best.diastolic} mmHg（${received}件）`);
    });

    // 送信が途切れた or 機器が切断したら、受信分をまとめて一覧へ保存する。
    let finished = false;
    const finish = async () => {
      if (finished) return; // 二重実行防止
      finished = true;
      if (byDate.size === 0) {
        setBtStatus('接続はできましたがデータが届きませんでした。血圧計で新しく測定してから、数秒以内に再度お試しください。');
        return;
      }
      // 既存の体重・メモは残しつつ、血圧/脈拍だけ上書き（マージ保存）
      let saved = 0;
      for (const [date, m] of byDate) {
        const existing = (await getEntry(date)) || { date };
        await putEntry({
          date,
          systolic: m.systolic ?? existing.systolic ?? null,
          diastolic: m.diastolic ?? existing.diastolic ?? null,
          pulse: m.pulse ?? existing.pulse ?? null,
          weight: existing.weight ?? null,
          memo: existing.memo || '',
        });
        saved++;
      }
      // 入力欄はクリア（保存済みなので手動保存は不要）
      ['f-sys', 'f-dia', 'f-pulse'].forEach((id) => ($(id).value = ''));
      $('f-date').value = todayStr();
      setBtStatus(`${saved}件を一覧に保存しました ✓（「一覧」タブで確認）`);
      renderList();
      if (document.getElementById('tab-chart').classList.contains('active')) renderCharts();
    };
    device.addEventListener('gattserverdisconnected', finish, { once: true });

    await ch.startNotifications();
    setBtStatus('接続しました。保存済みデータの受信を待っています…');

    // 機器が自動切断しない場合の保険: 6秒受信が無ければこちらから切断して確定
    let lastCount = -1;
    const timer = setInterval(() => {
      if (received === lastCount) {
        clearInterval(timer);
        if (device.gatt.connected) device.gatt.disconnect(); // → finish が走る
        else finish();
      }
      lastCount = received;
    }, 3000);
  } catch (err) {
    // ユーザーキャンセルや非対応 → 手入力にフォールバック
    if (err && err.name === 'NotFoundError') {
      setBtStatus('接続をキャンセルしました。手入力をご利用ください。');
    } else {
      setBtStatus('接続できませんでした。手入力をご利用ください。');
      console.warn('Bluetooth error:', err);
    }
  }
});

/* ============================================================
   グラフ (Chart.js)
   ============================================================ */
let bpChart, weightChart;
let currentRange = 7;

document.querySelectorAll('.range-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b === btn));
    currentRange = Number(btn.dataset.range);
    renderCharts();
  });
});

function filterByRange(entries, days) {
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const sinceStr = todayStrFrom(since);
  return entries.filter((e) => e.date >= sinceStr);
}
function todayStrFrom(d) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

const CHART_FONT = '#6b7a7e';
function baseOptions(yTitle) {
  return {
    responsive: true,
    maintainAspectRatio: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: CHART_FONT, boxWidth: 14 } },
      tooltip: { enabled: true },
    },
    scales: {
      x: { ticks: { color: CHART_FONT, maxRotation: 0, autoSkip: true }, grid: { color: '#eef1f0' } },
      y: { title: { display: true, text: yTitle, color: CHART_FONT }, ticks: { color: CHART_FONT }, grid: { color: '#eef1f0' } },
    },
  };
}

async function renderCharts() {
  const all = await getAllEntries();
  const data = filterByRange(all, currentRange);
  const labels = data.map((e) => e.date.slice(5)); // MM-DD

  const css = getComputedStyle(document.documentElement);
  const cSys = css.getPropertyValue('--sys').trim();
  const cDia = css.getPropertyValue('--dia').trim();
  const cPulse = css.getPropertyValue('--pulse').trim();
  const cWeight = css.getPropertyValue('--weight').trim();

  // --- 血圧・脈拍 ---
  const n = labels.length;
  const bpData = {
    labels,
    datasets: [
      { label: '最高', data: data.map((e) => e.systolic), borderColor: cSys, backgroundColor: cSys, tension: 0.25, spanGaps: true },
      { label: '最低', data: data.map((e) => e.diastolic), borderColor: cDia, backgroundColor: cDia, tension: 0.25, spanGaps: true },
      { label: '脈拍', data: data.map((e) => e.pulse), borderColor: cPulse, backgroundColor: cPulse, tension: 0.25, spanGaps: true, borderDash: [2, 2] },
      // 目安ライン 135 / 85 (点線)
      { label: '目安135', data: Array(n).fill(135), borderColor: cSys, borderDash: [6, 4], borderWidth: 1, pointRadius: 0, fill: false },
      { label: '目安85', data: Array(n).fill(85), borderColor: cDia, borderDash: [6, 4], borderWidth: 1, pointRadius: 0, fill: false },
    ],
  };
  const bpOpts = baseOptions('mmHg / bpm');
  if (bpChart) { bpChart.data = bpData; bpChart.options = bpOpts; bpChart.update(); }
  else bpChart = new Chart($('bp-chart'), { type: 'line', data: bpData, options: bpOpts });

  // --- 体重 ---
  const wData = {
    labels,
    datasets: [
      { label: '体重', data: data.map((e) => e.weight), borderColor: cWeight, backgroundColor: cWeight, tension: 0.25, spanGaps: true },
    ],
  };
  const wOpts = baseOptions('kg');
  wOpts.scales.y.beginAtZero = false;
  if (weightChart) { weightChart.data = wData; weightChart.options = wOpts; weightChart.update(); }
  else weightChart = new Chart($('weight-chart'), { type: 'line', data: wData, options: wOpts });
}

/* ============================================================
   一覧 + CSV
   ============================================================ */
async function renderList() {
  const all = await getAllEntries();
  const tbody = document.querySelector('#list-table tbody');
  tbody.innerHTML = '';
  if (all.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">記録がありません</td></tr>';
    return;
  }
  // 新しい日付を上に
  all.slice().reverse().forEach((e) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${e.date}</td>` +
      `<td>${e.systolic ?? ''}</td>` +
      `<td>${e.diastolic ?? ''}</td>` +
      `<td>${e.pulse ?? ''}</td>` +
      `<td>${e.weight ?? ''}</td>` +
      `<td style="text-align:left">${escapeHtml(e.memo || '')}</td>` +
      `<td><button class="del" title="削除" data-date="${e.date}">✕</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.del').forEach((b) => {
    b.addEventListener('click', async () => {
      if (confirm(`${b.dataset.date} の記録を削除しますか?`)) {
        await deleteEntry(b.dataset.date);
        renderList();
      }
    });
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

document.getElementById('csv-btn').addEventListener('click', async () => {
  const all = await getAllEntries();
  const header = ['日付', '最高', '最低', '脈拍', '体重', 'メモ'];
  const rows = all.map((e) => [e.date, e.systolic, e.diastolic, e.pulse, e.weight, e.memo].map(csvCell).join(','));
  const csv = '﻿' + header.join(',') + '\n' + rows.join('\n'); // BOM付きでExcel文字化け回避
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `health-log_${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ---------- Service Worker 登録 ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW register failed', e));
  });
}
