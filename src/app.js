require('dotenv').config();
require('./jobs');
const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Rota de saúde (testa se o servidor está rodando) ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: 'Sora', versao: '2.0' });
});

// --- Rotas (vamos adicionar uma a uma) ---
app.use('/webhook', require('./routes/webhook'));
app.use('/api/transacoes',   require('./routes/transacoes'));
app.use('/api/wallets',      require('./routes/wallets'));
app.use('/api/grupos',       require('./routes/grupos'));
app.use('/api/categorias',   require('./routes/categorias'));
app.use('/api/limites',      require('./routes/limites'));
app.use('/api/investimentos',require('./routes/investimentos'));
app.use('/api/metas',        require('./routes/metas'));
app.use('/api/dividas',      require('./routes/dividas'));
app.use('/api/user',         require('./routes/users'));

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