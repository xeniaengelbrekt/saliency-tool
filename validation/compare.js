// compare.js — прогоняет данные validation/data/reference.json через JS-код и сравнивает с эталоном.
import { computeSaliency } from '../js/algorithms/index.js';
import { computeMetrics, pearsonR } from '../js/metrics.js';
import { oneWayAnova, tCritical, meanCI95, fCdf } from '../js/stats.js';
import {
  mapFixations, buildFixationMap, centerBaseline, prepareMap, evaluateMap,
} from '../js/eyetracking/fixmap.js';

const METHODS = ['ft', 'dog', 'local', 'sr'];
const MKEYS = ['mean', 'peak', 'entropy', 'center_bias', 'spread_pct', 'peak_x', 'peak_y'];
const EKEYS = ['cc', 'nss', 'auc', 'sauc', 'sim', 'kl'];

const bytes = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const f32 = (b64) => new Float32Array(bytes(b64).buffer);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const sci = (v) => (Number.isFinite(v) ? v.toExponential(1) : '—');

const status = document.getElementById('status');
const out = document.getElementById('out');
const ref = await (await fetch('data/reference.json')).json();
status.textContent = `Эталон: numpy ${ref.libs.numpy}, scipy ${ref.libs.scipy}, OpenCV ${ref.libs.opencv}; изображений: ${ref.images.length}`;

const summary = { libs: ref.libs, nImages: ref.images.length, maps: {}, metrics: {}, eval: {}, stats: {}, perImage: [] };
const mapRows = {}, metRows = {}, evalRows = { ft: {}, center: {} };
for (const m of METHODS) { mapRows[m] = []; metRows[m] = {}; MKEYS.forEach((k) => (metRows[m][k] = [])); }
for (const t of ['ft', 'center']) EKEYS.forEach((k) => (evalRows[t][k] = []));

for (const im of ref.images) {
  const { w, h } = im;
  const rgb = bytes(im.rgb);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[i * 3]; data[i * 4 + 1] = rgb[i * 3 + 1]; data[i * 4 + 2] = rgb[i * 3 + 2]; data[i * 4 + 3] = 255;
  }
  const img = { data, width: w, height: h };
  const row = { name: im.name, size: `${w}×${h}`, maps: {} };

  let ftSal = null;
  for (const m of METHODS) {
    const sal = computeSaliency(img, m);
    if (m === 'ft') ftSal = sal;
    const r = f32(im.maps[m]);
    let maxAbs = 0, sumAbs = 0;
    for (let i = 0; i < r.length; i++) { const d = Math.abs(sal[i] - r[i]); if (d > maxAbs) maxAbs = d; sumAbs += d; }
    const cell = { corr: pearsonR(sal, r), maxAbs, meanAbs: sumAbs / r.length, rawRatio: sal.rawMax / im.raw[m].max };
    mapRows[m].push(cell);
    row.maps[m] = cell;
    const mj = computeMetrics(sal);
    for (const k of MKEYS) metRows[m][k].push({ js: mj[k], ref: im.metrics[m][k] });
  }

  // метрики соответствия: JS-карта FT и JS-карта фиксаций
  const frame = { x0: 0, y0: 0, w, h };
  const fixes = im.fix.u.map((u, i) => ({ x: u * w, y: im.fix.v[i] * h, duration: 1, participant: im.fix.participant[i] }));
  const { points } = mapFixations(fixes, frame, w, h, false);
  const fix = buildFixationMap(points, w, h, frame, im.sigma);
  const neg = [];
  for (const o of ref.images) {
    if (o === im) continue;
    for (let i = 0; i < o.fix.u.length; i++) neg.push(Math.floor(o.fix.v[i] * h) * w + Math.floor(o.fix.u[i] * w));
  }
  const evs = {
    ft: evaluateMap(prepareMap(ftSal), points, fix, neg),
    center: evaluateMap(prepareMap(centerBaseline(w, h)), points, fix, neg),
  };
  for (const t of ['ft', 'center']) for (const k of EKEYS) evalRows[t][k].push({ js: evs[t][k], ref: im.eval[t][k] });
  summary.perImage.push(row);
}

// ---- статистика ----
const st = ref.stats;
const an = oneWayAnova(st.groups);
const tdiff = st.t_dfs.map((d, i) => Math.abs(tCritical(0.975, d) - st.t975[i]));
const ci = meanCI95(st.sample);
const fdiff = st.fcdf.map(([x, d1, d2, v]) => Math.abs(fCdf(x, d1, d2) - v));
summary.stats = {
  anovaF: { js: an.F, ref: st.F, absDiff: Math.abs(an.F - st.F) },
  anovaP: { js: an.p, ref: st.p, absDiff: Math.abs(an.p - st.p) },
  tQuantileMaxAbsDiff: Math.max(...tdiff),
  ciMaxAbsDiff: Math.max(Math.abs(ci.lo - st.ci[0]), Math.abs(ci.hi - st.ci[1])),
  fCdfMaxAbsDiff: Math.max(...fdiff),
};

