FROM node:26.13.0-bookworm-slim
WORKDIR /app
COPY --chown=node:node server.mjs ./
COPY --chown=node:node dist/ ./dist/
USER node
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
