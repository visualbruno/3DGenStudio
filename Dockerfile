# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: Build & Compile Native Addons
# ──────────────────────────────────────────────────────────────────────────────
FROM docker.io/library/node:20-alpine AS builder

WORKDIR /build

# Install build tools required for compiling native C/C++ node modules
RUN apk add --no-cache python3 make g++ gcc libc-dev

# Copy manifests first to optimize Docker layer caching
COPY package*.json ./

# Install ALL dependencies (including devDependencies like Vite)
RUN npm ci --include=dev --build-from-source

# Copy the rest of the application source code
COPY . .

# Run your frontend production build step step
RUN npm run build


# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: Final Runtime (Retaining Dev Deps for Debugging)
# ──────────────────────────────────────────────────────────────────────────────
FROM docker.io/library/node:20-alpine AS runner

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

# Install final runtime system utilities
RUN apk add --no-cache \
    ca-certificates \
    ffmpeg \
    sqlite-dev \
    supervisor \
    bash  # Added bash to make exec/debugging inside the container much nicer

WORKDIR /app

# Ensure persistent directories exist
RUN mkdir -p \
    /app/data \
    /app/output \
    /app/models \
    /app/cache \
    /var/log/supervisor

# Copy your source repository structure
COPY . /app/

# Bring over the unpruned node_modules, binaries, and production build assets
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/dist /app/dist

# Ensure supervisor can find the configuration
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 3000 9001

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/supervisord.conf"]