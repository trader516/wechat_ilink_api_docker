FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy dependency definitions
COPY package.json pnpm-lock.yaml ./

# Install dependencies using pnpm
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy application source
COPY . .

# Expose API port
EXPOSE 3000

# Bind to 0.0.0.0 for Docker container
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/app/data

# By default, use npm run api-server to start
CMD ["npm", "run", "api-server"]
