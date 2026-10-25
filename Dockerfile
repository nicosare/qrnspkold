FROM node:20-alpine

RUN apk add --no-cache python3 make g++
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/roadnote.sqlite

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
