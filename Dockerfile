FROM oven/bun:1
WORKDIR /app
COPY mini-services ./mini-services
COPY src ./src
RUN cd mini-services/game-server && bun install --production
ENV SNAPSHOT_DIR=/data
RUN mkdir -p /data
EXPOSE 3003
CMD ["bun", "index.ts"]
