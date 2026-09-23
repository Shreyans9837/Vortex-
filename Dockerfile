FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 curl ca-certificates pkg-config libssl-dev git cargo && rm -rf /var/lib/apt/lists/*
RUN cargo install --locked circom
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data /app/zk/build
RUN node scripts/setup-zk.js
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["node", "index.js"]
