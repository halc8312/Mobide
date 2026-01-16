# Mobide

Minimal MVP for a mobile-first vertical IDE with per-session Docker workspaces.

## Requirements

- Node.js 20+
- Docker (for terminal containers)

## Setup

1. Build the CLI image used for each session:

```bash
docker build -t mobide-cli -f Dockerfile.cli .
```

2. Install dependencies and start the server:

```bash
npm install
npm start
```

3. Open `http://localhost:3000` on a mobile-sized viewport.

If your environment does not allow writing to `/workspaces`, set `WORKSPACES_ROOT=./workspaces` before starting the server.

### Docker Compose

```bash
docker compose up
```

Build the `mobide-cli` image first so the server can start session containers.

## MVP Notes

- Sessions are created via `POST /api/session` and stored under `/workspaces/<sessionId>`.
- File operations are exposed via `/api/files*` endpoints and are restricted to each session workspace.
- Terminal access is provided through Socket.IO and Docker containers are stopped after 30 minutes of inactivity.

### Environment Overrides

- `IDLE_TIMEOUT_MS`: override idle timeout for sessions (defaults to 30 minutes).
- `CLI_IMAGE`: override the Docker image used for terminal sessions.
- `CLI_USER`: override the user used inside the CLI container.
- `DEVICE_CODE_REGEX`: override the device code detection regex.
- `WORKSPACES_ROOT`: override the host workspace root (defaults to `/workspaces`).
