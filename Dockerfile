# Step 1: Build Image
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Copy source and prisma schema
COPY . .

# Generate Prisma Client (PENTING)
RUN npx prisma generate

# Build the NestJS app
RUN yarn build

# Step 2: Production Image
FROM node:20-alpine

WORKDIR /app

# Install openssl for Prisma on Alpine
RUN apk add --no-cache openssl

# Copy built assets and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma

# Set environment variables
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Jalankan migrasi baru kemudian start bot
CMD npx prisma migrate deploy && node dist/main.js
