ARG NODE_IMAGE_TAG=24

FROM node:${NODE_IMAGE_TAG}-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3002
WORKDIR /app

COPY apps/payments/.next/standalone ./
COPY apps/payments/.next/static ./apps/payments/.next/static

EXPOSE 3002
CMD ["node", "apps/payments/server.js"]
