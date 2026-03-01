# Frontend Dockerfile - builds the React frontend using Vite and serves it with nginx
FROM node:20 AS build

# Set working directory and download dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install

# Copy and build source code
COPY . .

RUN npm run build

# Serve using nginx
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html