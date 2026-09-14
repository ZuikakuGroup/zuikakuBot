FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ pkg-config libopus-dev && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libopus0 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
