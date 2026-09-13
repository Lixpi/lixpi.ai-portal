# Set Node.js version
ARG NODE_VERSION=24

# Stage 1: Build
FROM node:${NODE_VERSION}-alpine AS builder

# Install pnpm globally
RUN npm install -g pnpm@12.3.4

# Set the working directory
WORKDIR /usr/src/service

# Copy the rest of app's source code
COPY ./services/ai-model-registry/package.json ./package.json
COPY ./services/ai-model-registry/vite.config.ts ./vite.config.ts
COPY ./services/ai-model-registry/src ./src
COPY ./packages/lixpi/constants ./packages/lixpi/constants
COPY ./packages/lixpi/debug-tools ./packages/lixpi/debug-tools
COPY ./packages/lixpi/dynamodb-service ./packages/lixpi/dynamodb-service
COPY ./packages/lixpi/nats-service ./packages/lixpi/nats-service
COPY ./packages/lixpi/ui-kit-gentelella ./packages/lixpi/ui-kit-gentelella
COPY ./packages/lixpi/ui-primitives ./packages/lixpi/ui-primitives
COPY ./packages/lixpi/usage-reporter ./packages/lixpi/usage-reporter
COPY ./packages/lixpi/web-client-service-factory ./packages/lixpi/web-client-service-factory
COPY ./services/ai-model-registry/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Install dependencies, redundant when running locally because starting service each time will install deps, but needed for deployment
RUN pnpm install --force && pnpm store prune && rm -rf ~/.pnpm-store


# Stage two -----------------------------------------------------------------------


# Stage 2: Runtime
FROM node:${NODE_VERSION}-alpine

# Registry maintenance commands run inside this container. Keep curl and jq
# available so agents never depend on host tools to read, update, or validate it.
RUN apk add --update --no-cache curl jq rsync

# Install pnpm globally (in the runtime stage)
RUN npm install -g pnpm@12.3.4

# Set the working directory
WORKDIR /usr/src/service

# Copy from builder stage the necessary files
COPY --from=builder /usr/src/service .

# The parameter tree and the model catalog. docker compose mounts the host
# directory over this in development; a deployed image carries the committed tree,
# which is what the catalog sync reads in production.
COPY ./services/ai-model-registry/data ./data

# Dev-loop package sync (see scripts/docker/workspace-package-sync.sh). Inert in
# deployed images, where there is no host mount to sync from.
COPY scripts/docker/workspace-package-sync.sh /usr/local/bin/workspace-package-sync.sh
RUN chmod +x /usr/local/bin/workspace-package-sync.sh

# Expose the port the app runs on
EXPOSE 3010

# Run the application
CMD ["pnpm", "run", "build-and-serve"]
