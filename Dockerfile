# ============================================================
# snipping_bot - image de production
# Build TS -> image runtime minimale avec dépendances prod only.
# Les secrets (.env) ne sont JAMAIS inclus dans l'image :
# ils sont chargés au démarrage via env_file (docker-compose).
# ============================================================

# --- Étape 1 : dépendances complètes + compilation ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Étape 2 : image runtime ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Les fichiers logs/bot-*.json persistent dans ce volume.
VOLUME ["/app/logs"]

# SIGTERM (docker stop) -> arrêt propre du bot via son handler.
CMD ["node", "dist/index.js"]
