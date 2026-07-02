FROM node:24-slim AS deps

WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
COPY media-server/package.json media-server/package.json
COPY shared/package.json shared/package.json

RUN npm ci

FROM deps AS dev

WORKDIR /app
EXPOSE 5173 3001 3002

CMD ["npm", "run", "dev"]

FROM deps AS build

WORKDIR /app
COPY . .
RUN npm run build --workspaces

FROM node:24-slim AS server

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json
RUN npm ci --omit=dev --workspace=server --workspace=shared --include-workspace-root=false

COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist

EXPOSE 3001
CMD ["npm", "run", "start", "--workspace=server"]

FROM node:24-slim AS media-server

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-impress \
    poppler-utils \
    fonts-dejavu \
    fonts-liberation \
    fontconfig \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY media-server/package.json media-server/package.json
COPY shared/package.json shared/package.json
RUN npm ci --omit=dev --workspace=media-server --workspace=shared --include-workspace-root=false

COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/media-server/dist media-server/dist

EXPOSE 3002
CMD ["npm", "run", "start", "--workspace=media-server"]
