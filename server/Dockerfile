FROM node:22-alpine

WORKDIR /app

RUN npm i -g npm@11.9.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0

EXPOSE 3001

CMD ["node", "index.js"]
