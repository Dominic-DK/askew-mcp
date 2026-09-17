# Askew connector — builds from source. Used by directory sandboxes (Glama) and for a reproducible image.
# Run: docker run -i -e ASKEW_CONNECTOR_KEY=akc_… -v askew-key:/root/.askew askew-mcp
FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
RUN npm install -g pnpm@11 && pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod
ENTRYPOINT ["node", "dist/cli.js"]
