# ---------- Build Stage ----------
    FROM node:20-alpine AS builder
    
    WORKDIR /app
    
    # Copy package files first for caching
    COPY package.json package-lock.json* ./
    RUN npm ci
    
    # Copy rest of source (INCLUDING .env.production)
    COPY . .
    
    # Build production bundle
    RUN npm run build
    
    
    # ---------- Production Stage ----------
    FROM nginx:alpine
    
    # Remove default nginx config
    RUN rm -rf /usr/share/nginx/html/*
    
    # Copy built app from builder
    COPY nginx.conf /etc/nginx/conf.d/default.conf
    COPY --from=builder /app/dist /usr/share/nginx/html
    
    # Expose port 80 (container internal)
    EXPOSE 80
    
    CMD ["nginx", "-g", "daemon off;"]