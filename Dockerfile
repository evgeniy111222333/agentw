FROM mcr.microsoft.com/playwright:v1.60.0-noble AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig*.json jest.config.js ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.60.0-noble AS runtime

ENV NODE_ENV=production
ENV PRISM_PORT=3001
ENV LLM_BROWSER_PORT=3001

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER pwuser
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PRISM_PORT || process.env.LLM_BROWSER_PORT || 3001) + '/api/v2/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
