let sessionId = localStorage.getItem('mobide-session');
let currentPath = '';
let ctrlActive = false;
let lastAuth = { url: null, code: null };

const fileList = document.getElementById('file-list');
const filesSearch = document.getElementById('files-search');
const editorOverlay = document.getElementById('editor-overlay');
const editorTextarea = document.getElementById('editor-textarea');
const editorPath = document.getElementById('editor-path');
const authUrl = document.getElementById('auth-url');
const authCode = document.getElementById('auth-code');

const term = new Terminal({
  convertEol: true,
  cursorBlink: true,
  fontSize: 13,
  theme: { background: '#0f1216' }
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));

function setAppHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
  fitTerminal();
}

function fitTerminal() {
  fitAddon.fit();
  if (socket?.connected) {
    socket.emit('resize', { cols: term.cols, rows: term.rows });
  }
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Request failed');
  }
  return response.json();
}

async function ensureSession() {
  if (!sessionId) {
    const data = await apiRequest('/api/session', { method: 'POST' });
    sessionId = data.sessionId;
    localStorage.setItem('mobide-session', sessionId);
  }
}

async function loadFiles() {
  const params = new URLSearchParams({ sessionId, path: currentPath });
  if (filesSearch.value) {
    params.set('search', filesSearch.value);
  }
  const data = await apiRequest(`/api/files?${params.toString()}`);
  fileList.innerHTML = '';
  data.entries.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    const name = document.createElement('span');
    name.textContent = entry.name;
    li.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    if (entry.type === 'dir') {
      const openButton = document.createElement('button');
      openButton.textContent = 'Open';
      openButton.addEventListener('click', () => {
        currentPath = joinPath(currentPath, entry.name);
        loadFiles();
      });
      actions.appendChild(openButton);
    } else {
      const editButton = document.createElement('button');
      editButton.textContent = 'Edit';
      editButton.addEventListener('click', () => openEditor(joinPath(currentPath, entry.name)));
      actions.appendChild(editButton);
    }

    const renameButton = document.createElement('button');
    renameButton.textContent = 'Rename';
    renameButton.addEventListener('click', () => renameEntry(joinPath(currentPath, entry.name)));
    actions.appendChild(renameButton);

    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => deleteEntry(joinPath(currentPath, entry.name)));
    actions.appendChild(deleteButton);

    li.appendChild(actions);
    fileList.appendChild(li);
  });
}

function joinPath(base, name) {
  if (!base) {
    return name;
  }
  return `${base}/${name}`;
}

async function openEditor(path) {
  const params = new URLSearchParams({ sessionId, path });
  const data = await apiRequest(`/api/files/read?${params.toString()}`);
  editorPath.textContent = path;
  editorTextarea.value = data.content;
  editorOverlay.classList.remove('hidden');
  editorTextarea.focus();
}

async function saveEditor() {
  await apiRequest('/api/files/write', {
    method: 'POST',
    body: JSON.stringify({ sessionId, path: editorPath.textContent, content: editorTextarea.value })
  });
  editorOverlay.classList.add('hidden');
  loadFiles();
}

function closeEditor() {
  editorOverlay.classList.add('hidden');
}

async function createEntry(type) {
  const name = prompt(`Name for new ${type === 'dir' ? 'folder' : 'file'}`);
  if (!name) {
    return;
  }
  const targetPath = joinPath(currentPath, name);
  await apiRequest('/api/files/create', {
    method: 'POST',
    body: JSON.stringify({ sessionId, path: targetPath, type })
  });
  loadFiles();
}

async function deleteEntry(path) {
  if (!confirm(`Delete ${path}?`)) {
    return;
  }
  await apiRequest('/api/files/delete', {
    method: 'POST',
    body: JSON.stringify({ sessionId, path })
  });
  loadFiles();
}

