FROM node:20-alpine

WORKDIR /app

# Install openssl for Prisma
RUN apk add --no-cache openssl

# Copy package files
COPY package.json yarn.lock* ./

# Install ALL dependencies (termasuk devDependencies untuk start:dev)
RUN yarn install

# Copy all files
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Expose port
EXPOSE 4000

# Jalankan langsung menggunakan start:dev
# Ini akan mengompile otomatis saat jalan
CMD ["yarn", "start:dev"]
