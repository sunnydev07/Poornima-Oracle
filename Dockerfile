# Poornima Oracle backend — Google Cloud Run
FROM node:22-slim

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Cloud Run injects PORT automatically; default for local dev
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

# Health check: Cloud Run hits GET /api/health
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/api/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })" || exit 1

CMD ["npm", "start"]
