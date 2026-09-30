import { icons } from '../icons.js';

const screenEl = document.getElementById('lock-screen');
const dialogHost = document.getElementById('dialog-host');
const quickSwitch = document.getElementById('quick-switch');

let input;
let button;
let errorEl;
let countdown = null;

function build() {
  screenEl.innerHTML = `
    <div class="lock-card">
      <div class="lock-icon">${icons.lock}</div>
      <h2>My Apps is locked</h2>
      <div class="lock-sub">Enter your lock password to continue.</div>
      <form id="lock-form">
        <input type="password" id="lock-input" autocomplete="off" placeholder="Password" />
        <button type="submit" class="lock-go" id="lock-go">Unlock</button>
      </form>
      <div class="lock-error" id="lock-error"></div>
    </div>
  `;
  input = document.getElementById('lock-input');
  button = document.getElementById('lock-go');
  errorEl = document.getElementById('lock-error');
  document.getElementById('lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (button.disabled) return;
    const res = await window.myApps.invoke('lock:unlock', input.value);
    input.value = '';
    if (res && res.ok) return; // main sends shell:lock, which hides this screen
    if (res && res.waitSeconds > 0) startWait(res.waitSeconds);
    else errorEl.textContent = 'Wrong password.';
    input.focus();
  });
}

function startWait(seconds) {
  clearInterval(countdown);
  let left = seconds;
  button.disabled = true;
  input.disabled = true;
  const tick = () => {
    if (left <= 0) {
      clearInterval(countdown);
      button.disabled = false;
      input.disabled = false;
      errorEl.textContent = '';
      input.focus();
      return;
    }
    errorEl.textContent = `Too many wrong tries. Wait ${left}s.`;
    left -= 1;
  };
  tick();
  countdown = setInterval(tick, 1000);
}

export function setLocked(status) {
  const locked = !!(status && status.locked);
  document.documentElement.setAttribute('data-locked', locked ? '1' : '0');
  if (!locked) {
    clearInterval(countdown);
    if (input) { input.value = ''; input.disabled = false; button.disabled = false; errorEl.textContent = ''; }
    return;
  }
  // Close anything open in the shell so nothing is waiting behind the lock.
  dialogHost.classList.remove('open');
  dialogHost.innerHTML = '';
  quickSwitch.classList.remove('open');
  window.myApps.send('ui:modal-open', false);
  if (status.waitSeconds > 0) startWait(status.waitSeconds);
  setTimeout(() => input && input.focus(), 0);
}

export function initLockScreen() {
  build();
  window.myApps.on('shell:lock', setLocked);
}
