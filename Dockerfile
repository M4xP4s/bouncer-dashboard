# One image: the API, which also serves the built dashboard.

# Build stage: every dependency, both applications compiled.
FROM node:26-alpine AS build
WORKDIR /app
# Manifests first, so the dependency layer is rebuilt only when they change.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci
COPY . .
RUN npm run build

# Run stage: the API's runtime dependencies and the two build outputs only.
FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --omit=dev --workspace=apps/api
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
# The image's unprivileged user; the process writes nothing.
USER node
EXPOSE 3000
# Node directly, not npm, so that SIGTERM reaches the process and
# `docker compose down` shuts it down cleanly.
CMD ["node", "apps/api/dist/main.js"]
