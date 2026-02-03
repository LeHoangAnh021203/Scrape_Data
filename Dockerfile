FROM node:22-slim

# Cài các gói cần thiết (Chromium + font)
RUN apt-get update && \
    apt-get install -y chromium fonts-liberation wget ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install

# Copy toàn bộ dự án
COPY . .

# Đường dẫn chrome hệ thống
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Build nếu cần (hoặc bỏ nếu không)
RUN npm run build

EXPOSE 3001
CMD ["node", "api-server.js"]
