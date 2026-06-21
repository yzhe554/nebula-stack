ARG NODE_IMAGE_TAG=24

FROM node:${NODE_IMAGE_TAG}-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app

COPY apps/docs/.next/standalone ./
COPY apps/docs/.next/static ./apps/docs/.next/static

EXPOSE 3001
CMD ["node", "apps/docs/server.js"]
