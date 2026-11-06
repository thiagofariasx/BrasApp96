FROM node:22-alpine
RUN apk add --no-cache tzdata
ENV NODE_ENV=production TZ=America/Fortaleza
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
USER node
EXPOSE 10000
CMD ["node", "server.js"]
