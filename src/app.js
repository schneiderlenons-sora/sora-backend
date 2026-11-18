require('dotenv').config();
require('./jobs');
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // Render fica atrás de proxy — pra o rate limit ler o IP real
app.use(cors());
// `verify` guarda o corpo CRU em req.rawBody. Assinatura HMAC (webhook da Polp/
// Celcoin) tem que ser conferida sobre os bytes exatos que chegaram — recompor
// com JSON.stringify(req.body) muda espaços/ordem e a assinatura nunca bateria.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { if (buf && buf.length) req.rawBody = buf; },
}));

// Rate limiting nas rotas de API — proteção contra abuso/brute force.
// 300 req / minuto por IP (folgado pro uso normal, corta scripts abusivos).
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em instantes.' },
});
app.use('/api', apiLimiter);

// --- Rota de saúde (testa se o servidor está rodando) ---
app.get('/health', (req, res) => {
  // `crons`: este processo roda os lembretes/avisos? (config/crons.js). Na troca
  // de região é como se confere, de fora, que só UM dos dois servidores os roda.
  res.json({ status: 'ok', bot: 'Sora', versao: '2.0', crons: require('./config/crons').cronsLigados() });
});

// --- Conferência de variáveis entre DOIS servidores (troca de região) ---
// Devolve o NOME de cada variável de ambiente e só 8 caracteres do sha256 do
// valor: dá pra comparar Oregon × Ohio e achar a variável que não foi copiada
// (falta dela costuma ser SILENCIOSA — suporte que não recebe, assinatura da
// Celcoin que deixa de ser conferida) sem nenhum valor sair do servidor.
// Mesmo segredo do diag-cotacao e do of-debug, que já abrem muito mais que isto.
app.get('/health/env', (req, res) => {
  const chave = process.env.API_SECRET_TOKEN;
  if (!chave || req.query.key !== chave) return res.sendStatus(403);
  const crypto = require('crypto');
  // Variáveis do sistema/Render/npm: mudam de um serviço pro outro por natureza.
  const doSistema = /^(RENDER|NODE_|NPM_|YARN_|COREPACK_|XDG_|PATH$|HOME$|HOSTNAME$|PWD$|OLDPWD$|SHLVL$|_$|PORT$|IS_PULL_REQUEST$|LANG$|TERM$|USER$|SHELL$|INIT_CWD$|COLOR$|EDITOR$|DEBIAN_FRONTEND$)/i;
  const variaveis = {};
  for (const k of Object.keys(process.env).sort()) {
    if (doSistema.test(k)) continue;
    variaveis[k] = crypto.createHash('sha256').update(String(process.env[k])).digest('hex').slice(0, 8);
  }
  res.json({ total: Object.keys(variaveis).length, variaveis });
});

// --- Rotas (vamos adicionar uma a uma) ---
app.use('/webhook',          require('./routes/webhook'));
app.use('/webhook/meta',     require('./routes/webhook-meta'));
app.use('/webhook/negocios', require('./routes/webhook-negocios'));
// Operação (clientes/produtos/vendas) monta no MESMO prefixo, em arquivo
// próprio — `negocios.js` já passa de 1.600 linhas.
app.use('/api/negocios',     require('./routes/negociosOperacao'));
app.use('/api/negocios',     require('./routes/negocios'));
app.use('/api/transacoes',   require('./routes/transacoes'));
app.use('/api/dashboard',    require('./routes/dashboard'));
app.use('/api/wallets',      require('./routes/wallets'));
app.use('/api/grupos',       require('./routes/grupos'));
app.use('/api/categorias',   require('./routes/categorias'));
app.use('/api/marcas',       require('./routes/marcas'));
app.use('/api/regras',       require('./routes/regras'));
app.use('/api/limites',      require('./routes/limites'));
app.use('/api/previstos',    require('./routes/previstos'));
app.use('/api/investimentos',require('./routes/investimentos'));
app.use('/api/metas',        require('./routes/metas'));
app.use('/api/dividas',      require('./routes/dividas'));
app.use('/api/recorrencias', require('./routes/recorrencias'));
app.use('/api/grow',         require('./routes/grow'));
app.use('/api/dados',        require('./routes/dados'));
app.use('/api/wrapped',      require('./routes/wrapped'));
app.use('/api/saude',        require('./routes/saude'));
app.use('/api/estudos',      require('./routes/estudos'));
app.use('/api/biblia',       require('./routes/biblia'));
app.use('/api/admin',        require('./routes/admin'));
app.use('/api/user',         require('./routes/users'));
app.use('/api/bug',          require('./routes/bug'));
app.use('/api/pluggy',       require('./routes/pluggy'));
app.use('/api/webhooks/pluggy', require('./routes/webhookPluggy'));
// Open Finance (Polp) — agregador-agnóstico. Guardado por env (503 até configurar).
// Dois trilhos convivem: 'polp' (Pluggy v1) e 'polp-celcoin' (Celcoin v2);
// of_conexoes.provider decide qual sincroniza cada conexão.
app.use('/api/open-finance', require('./routes/openFinance'));
app.use('/api/webhooks/polp', require('./routes/webhookPolp'));
app.use('/api/webhooks/celcoin', require('./routes/webhookCelcoin'));

// --- 404 ---
app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada' });
});

// --- Iniciar servidor ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Sora rodando na porta ${PORT}`);
  console.log(`📡 Teste: http://localhost:${PORT}/health\n`);
});