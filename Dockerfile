# Stage 1 : Build TypeScript + prune des dépendances dev
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# Stage 2 : Image de production (pas de npm requis)
FROM node:20-alpine
WORKDIR /app

# Copie node_modules purgés et le build compilé depuis le stage builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Utilisateur non-root
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup
USER appuser

EXPOSE 3000

# Healthcheck via node (wget absent dans Alpine minimal)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => \
  r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
