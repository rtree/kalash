FROM node:26.13.0-bookworm-slim
WORKDIR /app
COPY scripts/bootstrap-pnpm.mjs scripts/bootstrap-pnpm.mjs
RUN node scripts/bootstrap-pnpm.mjs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version dependency-releases.json ./
COPY scripts/check-policy.mjs scripts/check-policy.mjs
RUN node scripts/check-policy.mjs && pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN node scripts/check-policy.mjs && pnpm exec tsc --noEmit && node --test tests/policy.test.mjs tests/shared.test.ts tests/donation-receipt.test.ts && node scripts/build.mjs
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "node scripts/check-policy.mjs && exec node src/server/main.ts"]
