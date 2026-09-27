# Use the official Node.js 20 Alpine image as a base
FROM node:20-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the application
RUN npm run build

# Production image
FROM node:20-alpine AS runner

# Create a non-root user
RUN addgroup -g 1001 nodejs && \
    adduser -S -u 1001 -G nodejs nodejs

# Set the working directory
WORKDIR /app

# Copy built artifacts and production dependencies from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

# Install only production dependencies
RUN npm ci --omit=dev

# Set ownership to the non-root user
RUN chown -R nodejs:nodejs /app

# Switch to the non-root user
USER nodejs

# Expose any necessary ports (optional, based on your app, telegram bots using polling often don't need ports)
# EXPOSE 3000

# Set environment variables for production
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]
