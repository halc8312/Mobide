const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const Docker = require('dockerode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const WORKSPACES_ROOT = path.resolve(
  process.env.WORKSPACES_ROOT ||
    process.env.DATA_DIR ||
    process.env.STORAGE_PATH ||
    '/workspaces'
);
const CLI_IMAGE = process.env.CLI_IMAGE || 'mobide-cli';
const CLI_IMAGE_PULL = /^(true|1)$/i.test(process.env.CLI_IMAGE_PULL || '');
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 30 * 60 * 1000;
const CLI_USER = process.env.CLI_USER || 'mobide';
const DOCKER_SOCKET_PATH =
  process.env.DOCKER_SOCKET_PATH || process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const URL_REGEX = /https?:\/\/\S+/g;
const CODE_REGEX = new RegExp(
  process.env.DEVICE_CODE_REGEX || '\\b[A-Za-z0-9]{4,6}-[A-Za-z0-9]{4,6}\\b',
  'g'
);
const docker = new Docker({ socketPath: DOCKER_SOCKET_PATH });
let cliImagePromise;
const sessions = new Map();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function ensureWorkspacesRoot() {
  await fs.mkdir(WORKSPACES_ROOT, { recursive: true });
}

async function ensureCliImage() {
  if (!cliImagePromise) {
    cliImagePromise = (async () => {
      try {
        await docker.getImage(CLI_IMAGE).inspect();
        return;
      } catch (error) {
        const message = error?.message || '';
        const isMissingImage =
          error?.statusCode === 404 || /no such image/i.test(message);
        if (!isMissingImage) {
          throw error;
        }
        if (!CLI_IMAGE_PULL) {
          throw new Error(
            `CLI image "${CLI_IMAGE}" not found. Build it or set CLI_IMAGE_PULL=true to pull it.`
          );
        }
        console.log(`Pulling CLI image "${CLI_IMAGE}"...`);
        const stream = await docker.pull(CLI_IMAGE);
        await new Promise((resolve, reject) => {
          let lastStatus;
          docker.modem.followProgress(
            stream,
            (pullError) => {
              if (pullError) {
                reject(pullError);
                return;
              }
              resolve();
            },
            (event) => {
              if (!event?.status) {
                return;
              }
              const label = [event.status, event.id].filter(Boolean).join(' ');
              if (label && label !== lastStatus) {
                lastStatus = label;
                console.log(label);
              }
            }
          );
        });
        console.log(`CLI image "${CLI_IMAGE}" pulled successfully.`);
      }
    })();
  }
  return cliImagePromise;
}

function resolveWorkspacePath(sessionId, targetPath = '') {
  const root = path.resolve(WORKSPACES_ROOT);
  const base = path.resolve(root, sessionId);
  const relativeBase = path.relative(root, base);
  if (!relativeBase || relativeBase.startsWith('..') || path.isAbsolute(relativeBase)) {
    throw new Error('Invalid session');
  }
  const resolved = path.resolve(base, targetPath);
  const relativePath = path.relative(base, resolved);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Invalid path');
  }
  return { base, resolved };
}

async function ensureWorkspace(sessionId) {
  const { base } = resolveWorkspacePath(sessionId);
  await fs.mkdir(base, { recursive: true });
  return base;
}

function updateLastActivity(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivity = Date.now();
  }
}

function emitAuth(session, type, value) {
  for (const socket of session.sockets) {
    socket.emit('auth-detected', { type, value });
  }
}

function detectAuth(sessionId, text) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  const urls = text.match(URL_REGEX);
  if (urls) {
    for (const url of urls) {
      if (session.auth.url !== url) {
        session.auth.url = url;
        emitAuth(session, 'url', url);
      }
    }
  }
  const codes = text.match(CODE_REGEX);
  if (codes) {
    for (const code of codes) {
      if (session.auth.code !== code) {
        session.auth.code = code;
        emitAuth(session, 'code', code);
      }
    }
  }
}

async function stopContainer(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  if (session.stream) {
    try {
      session.stream.end();
    } catch (error) {
      console.warn('Failed to close session stream', error);
    }
  }
  if (session.container) {
    try {
      await session.container.stop({ t: 0 });
    } catch (error) {
      console.warn('Failed to stop container', error);
    }
  }
  sessions.delete(sessionId);
}

async function ensureContainer(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      sockets: new Set(),
      lastActivity: Date.now(),
      auth: { url: null, code: null }
    };
    sessions.set(sessionId, session);
  }
  if (session.container && session.stream) {
    return session;
  }
  await ensureCliImage();
  const workspace = await ensureWorkspace(sessionId);
  const container = await docker.createContainer({
    Image: CLI_IMAGE,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: '/workspace',
    Cmd: ['/bin/bash'],
    User: CLI_USER,
    HostConfig: {
      Binds: [`${workspace}:/workspace`],
      AutoRemove: true
    }
  });
  await container.start();
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true });
  session.container = container;
  session.stream = stream;
  updateLastActivity(sessionId);

  stream.on('data', (data) => {
    const text = data.toString('utf8');
    updateLastActivity(sessionId);
    for (const socket of session.sockets) {
      socket.emit('output', text);
    }
    detectAuth(sessionId, text);
  });

  stream.on('end', () => stopContainer(sessionId));
  stream.on('error', () => stopContainer(sessionId));

  return session;
}

