# Runway backend: Fastify API plus the internal eve agent on loopback. Needs Node >= 24 (node:sqlite).
FROM node:24-slim
WORKDIR /app

# tsx (the runtime) and the eve build tooling are devDependencies, so install them explicitly.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
# Build the agent once at image build time. It needs no keys (they are read when the agent starts),
# and building here keeps boot fast: the runtime build blocks the event loop, which would stall
# health checks while it runs.
RUN ./node_modules/.bin/eve build --skip-sandbox-prewarm

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000 RUNWAY_SKIP_AGENT_BUILD=1
EXPOSE 8000
# Same as `npm start`, but run directly so SIGTERM reaches the server for a clean shutdown.
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
