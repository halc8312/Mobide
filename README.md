# Mobide

Minimal MVP for a mobile-first vertical IDE with per-session Docker workspaces.

## Requirements

- Node.js 20+
- Docker (for terminal containers)

## Setup

1. Build (or pull) the CLI image used for each session:

```bash
docker build -t mobide-cli -f Dockerfile.cli .
```

If you prefer to pull a prebuilt image from a registry, set `CLI_IMAGE` to that image and
`CLI_IMAGE_PULL=true` so the server can pull it on demand.

2. Install dependencies and start the server:

```bash
npm install
npm start
```

3. Open `http://localhost:3000` on a mobile-sized viewport.

If your environment does not allow writing to `/workspaces`, set `DATA_DIR=./workspaces` (or
`WORKSPACES_ROOT` / `STORAGE_PATH`) before starting the server.

### Docker Compose

```bash
docker compose build mobide-cli
docker compose up
```

The `mobide-cli` image is defined in the compose file so the host can build it once.

## MVP Notes

- Sessions are created via `POST /api/session` and stored under `/workspaces/<sessionId>`.
- File operations are exposed via `/api/files*` endpoints and are restricted to each session workspace.
- Terminal access is provided through Socket.IO and Docker containers are stopped after 30 minutes of inactivity.

### Environment Overrides

- `IDLE_TIMEOUT_MS`: override idle timeout for sessions (defaults to 30 minutes).
- `CLI_IMAGE`: override the Docker image used for terminal sessions.
- `CLI_IMAGE_PULL`: set to `true` to pull the CLI image if it is missing.
- `CLI_USER`: override the user used inside the CLI container.
- `DEVICE_CODE_REGEX`: override the device code detection regex.
- `DOCKER_SOCKET_PATH`: override the Docker socket path (defaults to `/var/run/docker.sock`).
- `WORKSPACES_ROOT`, `DATA_DIR`, `STORAGE_PATH`: override the host workspace root (defaults to `/workspaces`).
