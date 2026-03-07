FROM node:22-alpine AS build

WORKDIR /app

RUN npm i -g npm@11.9.0

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG REACT_APP_SOCKET_URL
ENV REACT_APP_SOCKET_URL=$REACT_APP_SOCKET_URL

RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html

EXPOSE 80
