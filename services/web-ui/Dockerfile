# Set Node.js version
ARG NODE_VERSION=24

# Stage 1: Build
FROM node:${NODE_VERSION}-alpine AS builder

# Install necessary build tools for building native dependencies
# RUN apk add --update --no-cache python3 make g++ cmake

# Install pnpm globally
RUN npm install -g pnpm@12.3.4

# Set the working directory
WORKDIR /usr/src/service

# Copy the rest of app's source code
COPY ./services/web-ui/ .
COPY ./packages/lixpi/capability-system ./packages/lixpi/capability-system
COPY ./packages/lixpi/canvas-engine ./packages/lixpi/canvas-engine
COPY ./packages/lixpi/canvas-components ./packages/lixpi/canvas-components
COPY ./packages/lixpi/canvas-components-lixpi-specific ./packages/lixpi/canvas-components-lixpi-specific
COPY ./packages/lixpi/constants ./packages/lixpi/constants
COPY ./packages/lixpi/nats-service ./packages/lixpi/nats-service
COPY ./packages/lixpi/debug-tools ./packages/lixpi/debug-tools
COPY ./packages/lixpi/prosemirror ./packages/lixpi/prosemirror
COPY ./packages/lixpi/test-utils ./packages/lixpi/test-utils
COPY ./packages/lixpi/ui-kit ./packages/lixpi/ui-kit
COPY ./packages/lixpi/ui-primitives ./packages/lixpi/ui-primitives
COPY ./packages/lixpi/auth-client ./packages/lixpi/auth-client
COPY ./packages/lixpi/web-client-service-factory ./packages/lixpi/web-client-service-factory
COPY ./services/web-ui/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Install dependencies, redundant when running locally because starting service each time will install deps, but needed for deployment
RUN pnpm install --force && pnpm store prune && rm -rf ~/.pnpm-store


# Stage two -----------------------------------------------------------------------


# Stage 2: Runtime
FROM node:${NODE_VERSION}-alpine

# Install necessary packages
RUN apk add --update --no-cache curl rsync

# Install pnpm globally (in the runtime stage)
RUN npm install -g pnpm@12.3.4

# Set the working directory
WORKDIR /usr/src/service

# Copy from builder stage the necessary files
COPY --from=builder /usr/src/service .

# Dev-loop package sync (see scripts/docker/workspace-package-sync.sh). Inert in
# deployed images, where there is no host mount to sync from.
COPY scripts/docker/workspace-package-sync.sh /usr/local/bin/workspace-package-sync.sh
RUN chmod +x /usr/local/bin/workspace-package-sync.sh

# Expose the port the app runs on
EXPOSE 3000

# Run the application
CMD ["pnpm", "run", "serve"]
