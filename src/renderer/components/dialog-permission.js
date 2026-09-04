import { icons } from '../icons.js';

const host = document.getElementById('dialog-host');

const LABELS = {
  media: { title: 'Camera & microphone', body: 'wants to use your camera and microphone.' },
  location: { title: 'Location', body: 'wants to know your location.' },
};

function close() {
  host.classList.remove('open');
  host.innerHTML = '';
  window.myApps.send('ui:modal-open', false);
}

function respond(id, allow) {
  window.myApps.invoke('link:permission-respond', id, allow);
  close();
}

// Opened from app.js when main sends 'shell:permission-prompt' — a link is
// asking for a real OS permission (camera/mic) for the first time and main
// is waiting on us to answer before it can call Electron's callback().
export function openPermissionPrompt({ id, kind, linkName }) {
  const label = LABELS[kind] || { title: 'Permission', body: 'is requesting a permission.' };
  host.innerHTML = `
    <div class="dialog" style="width:380px;">
      <div class="dialog-header">
        <h2>${label.title}</h2>
        <button class="dialog-close">${icons.x}</button>
      </div>
      <div class="dialog-body">
        <p style="margin:0;">"<strong>${linkName}</strong>" ${label.body}</p>
        <p class="hint" style="margin-top:8px;">Your answer is remembered — you won't be asked again for this app.</p>
      </div>
      <div class="dialog-footer">
        <button class="btn" id="perm-block">Block</button>
        <button class="btn primary" id="perm-allow">Allow</button>
      </div>
    </div>
  `;
  host.classList.add('open');
  window.myApps.send('ui:modal-open', true);

  host.querySelector('.dialog-close').addEventListener('click', () => respond(id, false));
  document.getElementById('perm-block').addEventListener('click', () => respond(id, false));
  document.getElementById('perm-allow').addEventListener('click', () => respond(id, true));
}
