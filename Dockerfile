FROM node:20-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 compiles its native addon during npm install.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

COPY --from=build /app /app


ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/qride.sqlite
ENV PAYTAG_DIRECT_TIMEOUT_MS=12000

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
