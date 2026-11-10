FROM node:22-alpine
WORKDIR /app
ARG APP_VERSION=1
ARG BROKEN=false
COPY package.json server.mjs ./
RUN echo "{\"version\":\"${APP_VERSION}\",\"broken\":${BROKEN}}" > version.json
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
