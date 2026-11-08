FROM oven/bun:1
WORKDIR /app/mini-services/game-server
COPY mini-services/game-server/index.ts .
COPY mini-services/game-server/package.json .
COPY src /app/src
RUN bun install --production
ENV SNAPSHOT_DIR=/data
RUN mkdir -p /data
EXPOSE 3003
CMD ["bun", "index.ts"]
