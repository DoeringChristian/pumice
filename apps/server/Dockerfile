# Pumice collaboration server — single image, data in /data (mount a volume).
FROM node:24-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build -w @pumice/server
ENV PUMICE_DATA=/data PORT=8787 HOST=0.0.0.0 NODE_ENV=production
VOLUME /data
EXPOSE 8787
WORKDIR /app/apps/server
CMD ["node", "dist/main.js"]
