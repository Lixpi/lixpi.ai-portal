# Use the official Pulumi image as the base
FROM pulumi/pulumi:latest

# Set Node.js version
ARG NODE_VERSION=24.20.0

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Set bash as the default shell
SHELL ["/bin/bash", "-c"]

# Make /bin/sh point to bash
RUN rm /bin/sh && ln -s /bin/bash /bin/sh

# Install fnm (Fast Node Manager)
RUN curl -fsSL https://fnm.vercel.app/install | bash

# Set up fnm in the shell
ENV PATH="/root/.local/share/fnm:$PATH"

# Install and use Node.js
RUN eval "$(fnm env)" && \
    fnm install $NODE_VERSION && \
    fnm default $NODE_VERSION && \
    fnm use $NODE_VERSION

# Activate the repository's pnpm version in the Node installation managed by fnm.
RUN eval "$(fnm env)" && \
    corepack enable && \
    corepack prepare pnpm@12.3.4 --activate

# Add fnm initialization to .bashrc to ensure it's available in all bash sessions
RUN echo 'eval "$(fnm env)"' >> ~/.bashrc
# Also add to /etc/profile for any login shell
RUN echo 'eval "$(fnm env)"' >> /etc/profile

# Copy the rest of app's source code
COPY ./infrastructure /usr/src/service/infrastructure
COPY ./packages /usr/src/service/packages
COPY ./services /usr/src/service/services

# Set the working directory
WORKDIR /usr/src/service/infrastructure/pulumi

# Install dependencies, redundant when running locally because starting service each time will install deps, but needed for deployment
RUN eval "$(fnm env)" && \
    pnpm install --force && pnpm store prune && rm -rf ~/.pnpm-store

# Set entrypoint to use bash with fnm initialized
ENTRYPOINT ["/bin/bash", "-c"]
CMD ["eval \"$(fnm env)\" && pulumi"]
