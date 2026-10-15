# Сборка клиента (vite) с проверкой типов
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Боевой образ: Node сам исполняет server/*.ts (type stripping),
# сервер использует только свои модули и src/core — node_modules не нужны
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json ./
COPY server ./server
COPY src ./src
COPY public ./public
COPY --from=build /app/dist ./dist
RUN mkdir data && chown node:node data
USER node
EXPOSE 8787
# sha коммита → /api/health; в конце, чтобы не сбрасывать кэш слоёв выше
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
CMD ["node", "server/index.ts"]
