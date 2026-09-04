const host = document.getElementById('toast-host');
let hideTimer = null;

export function showToast({ type = 'info', message = '' }) {
  if (hideTimer) clearTimeout(hideTimer);
  host.innerHTML = '';

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  el.title = message; // full text on hover, since long messages get ellipsized
  host.appendChild(el);

  hideTimer = setTimeout(() => {
    el.style.transition = 'opacity 200ms ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 5000);
}
