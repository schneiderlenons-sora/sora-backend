FROM node:22-alpine

WORKDIR /app

# Instala dependências do sistema (apenas o essencial pra Node)
RUN apk add --no-cache tini

# Copia manifests primeiro (cache de layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o resto do código
COPY . .

EXPOSE 3001

# tini = init mínimo p/ tratar sinais corretamente (SIGTERM do Fly)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/app.js"]
