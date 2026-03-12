FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV DB_PATH=/app/data/serena.db

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 4000

CMD ["npm", "start"]
