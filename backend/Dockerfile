FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production=false

COPY . .

EXPOSE 3001

# Use tsx in Docker too — avoids needing to copy migration SQL files into dist/
# and keeps the build simpler. Production perf is irrelevant (Express, not compute).
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && npx tsx src/db/seed.ts && npx tsx src/index.ts"]
