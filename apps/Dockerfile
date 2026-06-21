ARG NODE_IMAGE_TAG=24

FROM node:${NODE_IMAGE_TAG}-alpine AS runner
ARG APP_NAME
ARG PORT
ENV NODE_ENV=production
ENV PORT=${PORT}
ENV APP_NAME=${APP_NAME}
WORKDIR /app

COPY apps/${APP_NAME}/.next/standalone ./
COPY apps/${APP_NAME}/.next/static ./apps/${APP_NAME}/.next/static

EXPOSE ${PORT}
CMD ["sh", "-c", "node apps/${APP_NAME}/server.js"]
