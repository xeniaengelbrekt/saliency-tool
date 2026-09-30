// compare_external.js — метрики соответствия JS-кодом на ТЕХ ЖЕ входных данных, что получит внешняя
// библиотека (карта модели, карта плотности фиксаций, пиксели фиксаций и негативов из reference.json).
// Результат (window.__identical и вывод на странице) сохраняется в validation/data/js_identical.json
// и сверяется скриптом compare_external.py с pysaliency и OpenCV-contrib.
import { prepareMap, evaluateMap } from '../js/eyetracking/fixmap.js';

const bytes = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const f32 = (b64) => new Float32Array(bytes(b64).buffer);

const ref = await (await fetch('data/reference.json')).json();
const out = [];
for (const im of ref.images) {
  const dens = f32(im.dens);
  // JS-код ожидает плотность с суммой 1 (pysaliency нормирует сама)
  let tot = 0; for (let i = 0; i < dens.length; i++) tot += dens[i];
  for (let i = 0; i < dens.length; i++) dens[i] /= tot;
  const points = im.idx.map((i) => ({ idx: i, w: 1 }));
  const row = { name: im.name };
  for (const [model, b64] of [['ft', im.maps.ft], ['center', im.center]]) {
    const r = evaluateMap(prepareMap(f32(b64)), points, { density: dens }, im.neg);
    row[model] = { cc: r.cc, nss: r.nss, auc: r.auc, sauc: r.sauc, sim: r.sim, kl: r.kl };
  }
  out.push(row);
}
window.__identical = out;
document.body.style.cssText = 'font:13px ui-monospace,Consolas,monospace;background:#050a08;color:#d4ecd4;padding:24px';
document.body.innerHTML = '<h3>Метрики JS на общих входных данных (' + out.length + ' изображений)</h3><pre id="json"></pre>';
document.getElementById('json').textContent = JSON.stringify(out);
