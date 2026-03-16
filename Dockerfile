FROM node:22-slim

RUN apt-get update && apt-get install -y wget --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

ENV TRANSPORT=http
ENV PORT=3000
ENV FLARESOLVERR_URL=http://flaresolverr:8191

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "build/index.js"]
