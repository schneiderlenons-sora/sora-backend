const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');

const norm = p => p?.replace(/\D/g, '');

async function getUser(phone) {
  const { data } = await supabase.from('users')
    .select('id, plano, plano_grow, grow_trial_fim, grow_pin_hash, grow_pin_ativo, grow_pin_erros, grow_pin_travado_ate')
    .eq('phone', norm(phone)).maybeSingle();
  return data;
}

// Acesso base ao Grow (todos os planos pagos) — Dados Pessoais é aba base.
function temAcessoGrow(u) {
  if (!u) return false;
  if (['basico', 'premium', 'black'].includes(u.plano)) return true;
  if (['grow_basico', 'grow_premium'].includes(u.plano_grow)) return true;
  if (u.plano_grow === 'trial' && u.grow_trial_fim && new Date(u.grow_trial_fim) > new Date()) return true;
  return false;
}

async function requireGrow(req, res, next) {
  const phone = req.params.phone || req.body.phone || req.query.phone;
  if (!phone) return res.status(400).json({ erro: 'phone obrigatorio' });
  const user = await getUser(phone);
  if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });
  if (!temAcessoGrow(user)) return res.status(403).json({ erro: 'sem_acesso_grow' });
  req.userRow = user;
  next();
}

// ─── PIN (trava de UI) — hash com salt (scrypt), nunca o PIN puro ─────
const PIN_MAX_ERROS = 5;
const PIN_TRAVA_MIN = 15;

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${dk}`;
}
function conferePin(pin, hash) {
  if (!hash || !hash.includes(':')) return false;
  const [salt, dk] = hash.split(':');
  const calc = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  // timingSafeEqual exige buffers de mesmo tamanho
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(dk, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const pinValido = (p) => /^\d{4}$/.test(String(p || ''));

// Status do PIN
router.get('/pin/status/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req.userRow;
    const travado = u.grow_pin_travado_ate && new Date(u.grow_pin_travado_ate) > new Date();
    res.json({
      definido: !!u.grow_pin_hash && !!u.grow_pin_ativo,
      travadoAte: travado ? u.grow_pin_travado_ate : null,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Define ou troca o PIN. Se já existe, exige o pinAtual correto.
router.post('/pin/definir', auth, requireGrow, async (req, res) => {
  try {
    const { pinAtual, pinNovo } = req.body;
    if (!pinValido(pinNovo)) return res.status(400).json({ erro: 'O PIN deve ter 4 dígitos.' });
    const u = req.userRow;
    if (u.grow_pin_hash && u.grow_pin_ativo) {
      if (!conferePin(pinAtual, u.grow_pin_hash)) return res.status(403).json({ erro: 'PIN atual incorreto.' });
    }
    await supabase.from('users').update({
      grow_pin_hash: hashPin(pinNovo), grow_pin_ativo: true,
      grow_pin_erros: 0, grow_pin_travado_ate: null,
    }).eq('id', u.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Verifica o PIN (com bloqueio após N erros).
router.post('/pin/verificar', auth, requireGrow, async (req, res) => {
  try {
    const u = req.userRow;
    if (!u.grow_pin_hash || !u.grow_pin_ativo) return res.json({ ok: true }); // sem PIN → liberado
    if (u.grow_pin_travado_ate && new Date(u.grow_pin_travado_ate) > new Date())
      return res.status(429).json({ ok: false, travadoAte: u.grow_pin_travado_ate });

    if (conferePin(req.body.pin, u.grow_pin_hash)) {
      await supabase.from('users').update({ grow_pin_erros: 0, grow_pin_travado_ate: null }).eq('id', u.id);
      return res.json({ ok: true });
    }
    // erro: incrementa; trava ao atingir o limite
    const erros = (u.grow_pin_erros || 0) + 1;
    const patch = { grow_pin_erros: erros };
    let travadoAte = null;
    if (erros >= PIN_MAX_ERROS) {
      travadoAte = new Date(Date.now() + PIN_TRAVA_MIN * 60000).toISOString();
      patch.grow_pin_erros = 0;
      patch.grow_pin_travado_ate = travadoAte;
    }
    await supabase.from('users').update(patch).eq('id', u.id);
    res.status(403).json({ ok: false, restantes: Math.max(0, PIN_MAX_ERROS - erros), travadoAte });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Remove o PIN (exige o PIN atual).
router.post('/pin/remover', auth, requireGrow, async (req, res) => {
  try {
    const u = req.userRow;
    if (u.grow_pin_hash && u.grow_pin_ativo && !conferePin(req.body.pin, u.grow_pin_hash))
      return res.status(403).json({ erro: 'PIN incorreto.' });
    await supabase.from('users').update({
      grow_pin_hash: null, grow_pin_ativo: false, grow_pin_erros: 0, grow_pin_travado_ate: null,
    }).eq('id', u.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Reset (esqueci o PIN): o front confirma a SENHA DA CONTA via Supabase antes
// de chamar aqui. Trava de UI → define um PIN novo pro usuário autenticado.
router.post('/pin/resetar', auth, requireGrow, async (req, res) => {
  try {
    const { pinNovo } = req.body;
    if (!pinValido(pinNovo)) return res.status(400).json({ erro: 'O PIN deve ter 4 dígitos.' });
    await supabase.from('users').update({
      grow_pin_hash: hashPin(pinNovo), grow_pin_ativo: true,
      grow_pin_erros: 0, grow_pin_travado_ate: null,
    }).eq('id', req.userRow.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── CRUD genérico (privado por user_id) ─────────────────────────────
// Cria endpoints REST pra uma tabela escopada por user_id, com filtro pai
// opcional (ex.: seções de um quadro). campos = colunas editáveis.
function crud(tabela, campos, filtroPai) {
  router.get(`/${tabela}/:phone`, auth, requireGrow, async (req, res) => {
    try {
      let q = supabase.from(tabela).select('*').eq('user_id', req.userRow.id);
      if (filtroPai && req.query[filtroPai]) q = q.eq(filtroPai, req.query[filtroPai]);
      const { data, error } = await q.order('ordem', { ascending: true }).order('created_at', { ascending: true });
      if (error) return res.status(503).json({ erro: `Indisponível: rode a migration 041. (${error.message})` });
      res.json(data || []);
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  router.post(`/${tabela}`, auth, requireGrow, async (req, res) => {
    try {
      const ins = { user_id: req.userRow.id };
      for (const k of campos) if (k in req.body) ins[k] = req.body[k];
      const { data, error } = await supabase.from(tabela).insert(ins).select().single();
      if (error) return res.status(500).json({ erro: error.message });
      res.json(data);
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  router.put(`/${tabela}/:id`, auth, requireGrow, async (req, res) => {
    try {
      const patch = {};
      for (const k of campos) if (k in req.body) patch[k] = req.body[k];
      const { data, error } = await supabase.from(tabela)
        .update(patch).eq('id', req.params.id).eq('user_id', req.userRow.id).select().single();
      if (error || !data) return res.status(404).json({ erro: 'Não encontrado' });
      res.json(data);
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  router.delete(`/${tabela}/:id`, auth, requireGrow, async (req, res) => {
    try {
      await supabase.from(tabela).delete().eq('id', req.params.id).eq('user_id', req.userRow.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
}

// ─── ARQUIVOS (bucket privado, URLs assinadas) ───────────────────────
const BUCKET = 'dados-arquivos';

// Gera URL assinada de UPLOAD (o front envia o arquivo direto pro Storage).
router.post('/upload-url', auth, requireGrow, async (req, res) => {
  try {
    const nome = String(req.body.filename || 'arquivo').replace(/[^\w.\- ]+/g, '_').slice(0, 90);
    const path = `${req.userRow.id}/${crypto.randomUUID()}-${nome}`;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return res.status(503).json({ erro: `Storage indisponível: rode a migration 042. (${error.message})` });
    res.json({ path, token: data.token, nome });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Gera URL assinada de DOWNLOAD (válida 2 min). Só do próprio usuário.
router.post('/download-url', auth, requireGrow, async (req, res) => {
  try {
    const path = String(req.body.path || '');
    if (!path.startsWith(`${req.userRow.id}/`)) return res.status(403).json({ erro: 'sem_acesso' });
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 120);
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ url: data.signedUrl });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// DELETE de item — remove o arquivo do Storage se houver. Registrado ANTES do
// crud genérico pra ter precedência sobre o DELETE padrão.
router.delete('/dados_itens/:id', auth, requireGrow, async (req, res) => {
  try {
    const { data: item } = await supabase.from('dados_itens')
      .select('arquivo_url').eq('id', req.params.id).eq('user_id', req.userRow.id).maybeSingle();
    if (item?.arquivo_url) { try { await supabase.storage.from(BUCKET).remove([item.arquivo_url]); } catch {} }
    await supabase.from('dados_itens').delete().eq('id', req.params.id).eq('user_id', req.userRow.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

crud('dados_quadros', ['nome', 'cor', 'icone', 'ordem']);
crud('dados_secoes',  ['quadro_id', 'nome', 'icone', 'ordem'], 'quadro_id');
crud('dados_itens',   ['secao_id', 'tipo', 'titulo', 'valor', 'arquivo_url', 'arquivo_nome', 'ordem'], 'secao_id');

module.exports = router;