async function renameEntry(path) {
  const newName = prompt('New name', path.split('/').pop());
  if (!newName) {
    return;
  }
  const base = path.split('/').slice(0, -1).join('/');
  const newPath = base ? `${base}/${newName}` : newName;
  await apiRequest('/api/files/rename', {
    method: 'POST',
    body: JSON.stringify({ sessionId, oldPath: path, newPath })
  });
  loadFiles();
}

function updateAuthPanel() {
  authUrl.textContent = lastAuth.url || '—';
  authCode.textContent = lastAuth.code || '—';
}

function copyText(value) {
  if (!value) {
    return;
  }
  const legacyCopy = () => {
    console.warn('Clipboard API unavailable, using deprecated fallback.');
    const temp = document.createElement('textarea');
    temp.value = value;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    temp.remove();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).catch(legacyCopy);
  } else {
    legacyCopy();
  }
}

let socket;

async function init() {
  await ensureSession();

  socket = io({ auth: { sessionId } });
  socket.on('output', (data) => term.write(data));
  socket.on('auth-state', (data) => {
    lastAuth = { ...lastAuth, ...data };
    updateAuthPanel();
  });
  socket.on('auth-detected', ({ type, value }) => {
    if (type === 'url') {
      lastAuth.url = value;
    }
    if (type === 'code') {
      lastAuth.code = value;
    }
    updateAuthPanel();
  });
  socket.on('connect', () => fitTerminal());

  term.onData((data) => socket.emit('input', data));

  await loadFiles();
  updateAuthPanel();
  setAppHeight();
  term.focus();
}

window.addEventListener('resize', setAppHeight);
window.visualViewport?.addEventListener('resize', setAppHeight);

filesSearch.addEventListener('input', () => loadFiles());
document.getElementById('files-up').addEventListener('click', () => {
  if (!currentPath) {
    return;
  }
  currentPath = currentPath.split('/').slice(0, -1).join('/');
  loadFiles();
});

document.getElementById('new-file').addEventListener('click', () => createEntry('file'));
document.getElementById('new-folder').addEventListener('click', () => createEntry('dir'));

document.getElementById('editor-save').addEventListener('click', saveEditor);
document.getElementById('editor-close').addEventListener('click', closeEditor);

const navButtons = document.querySelectorAll('#bottom-nav button');
navButtons.forEach((button) => {
  button.addEventListener('click', () => {
    navButtons.forEach((btn) => btn.classList.remove('active'));
    button.classList.add('active');
    document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
    document.getElementById(`${button.dataset.view}-view`).classList.add('active');
    if (button.dataset.view === 'terminal') {
      setTimeout(() => {
        fitTerminal();
        term.focus();
      }, 0);
    }
  });
});

const ctrlButton = document.getElementById('ctrl-toggle');
ctrlButton.addEventListener('click', () => {
  ctrlActive = !ctrlActive;
  ctrlButton.classList.toggle('active', ctrlActive);
});

document.getElementById('accessory-bar').addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target || !target.dataset.seq) {
    return;
  }
  const seq = target.dataset.seq;
  const controlSequences = {
    esc: '\u001b',
    tab: '\t',
    up: '\u001b[A',
    down: '\u001b[B',
    right: '\u001b[C',
    left: '\u001b[D'
  };
  let payload = controlSequences[seq] || '';
  if (ctrlActive && ['up', 'down', 'left', 'right'].includes(seq)) {
    const ctrlMap = {
      up: '\u001b[1;5A',
      down: '\u001b[1;5B',
      right: '\u001b[1;5C',
      left: '\u001b[1;5D'
    };
    payload = ctrlMap[seq];
  }
  if (payload) {
    socket.emit('input', payload);
  }
  if (ctrlActive) {
    ctrlActive = false;
    ctrlButton.classList.remove('active');
  }
});

document.getElementById('auth-open').addEventListener('click', () => {
  if (lastAuth.url) {
    window.open(lastAuth.url, '_blank');
  }
});

document.getElementById('auth-copy-url').addEventListener('click', () => copyText(lastAuth.url));
document.getElementById('auth-copy-code').addEventListener('click', () => copyText(lastAuth.code));

init().catch((error) => {
  console.error(error);
});
