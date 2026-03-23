FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json* ./

# Full install (including devDependencies) required for `remix vite:build`.
# Prefer `npm ci` when package-lock.json is committed; otherwise `npm install`.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi \
  && npm cache clean --force

COPY . .

ENV NODE_ENV=production

RUN npm run build

# Smaller runtime image: drop devDependencies after build
RUN npm prune --omit=dev && npm cache clean --force

CMD ["npm", "run", "docker-start"]
