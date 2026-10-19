FROM node:24.19.0-bookworm-slim
WORKDIR /app/beta
COPY beta/package.json beta/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY beta/server.mjs beta/policy.mjs beta/security.mjs beta/ledger.mjs beta/engine.mjs beta/provider.mjs beta/fake-provider.mjs beta/operator.mjs ./
COPY beta/migrations ./migrations
COPY beta/public ./public
COPY src/models.js src/data.js src/styles.css /app/src/
COPY lib/benchmark.mjs lib/provider.mjs lib/errors.mjs /app/lib/
COPY public/favicon.svg /app/public/
ENV NODE_ENV=production
USER node
EXPOSE 5174
CMD ["node", "server.mjs"]
