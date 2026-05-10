FROM node:20-alpine

WORKDIR /app

# Install openssl for Prisma
RUN apk add --no-cache openssl

# Copy package files
COPY package.json yarn.lock ./

# Install ALL dependencies (termasuk devDependencies untuk start:dev)
RUN yarn install

# Copy all files
COPY . .

# Generate Prisma Client
RUN npx prisma generate
RUN yarn build

# Expose port
EXPOSE 4000

CMD ["node", "dist/main"]