// ---- сводка ----
for (const m of METHODS) {
  const rs = mapRows[m];
  summary.maps[m] = {
    corrMin: Math.min(...rs.map((r) => r.corr)), corrMedian: median(rs.map((r) => r.corr)),
    maxAbsMax: Math.max(...rs.map((r) => r.maxAbs)), meanAbsMax: Math.max(...rs.map((r) => r.meanAbs)),
    rawRatioMin: Math.min(...rs.map((r) => r.rawRatio)), rawRatioMax: Math.max(...rs.map((r) => r.rawRatio)),
  };
  summary.metrics[m] = {};
  for (const k of MKEYS) {
    const d = metRows[m][k].map((x) => Math.abs(x.js - x.ref));
    const rel = metRows[m][k].map((x) => Math.abs(x.js - x.ref) / Math.max(Math.abs(x.ref), 1e-12));
    summary.metrics[m][k] = { maxAbs: Math.max(...d), maxRel: Math.max(...rel) };
  }
}
for (const t of ['ft', 'center']) {
  summary.eval[t] = {};
  for (const k of EKEYS) {
    const d = evalRows[t][k].map((x) => Math.abs(x.js - x.ref));
    const n = d.length;
    summary.eval[t][k] = {
      maxAbs: Math.max(...d), medianAbs: median(d),
      jsMean: evalRows[t][k].reduce((s, x) => s + x.js, 0) / n,
      refMean: evalRows[t][k].reduce((s, x) => s + x.ref, 0) / n,
    };
  }
}
window.__validation = summary;

// ---- вывод ----
let html = '';
html += '<h2>1. Карты салиентности: JS против независимой реализации</h2><table><tr><th>метод</th><th>r мин.</th><th>r медиана</th><th>макс. |Δ| карты</th><th>макс. средн. |Δ|</th><th>peak JS/эталон, мин…макс</th></tr>';
for (const m of METHODS) {
  const s = summary.maps[m];
  html += `<tr><td>${m}</td><td>${fmt(s.corrMin, 6)}</td><td>${fmt(s.corrMedian, 6)}</td><td>${fmt(s.maxAbsMax)}</td><td>${sci(s.meanAbsMax)}</td><td>${fmt(s.rawRatioMin, 4)} … ${fmt(s.rawRatioMax, 4)}</td></tr>`;
}
html += '</table>';
html += '<h2>2. Метрики карты: максимальное абсолютное / относительное расхождение</h2><table><tr><th>метод</th>' + MKEYS.map((k) => `<th>${k}</th>`).join('') + '</tr>';
for (const m of METHODS) html += `<tr><td>${m}</td>` + MKEYS.map((k) => `<td>${sci(summary.metrics[m][k].maxAbs)} / ${sci(summary.metrics[m][k].maxRel)}</td>`).join('') + '</tr>';
html += '</table>';
html += '<h2>3. Метрики соответствия фиксациям (модель FT и центральный baseline)</h2><table><tr><th>модель</th><th></th>' + EKEYS.map((k) => `<th>${k}</th>`).join('') + '</tr>';
for (const t of ['ft', 'center']) {
  html += `<tr><td>${t}</td><td>макс. |Δ|</td>` + EKEYS.map((k) => `<td>${sci(summary.eval[t][k].maxAbs)}</td>`).join('') + '</tr>';
  html += '<tr><td></td><td class="dim">среднее JS / эталон</td>' + EKEYS.map((k) => `<td class="dim">${fmt(summary.eval[t][k].jsMean, 3)} / ${fmt(summary.eval[t][k].refMean, 3)}</td>`).join('') + '</tr>';
}
html += '</table>';
html += `<h2>4. Статистика (scipy)</h2><table><tr><th>величина</th><th>JS</th><th>эталон</th><th>|Δ|</th></tr>
<tr><td>ANOVA F</td><td>${fmt(an.F, 6)}</td><td>${fmt(st.F, 6)}</td><td>${sci(summary.stats.anovaF.absDiff)}</td></tr>
<tr><td>ANOVA p</td><td>${fmt(an.p, 6)}</td><td>${fmt(st.p, 6)}</td><td>${sci(summary.stats.anovaP.absDiff)}</td></tr>
<tr><td>квантиль t(0.975), df = ${st.t_dfs.join(', ')}</td><td colspan="2" class="dim">макс. расхождение</td><td>${sci(summary.stats.tQuantileMaxAbsDiff)}</td></tr>
<tr><td>95 % ДИ среднего (n = 9)</td><td colspan="2" class="dim">макс. расхождение границ</td><td>${sci(summary.stats.ciMaxAbsDiff)}</td></tr>
<tr><td>CDF F-распределения (3 точки)</td><td colspan="2" class="dim">макс. расхождение</td><td>${sci(summary.stats.fCdfMaxAbsDiff)}</td></tr></table>`;
html += '<h2>5. По изображениям: корреляция карт JS ↔ эталон</h2><table><tr><th>изображение</th><th>размер</th>' + METHODS.map((m) => `<th>${m}</th>`).join('') + '</tr>';
for (const r of summary.perImage) html += `<tr><td>${r.name}</td><td>${r.size}</td>` + METHODS.map((m) => `<td>${fmt(r.maps[m].corr, 6)}</td>`).join('') + '</tr>';
html += '</table>';
out.innerHTML = html;
status.textContent += ' — готово';
