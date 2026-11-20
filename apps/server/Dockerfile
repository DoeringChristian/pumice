# Pumice collaboration server — single image, data in /data (mount a volume).
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --filter @pumice/server... --frozen-lockfile --prod
ENV PUMICE_DATA=/data PORT=8787 HOST=0.0.0.0 NODE_ENV=production
VOLUME /data
EXPOSE 8787
WORKDIR /app/apps/server
CMD ["node", "--experimental-strip-types", "src/main.ts"]
