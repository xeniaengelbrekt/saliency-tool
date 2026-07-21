/* ============================================================
   app.js — точка входа
   Глобальное состояние настроек + переключение вкладок,
   подключение модулей-режимов.
   ============================================================ */

import { initSingleMode } from './modes/single.js';
import { initCompareMode } from './modes/compare.js';
import { initMatchMode } from './modes/match.js';
import { METHOD_DESC } from './metrics.js';

/**
 * Рендерит развёрнутое описание выбранного метода в блок под селектором.
 * Контент берётся из METHOD_DESC.
 */
function renderMethodDesc(container, method) {
  if (!container) return;
  const d = METHOD_DESC[method];
  if (!d) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <div>
      <span class="method-desc-title">${d.title}</span>
      <span class="method-desc-source">· ${escapeHtml(d.source)}</span>
    </div>
    <div class="method-desc-row"><span class="method-desc-key">что</span><span class="method-desc-val">${escapeHtml(d.what)}</span></div>
    <div class="method-desc-row"><span class="method-desc-key">когда</span><span class="method-desc-val">${escapeHtml(d.when)}</span></div>
    <div class="method-desc-row method-desc-pitfall"><span class="method-desc-key">осторожно</span><span class="method-desc-val">${escapeHtml(d.pitfall)}</span></div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const state = {
  method: 'ft',
  colormap: 'jet',
  alpha: 0.7,
  mode: 'home',
};

const subscribers = new Set();
let lastNotified = { method: state.method, colormap: state.colormap, alpha: state.alpha };

export function getSettings() {
  return { ...state };
}

/**
 * Подписка на изменения. Колбэк получает {settings, changed}, где changed —
 * объект с булевыми флагами {method, colormap, alpha}, чтобы режимы могли
 * различать «полный пересчёт» (method) и «только рендер» (colormap/alpha).
 */
export function onSettingsChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify() {
  const changed = {
    method:   state.method   !== lastNotified.method,
    colormap: state.colormap !== lastNotified.colormap,
    alpha:    state.alpha    !== lastNotified.alpha,
  };
  lastNotified = { method: state.method, colormap: state.colormap, alpha: state.alpha };
  const settings = getSettings();
  for (const fn of subscribers) fn(settings, changed);
}

/* -------------------- Переключение режимов -------------------- */

/**
 * Переключает активный режим. Скроллит к началу страницы для удобства.
 */
function setMode(name) {
  if (name === state.mode) return;
  document.querySelectorAll('.mode-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `mode-${name}`);
  });
  document.body.classList.toggle('on-home', name === 'home');
  state.mode = name;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  notify();
}

/* -------------------- Главное окно: переход к задаче -------------------- */

function initHome() {
  document.querySelectorAll('.task-card[data-go]').forEach((card) => {
    card.addEventListener('click', () => setMode(card.dataset.go));
  });

  // Логотип в шапке возвращает на главную
  const logo = document.querySelector('.logo');
  if (logo) {
    logo.addEventListener('click', (e) => {
      e.preventDefault();
      setMode('home');
    });
  }
}

/* -------------------- Модальное окно «Помощь» -------------------- */

function initHelpModal() {
  const modal = document.getElementById('helpModal');
  const helpBtn = document.getElementById('helpBtn');
  if (!modal || !helpBtn) return;

  const tabs = modal.querySelectorAll('.modal-tab[data-help]');
  const sections = modal.querySelectorAll('.help-section[data-help-id]');

  /** Открыть модалку, опционально с активным разделом по id. */
  const open = (sectionId) => {
    if (sectionId) selectSection(sectionId);
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  };
  const close = () => {
    modal.hidden = true;
    document.body.style.overflow = '';
  };

  function selectSection(id) {
    let found = false;
    tabs.forEach((t) => {
      const active = t.dataset.help === id;
      if (active) found = true;
      t.classList.toggle('active', active);
    });
    if (!found) return false;
    sections.forEach((s) => s.classList.toggle('active', s.dataset.helpId === id));
    const body = modal.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
    return true;
  }

  helpBtn.addEventListener('click', () => open());
  modal.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', close);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => selectSection(tab.dataset.help));
  });

  // Поддержка глубоких ссылок: salience.html#help-<section-id>
  // (например #help-eyetracking — открывает модалку на разделе «Айтрекинг»)
  function maybeOpenFromHash() {
    const hash = (location.hash || '').replace(/^#/, '');
    const m = hash.match(/^help-([\w-]+)$/);
    if (m && selectSection(m[1])) {
      open();
    }
  }
  maybeOpenFromHash();
  window.addEventListener('hashchange', maybeOpenFromHash);
}

/* -------------------- Глобальные настройки -------------------- */

function initSettings() {
  const methodSel = document.getElementById('method');
  const colormapSel = document.getElementById('colormap');
  const alphaInp = document.getElementById('alpha');
  const alphaVal = document.getElementById('alphaVal');
  const infoMethod = document.getElementById('infoMethod');
  const methodDescBox = document.getElementById('methodDesc');

  const methodHints = {
    ft:    { label: 'FT',             hint: 'цветовая салиентность через CIE Lab — лица и натуральные сцены' },
    dog:   { label: 'DoG',            hint: 'многомасштабный контраст яркости — универсальный' },
    local: { label: 'Local Contrast', hint: 'быстрый локальный контраст — для скрининга' },
    sr:    { label: 'SR',             hint: 'спектральный остаток — выделяет нетипичные паттерны' },
  };

  const updateMethodHint = () => {
    if (infoMethod) {
      const h = methodHints[state.method];
      infoMethod.innerHTML = `<strong>${h.label}</strong> — ${h.hint}`;
    }
    renderMethodDesc(methodDescBox, state.method);
  };
  updateMethodHint();

  methodSel.addEventListener('change', () => {
    state.method = methodSel.value;
    updateMethodHint();
    notify();
  });

  colormapSel.addEventListener('change', () => {
    state.colormap = colormapSel.value;
    notify();
  });

  alphaInp.addEventListener('input', () => {
    const pct = +alphaInp.value;
    state.alpha = pct / 100;
    if (alphaVal) alphaVal.textContent = `${pct}%`;
    notify();
  });
}

/* -------------------- Старт -------------------- */

document.addEventListener('DOMContentLoaded', () => {
  initHome();
  initHelpModal();
  initSettings();
  initSingleMode();
  initCompareMode();
  initMatchMode();
  // Стартовое состояние — home: применить класс к body, чтобы спрятать настройки
  document.body.classList.toggle('on-home', state.mode === 'home');
});
