# ---- build stage ----
FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# ---- relay target ----
FROM node:22-slim AS relay

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && \
    rm -rf /var/lib/apt/lists/* && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -f http://localhost:3200/ || exit 1

CMD ["node", "dist/index.js"]

# ---- claude target ----
FROM node:22-slim AS claude

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl sudo && \
    rm -rf /var/lib/apt/lists/* && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

RUN npm install -g @anthropic-ai/claude-code

# Create non-root user with passwordless sudo
# (--dangerously-skip-permissions requires non-root; sudo needed for installing packages)
RUN useradd -m -s /bin/bash claude && \
    echo "claude ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/claude

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/

USER claude

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3100/health || exit 1

CMD ["node", "dist/bridge-main.js"]
