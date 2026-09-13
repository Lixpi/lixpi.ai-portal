ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS builder

RUN npm install -g pnpm@12.3.4

WORKDIR /usr/src/service

COPY ./services/web-ui-user-portal/ .
COPY ./packages/lixpi/constants ./packages/lixpi/constants
COPY ./packages/lixpi/debug-tools ./packages/lixpi/debug-tools
COPY ./packages/lixpi/nats-service ./packages/lixpi/nats-service
COPY ./packages/lixpi/ui-kit-gentelella ./packages/lixpi/ui-kit-gentelella
COPY ./packages/lixpi/ui-primitives ./packages/lixpi/ui-primitives
COPY ./packages/lixpi/auth-client ./packages/lixpi/auth-client
COPY ./packages/lixpi/web-client-service-factory ./packages/lixpi/web-client-service-factory
COPY ./services/web-ui-user-portal/pnpm-workspace.yaml ./pnpm-workspace.yaml

RUN pnpm install --force && pnpm store prune && rm -rf ~/.pnpm-store

FROM node:${NODE_VERSION}-alpine

RUN apk add --update --no-cache curl rsync
RUN npm install -g pnpm@12.3.4

WORKDIR /usr/src/service

COPY --from=builder /usr/src/service .
COPY scripts/docker/workspace-package-sync.sh /usr/local/bin/workspace-package-sync.sh
RUN chmod +x /usr/local/bin/workspace-package-sync.sh

EXPOSE 3000

CMD ["pnpm", "run", "serve"]
