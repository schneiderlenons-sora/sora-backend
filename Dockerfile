# ⚠️ MESMA versão do `.node-version` — mexeu num, mexa no outro. O serviço de
# Ohio (sora-backend-ohio) roda por ESTE Dockerfile; o de Oregon roda no
# runtime nativo do Render, que lê o `.node-version`. Com versões diferentes
# os dois servidores não seriam o mesmo programa.
FROM node:26.13.1-alpine

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
