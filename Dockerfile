FROM node:24-alpine

WORKDIR /app

# Copy workspace manifests first so dependency installation remains cacheable.
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN npm ci \
    --workspace @cravelens/server \
    --workspace @cravelens/shared \
    --include-workspace-root=false

COPY apps/server ./apps/server
COPY packages/shared ./packages/shared

RUN npm run build --workspace @cravelens/shared \
    && npm run build --workspace @cravelens/server \
    && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 8787

CMD ["npm", "run", "start", "--workspace", "@cravelens/server"]
