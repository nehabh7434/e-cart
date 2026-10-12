FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY db.js DDL.sql indexes.sql session.sql ./
COPY scripts/init-db.js ./scripts/init-db.js
COPY app.js ./
COPY views ./views

ENV NODE_ENV=production
EXPOSE 3000

USER node

CMD ["npm", "start"]
