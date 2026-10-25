FROM node:20-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 compiles its native addon during npm install.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Runtime includes only Chromium (not Playwright's full Chromium + Firefox + WebKit image).
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

COPY --from=build /app /app

# Install the OS libraries required by Playwright and its matching Chromium only.
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/roadnote.sqlite
ENV PAYTAG_BROWSER_TIMEOUT_MS=25000

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
