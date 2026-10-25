FROM mcr.microsoft.com/playwright:v1.64.0-noble

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/roadnote.sqlite
ENV PAYTAG_BROWSER_TIMEOUT_MS=25000

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
