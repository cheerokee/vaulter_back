# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
WORKDIR /app
RUN chown node:node /app
USER node

# Dependências completas (dev + prod)
FROM base AS deps
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

# Desenvolvimento: código montado via volume, API em modo watch
FROM deps AS development
ENV NODE_ENV=development
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# Build da aplicação
FROM deps AS build
COPY --chown=node:node . .
RUN npm run build

# Produção: só dependências de runtime + dist
FROM base AS production
ENV NODE_ENV=production
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