app.post('/api/session', async (req, res) => {
  try {
    const sessionId = crypto.randomUUID();
    await ensureWorkspace(sessionId);
    res.json({ sessionId });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create session' });
  }
});

app.get('/api/files', async (req, res) => {
  const { sessionId, path: targetPath = '', search = '' } = req.query;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }
  try {
    const { resolved } = resolveWorkspacePath(sessionId, targetPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const filtered = entries
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file'
      }))
      .filter((entry) =>
        search
          ? entry.name.toLowerCase().includes(String(search).toLowerCase())
          : true
      );
    res.json({ path: targetPath, entries: filtered });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to list files' });
  }
});

app.get('/api/files/read', async (req, res) => {
  const { sessionId, path: targetPath } = req.query;
  if (!sessionId || !targetPath) {
    return res.status(400).json({ error: 'sessionId and path required' });
  }
  try {
    const { resolved } = resolveWorkspacePath(sessionId, targetPath);
    const content = await fs.readFile(resolved, 'utf8');
    res.json({ content });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to read file' });
  }
});

app.post('/api/files/write', async (req, res) => {
  const { sessionId, path: targetPath, content = '' } = req.body || {};
  if (!sessionId || !targetPath) {
    return res.status(400).json({ error: 'sessionId and path required' });
  }
  try {
    const { resolved } = resolveWorkspacePath(sessionId, targetPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to write file' });
  }
});

app.post('/api/files/create', async (req, res) => {
  const { sessionId, path: targetPath, type } = req.body || {};
  if (!sessionId || !targetPath) {
    return res.status(400).json({ error: 'sessionId and path required' });
  }
  try {
    const { resolved } = resolveWorkspacePath(sessionId, targetPath);
    if (type === 'dir') {
      await fs.mkdir(resolved, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, '', 'utf8');
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to create entry' });
  }
});

app.post('/api/files/delete', async (req, res) => {
  const { sessionId, path: targetPath } = req.body || {};
  if (!sessionId || !targetPath) {
    return res.status(400).json({ error: 'sessionId and path required' });
  }
  try {
    const { base, resolved } = resolveWorkspacePath(sessionId, targetPath);
    if (resolved === base) {
      throw new Error('Refusing to delete workspace root');
    }
    await fs.rm(resolved, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to delete entry' });
  }
});

app.post('/api/files/rename', async (req, res) => {
  const { sessionId, oldPath, newPath } = req.body || {};
  if (!sessionId || !oldPath || !newPath) {
    return res.status(400).json({ error: 'sessionId, oldPath, newPath required' });
  }
  try {
    const { base, resolved: oldResolved } = resolveWorkspacePath(sessionId, oldPath);
    const { resolved: newResolved } = resolveWorkspacePath(sessionId, newPath);
    if (oldResolved === base || newResolved === base) {
      throw new Error('Refusing to rename workspace root');
    }
    await fs.mkdir(path.dirname(newResolved), { recursive: true });
    await fs.rename(oldResolved, newResolved);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to rename entry' });
  }
});

io.on('connection', async (socket) => {
  const sessionId = socket.handshake.auth?.sessionId;
  if (!sessionId) {
    socket.emit('error-message', 'Missing sessionId');
    socket.disconnect(true);
    return;
  }
  try {
    const session = await ensureContainer(sessionId);
    session.sockets.add(socket);
    updateLastActivity(sessionId);
    socket.emit('auth-state', session.auth);

    socket.on('input', (data) => {
      if (session.stream) {
        session.stream.write(data);
        updateLastActivity(sessionId);
      }
    });

    socket.on('resize', async ({ cols, rows }) => {
      if (!session.container || !cols || !rows) {
        return;
      }
      try {
        await session.container.resize({ h: rows, w: cols });
      } catch (error) {
        console.warn('Failed to resize container', error);
      }
    });

    socket.on('disconnect', () => {
      session.sockets.delete(socket);
      updateLastActivity(sessionId);
    });
  } catch (error) {
    socket.emit('error-message', error.message || 'Connection failed');
    socket.disconnect(true);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (session.sockets.size === 0 && now - session.lastActivity > IDLE_TIMEOUT_MS) {
      stopContainer(sessionId);
    }
  }
}, 60 * 1000);

ensureWorkspacesRoot().then(() => {
  server.listen(PORT, () => {
    console.log(`Mobide server running on ${PORT}`);
  });
});
