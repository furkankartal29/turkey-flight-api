FROM node:20-alpine

# Install build tools for native sqlite3 module
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install production dependencies (sqlite3 needs native compile)
RUN npm install --production

# Copy the rest of application files
COPY . .

# Expose port 3000
EXPOSE 3000

# Node.js memory & performance flags:
# --max-old-space-size=256   → caps heap at 256 MB (efficient in containers)
# --optimize-for-size        → reduces memory footprint
# --gc-interval=100          → runs GC more often to keep memory low
ENV NODE_OPTIONS="--max-old-space-size=256"
ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
