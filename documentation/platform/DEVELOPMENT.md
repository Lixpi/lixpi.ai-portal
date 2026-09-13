---
title: Development Guide
description: Local development quick start for Lixpi — environment setup, infrastructure init, running services, local auth, and Pulumi.
---

# Development Guide

This guide gets Lixpi running locally. Everything runs in **Docker** via `docker-compose` — you do not install Node, pnpm, or Pulumi on the host. For what each service is and how they fit together, see [System Architecture](./SYSTEM-ARCHITECTURE.md); for AWS deployment, see [Infrastructure Overview](./deployment/INFRASTRUCTURE-OVERVIEW.md).

## Services at a glance

| Service | Path | Purpose |
|---------|------|---------|
| **web-ui** | `services/web-ui/` | TypeScript SPA — canvas, ProseMirror editors, AI chat UI |
| **web-ui-user-portal** | `services/web-ui-user-portal/` | TypeScript account-management SPA with Gentelella UI on `http://localhost:3002` |
| **api** | `services/api/` | Node.js / TypeScript gateway — auth, CRUD, DynamoDB, plus the in-process LangGraph LLM workflow (pipeline events, ProseMirror transcript steps, image generation, video generation) |
| **nats** | `services/nats/` | NATS message bus (3-node cluster) |
| **localauth0** | `services/localauth0/` | Mock Auth0 for zero-config offline dev (Rust — vendored `primait/localauth0` image) |
| **ai-model-registry** | `services/ai-model-registry/` | Development-only provider model and parameter registry; all administration runs inside `lixpi-ai-model-registry` |

See [System Architecture](./SYSTEM-ARCHITECTURE.md) for the full service responsibilities and the NATS backbone, and [Authentication](./AUTHENTICATION.md) for the auth model.

The [AI Model Registry](../../services/ai-model-registry/documentation/AI-MODEL-REGISTRY.md) defines the mandatory synchronization contract for provider model and parameter changes. Its registry API and maintenance tools run only inside the registry container.

## Quick Start

### 1. Environment setup

Run the interactive setup wizard to generate your `.env` file:

```bash
# macOS / Linux
./init-config.sh

# Windows
init-config.bat
```

For CI/automation (non-interactive), see [`infrastructure/init-script/README.md`](../../infrastructure/init-script/README.md).

### 2. Point Docker Compose at your environment file

The wizard above writes `.env.<stage-name>` (e.g. `.env.shelby-local`), not a plain `.env` — and Docker Compose only auto-loads a file literally named `.env`. Without one, every `docker compose` command in this repo needs `--env-file .env.<stage-name>` typed out explicitly, or every variable in `docker-compose.yml` comes back unset with a wall of `variable is not set` warnings.

Run the picker once to symlink `.env` to your chosen file — after that, every command below works with no `--env-file` flag needed:

```bash
# macOS / Linux
./set-env.sh

# Windows
set-env.bat
```

Safe to re-run whenever you want to switch environments; it only ever replaces a symlink it created itself, never a real file.

The generated local environment sets `METRICS_ENABLED=false`. Enable it only when the deployed stack includes a responder for `metrics.usage.check`; otherwise the API rejects generation before it calls a model.

### 3. Initialize infrastructure

Set up TLS certificates and DynamoDB tables. This is required before starting the application for the first time:

```bash
# macOS / Linux
./init-infrastructure.sh

# Windows (run as Administrator for certificate installation)
init-infrastructure.bat
```

This script will:

- Start Caddy to generate TLS certificates.
- Extract and install the CA certificate into your system's trust store.
- Initialize DynamoDB tables using Pulumi.

### 4. Start the application

Run the startup script and select an environment when prompted:

```bash
# macOS / Linux
./start.sh

# Windows
start.bat
```

## Build and run individual services

### Web UI

```shell
# Remove all previous builds (including dangling images) and force a re-build
./rebuild-containers.sh lixpi-web-ui

# Then run the single service
docker compose up lixpi-web-ui   # requires .env set (./set-env.sh); override with --env-file otherwise
```

### User portal

```shell
./rebuild-containers.sh lixpi-web-ui-user-portal
docker compose up lixpi-web-ui-user-portal
```

The portal is served at `http://localhost:3002`. `VITE_USER_PORTAL_URL` supplies its distinct OAuth redirect URI while it continues to use the same identity-provider tenant, client ID, and API audience as `web-ui`.

### API

```shell
# Remove all previous builds (including dangling images) and force a re-build
./rebuild-containers.sh lixpi-api

# Then run the single service
docker compose up lixpi-api   # requires .env set (./set-env.sh); override with --env-file otherwise
```

{% callout type="note" %}
Some dependencies are baked into a service's image at build time (for example, the `ffmpeg` binary in the `api` image used for video poster extraction) rather than bind-mounted. After changing a service's `Dockerfile` or its system/package dependencies, rebuild that container with `./rebuild-containers.sh <name>` — a plain `up` will keep running the stale image.
{% /callout %}

## Deploying to production (Web UI build)

To build the Web UI bundle inside its container:

```shell
docker exec -it lixpi-web-ui pnpm build
```

For the full AWS deployment story (Pulumi, ECS/Fargate, CloudFront, the NATS cluster), see [Infrastructure Overview](./deployment/INFRASTRUCTURE-OVERVIEW.md) and [Scaling & Operations](./deployment/SCALING-AND-OPERATIONS.md).

## Local authentication

LocalAuth0 provides zero-config Auth0 mocking for offline development — it generates RS256 keypairs, issues JWTs matching production Auth0's OAuth flows, and persists state in a Docker volume. No Auth0 account or internet connection is required.

- **Configuration:** set `VITE_MOCK_AUTH=true` in your `.env` file (the default in the local environment).
- **Default user:** `test@local.dev` / `local|test-user-001`.
- **Image / language:** the Rust `public.ecr.aws/primaassicurazioni/localauth0` image (upstream [`primait/localauth0`](https://github.com/primait/localauth0)).

See [`services/localauth0/README.md`](../../services/localauth0/README.md) for endpoints, default claims, and troubleshooting, and [Authentication](./AUTHENTICATION.md) for how it fits the dual-auth model.

## Pulumi (Infrastructure-as-Code)

Pulumi manages the infrastructure, and it runs inside a Docker container — you never run `pulumi` directly on the host.

First, create two S3 buckets for Pulumi state:

- `lixpi-pulumi-<your-name>-local` — for local development
- `lixpi-pulumi-<your-name>-dev` — for dev deployments

To rebuild the Pulumi container from scratch:

```shell
./rebuild-containers.sh lixpi-pulumi
```

To run Pulumi:

```shell
docker compose up lixpi-pulumi   # requires .env set (./set-env.sh); override with --env-file otherwise
```

For how the Pulumi program is structured and the full set of commands (`up`, `preview`, `destroy`, …), see [Infrastructure Overview](./deployment/INFRASTRUCTURE-OVERVIEW.md).
