# OpenRMM server image.
# Build:  docker build -t openrmm .
# Run:    docker run -p 8787:8787 -v openrmm-data:/app/data -e RMM_ADMIN_PASSWORD=... openrmm
# Persistent data lives in /app/data — mount a volume there (Docker -v,
# docker-compose volume, or a Railway Volume at /app/data).

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/agent/package.json packages/agent/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm ci
COPY packages ./packages
COPY LICENSE ./
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/agent/package.json packages/agent/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/dashboard/dist packages/dashboard/dist
# The installer builder bundles the agent at request time from source.
COPY --from=build /app/packages/agent/src packages/agent/src
COPY --from=build /app/packages/agent/vendor packages/agent/vendor
COPY --from=build /app/LICENSE LICENSE
EXPOSE 8787
CMD ["node", "packages/server/dist/index.js"]
