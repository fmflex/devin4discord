FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data

CMD ["node", "src/index.ts"]
