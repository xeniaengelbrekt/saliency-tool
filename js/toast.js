/* ============================================================
   toast.js — лёгкая система уведомлений (правый нижний угол)
   ============================================================ */

let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}

export function toast(message, type = 'info', duration = 3500) {
  const c = ensureContainer();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    <span class="toast-mark"></span>
    <span class="toast-msg">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Закрыть">×</button>
  `;
  c.appendChild(el);

  const close = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('.toast-close').addEventListener('click', close);

  requestAnimationFrame(() => el.classList.add('show'));
  if (duration > 0) {
    setTimeout(close, duration);
  }
}

export const toastError   = (m, d) => toast(m, 'error',   d ?? 5000);
export const toastSuccess = (m, d) => toast(m, 'success', d ?? 2500);
export const toastInfo    = (m, d) => toast(m, 'info',    d ?? 3000);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
