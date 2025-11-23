FROM node:18-slim

# Install necessary dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    libu2f-udev \
    libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Install Chromium for Puppeteer
RUN npx puppeteer browsers install chrome

# Copy application files
COPY . .

# Create data directory for storing bot data
RUN mkdir -p /app/data

# Expose port
EXPOSE 8000

# Start the server
CMD ["node", "server.js"]
```

#### 5. **.gitignore**
```
# Dependencies
node_modules/
package-lock.json

# Database
*.db
*.db-journal

# Bot Data
data/

# Environment
.env

# Logs
*.log

# OS Files
.DS_Store

# IDE
.vscode/
.idea/

# Railway
.railway/
