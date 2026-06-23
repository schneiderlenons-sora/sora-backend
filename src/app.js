require('dotenv').config();
require('./jobs');
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // Render fica atrás de proxy — pra o rate limit ler o IP real
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
  res.json({ status: 'ok', bot: 'Sora', versao: '2.0' });
});

// --- Rotas (vamos adicionar uma a uma) ---
app.use('/webhook',          require('./routes/webhook'));
app.use('/webhook/negocios', require('./routes/webhook-negocios'));
app.use('/api/negocios',     require('./routes/negocios'));
app.use('/api/transacoes',   require('./routes/transacoes'));
app.use('/api/dashboard',    require('./routes/dashboard'));
app.use('/api/wallets',      require('./routes/wallets'));
app.use('/api/grupos',       require('./routes/grupos'));
app.use('/api/categorias',   require('./routes/categorias'));
app.use('/api/limites',      require('./routes/limites'));
app.use('/api/investimentos',require('./routes/investimentos'));
app.use('/api/metas',        require('./routes/metas'));
app.use('/api/dividas',      require('./routes/dividas'));
app.use('/api/recorrencias', require('./routes/recorrencias'));
app.use('/api/grow',         require('./routes/grow'));
app.use('/api/dados',        require('./routes/dados'));
app.use('/api/wrapped',      require('./routes/wrapped'));
app.use('/api/saude',        require('./routes/saude'));
app.use('/api/estudos',      require('./routes/estudos'));
app.use('/api/user',         require('./routes/users'));
app.use('/api/bug',          require('./routes/bug'));
app.use('/api/pluggy',       require('./routes/pluggy'));
app.use('/api/webhooks/pluggy', require('./routes/webhookPluggy'));

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