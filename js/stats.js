/* ============================================================
   stats.js — минимальная статистика без зависимостей:
   описательные статистики, доверительный интервал среднего
   (t-распределение), однофакторный ANOVA с точным p-value.
   ============================================================ */

export function meanOf(arr) {
  if (!arr.length) return NaN;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** Выборочное стандартное отклонение (n − 1). */
export function sdOf(arr) {
  const n = arr.length;
  if (n < 2) return NaN;
  const m = meanOf(arr);
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  return Math.sqrt(s / (n - 1));
}

/**
 * Среднее и 95 % доверительный интервал по t-распределению.
 * Возвращает { n, mean, sd, lo, hi }; при n < 2 границы = NaN.
 */
export function meanCI95(arr) {
  const vals = arr.filter((v) => isFinite(v));
  const n = vals.length;
  const m = meanOf(vals);
  const s = sdOf(vals);
  if (n < 2) return { n, mean: m, sd: s, lo: NaN, hi: NaN };
  const half = tCritical(0.975, n - 1) * s / Math.sqrt(n);
  return { n, mean: m, sd: s, lo: m - half, hi: m + half };
}

/**
 * Однофакторный дисперсионный анализ.
 * groups — массив массивов чисел (≥ 2 групп, в сумме > числа групп).
 * Возвращает { F, df1, df2, p, eta2 } или null, если посчитать нельзя.
 */
export function oneWayAnova(groups) {
  const gs = groups.filter((g) => g.length > 0);
  const k = gs.length;
  const N = gs.reduce((s, g) => s + g.length, 0);
  if (k < 2 || N <= k) return null;
  const grand = meanOf(gs.flat());
  let ssb = 0, ssw = 0;
  for (const g of gs) {
    const m = meanOf(g);
    ssb += g.length * (m - grand) * (m - grand);
    for (const v of g) ssw += (v - m) * (v - m);
  }
  const df1 = k - 1;
  const df2 = N - k;
  const sst = ssb + ssw;
  if (ssw === 0) {
    return { F: ssb === 0 ? 0 : Infinity, df1, df2, p: ssb === 0 ? 1 : 0, eta2: sst > 0 ? 1 : 0 };
  }
  const F = (ssb / df1) / (ssw / df2);
  const p = 1 - fCdf(F, df1, df2);
  return { F, df1, df2, p, eta2: sst > 0 ? ssb / sst : 0 };
}

/* ---------------- распределения ---------------- */

/** CDF F-распределения через регуляризованную неполную бета-функцию. */
export function fCdf(F, d1, d2) {
  if (F <= 0) return 0;
  const x = (d1 * F) / (d1 * F + d2);
  return betaInc(x, d1 / 2, d2 / 2);
}

/** CDF t-распределения. */
export function tCdf(t, df) {
  const x = df / (df + t * t);
  const tail = 0.5 * betaInc(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Квантиль t-распределения (бисекция по tCdf). */
export function tCritical(q, df) {
  let lo = 0, hi = 1000;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < q) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Регуляризованная неполная бета-функция I_x(a, b) (Numerical Recipes, betacf). */
export function betaInc(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b + lbeta);
  if (x < (a + 1) / (a + b + 2)) return front * betacf(x, a, b) / a;
  return 1 - front * betacf(1 - x, b, a) / b;
}

function betacf(x, a, b) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** ln Γ(x), аппроксимация Ланцоша. */
function lgamma(x) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Форматирование p-value для отчёта. */
export function formatP(p) {
  if (!isFinite(p)) return '—';
  if (p < 0.001) return '< .001';
  return p.toFixed(3).replace(/^0/, '');
}
