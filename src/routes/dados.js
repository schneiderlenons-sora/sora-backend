const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');

const norm = p => p?.replace(/\D/g, '');

async function getUser(req) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo, plano, plano_grow, grow_trial_fim, grow_pin_hash, grow_pin_ativo, grow_pin_erros, grow_pin_travado_ate')
    .eq('id', req.authUser?.id || '__none__').maybeSingle();
  return data;
}

// Acesso base ao Grow (todos os planos pagos) — Dados Pessoais é aba base.
function temAcessoGrow(u) {
  if (!u) return false;
  if (['basico', 'premium', 'platinum'].includes(u.plano)) return true;
  if (['grow_basico', 'grow_premium'].includes(u.plano_grow)) return true;
  if (u.plano_grow === 'trial' && u.grow_trial_fim && new Date(u.grow_trial_fim) > new Date()) return true;
  return false;
}

async function requireGrow(req, res, next) {
  // Usuario resolvido pelo JWT (getUser usa req.authUser.id) — NAO exigir phone,
  // senao chamadas autenticadas sem phone (ex.: PUT /dados/dados_itens/:id) quebram.
  const user = await getUser(req);
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

// Lista TODOS os arquivos do usuário (Recentes + busca do Drive no painel).
// Só itens tipo 'arquivo'; o painel junta com as seções/quadros já carregados.
router.get('/arquivos/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data, error } = await supabase.from('dados_itens')
      .select('id, titulo, arquivo_url, arquivo_nome, created_at, secao_id')
      .eq('user_id', req.userRow.id).eq('tipo', 'arquivo')
      .order('created_at', { ascending: false }).limit(300);
    if (error) return res.status(503).json({ erro: error.message });
    res.json(data || []);
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

// ─── NOTAS (aba Notas do Drive) ──────────────────────────────────────
// A MESMA tabela das notas do WhatsApp (063). Regras em services/notasPainel.js
// (eval:notas-painel). Privado por user_id. Sem a migration 203 tudo funciona,
// menos fixar.
const notasPainel = require('../services/notasPainel');
const NOTA_COLS = 'id, titulo, texto, categoria, origem, created_at';

router.get('/notas/:phone', auth, requireGrow, async (req, res) => {
  try {
    // ⚠️ Colunas da 203 pedidas à parte: sem elas o SELECT inteiro falharia e
    // a pessoa veria "nenhuma nota" com as notas no banco.
    const ler = (cols) => supabase.from('notas').select(cols).eq('user_id', req.userRow.id)
      .order('created_at', { ascending: false }).limit(1000);
    let { data, error } = await ler(`${NOTA_COLS}, fixada, updated_at`);
    if (error && notasPainel.faltaColuna(error)) ({ data, error } = await ler(NOTA_COLS));
    // ⚠️ Falha de leitura NÃO vira lista vazia: "suas notas sumiram" é pior que um erro.
    if (error) return res.status(500).json({ erro: 'Não consegui carregar suas notas agora. Elas continuam salvas.' });
    res.json(notasPainel.ordenarNotas(data || []));
  } catch (e) { res.status(500).json({ erro: 'Não consegui carregar suas notas agora. Elas continuam salvas.' }); }
});

router.post('/notas', auth, requireGrow, async (req, res) => {
  try {
    const v = notasPainel.limparNota(req.body);
    if (!v.ok) return res.status(400).json({ erro: v.erro });
    const { fixada, ...base } = v.dados;
    const ins = {
      ...base, user_id: req.userRow.id, grupo_id: req.userRow.grupo_ativo || null, origem: 'texto',
    };
    const { data, error } = await supabase.from('notas').insert(ins).select('*').single();
    if (error) {
      console.warn('[notas] criar falhou:', error.message);
      return res.status(500).json({ erro: 'Não consegui salvar a nota agora. Tente de novo.' });
    }
    // Criar já fixada (raro): segue o caminho do PUT, que tolera a 203 ausente.
    if (fixada === true) {
      const r = await supabase.from('notas').update({ fixada: true }).eq('id', data.id).eq('user_id', req.userRow.id);
      if (!r.error) data.fixada = true;
    }
    res.json(data);
  } catch (e) { res.status(500).json({ erro: 'Não consegui salvar a nota agora. Tente de novo.' }); }
});

router.put('/notas/:id', auth, requireGrow, async (req, res) => {
  try {
    const v = notasPainel.limparNota(req.body, { parcial: true });
    if (!v.ok) return res.status(400).json({ erro: v.erro });
    const atualizar = (patch) => supabase.from('notas').update(patch)
      .eq('id', req.params.id).eq('user_id', req.userRow.id).select('*').maybeSingle();
    let { data, error } = await atualizar({ ...v.dados, updated_at: new Date().toISOString() });
    if (error && notasPainel.faltaColuna(error)) {
      // Sem a 203: fixar não tem onde gravar; o texto grava sem o updated_at.
      if ('fixada' in v.dados) {
        return res.status(503).json({ erro: 'Fixar notas ainda está sendo liberado. Tente de novo mais tarde.' });
      }
      ({ data, error } = await atualizar(v.dados));
    }
    if (error) {
      console.warn('[notas] editar falhou:', error.message);
      return res.status(500).json({ erro: 'Não consegui salvar a nota agora. Tente de novo.' });
    }
    if (!data) return res.status(404).json({ erro: 'Nota não encontrada.' });
    res.json(data);
  } catch (e) { res.status(500).json({ erro: 'Não consegui salvar a nota agora. Tente de novo.' }); }
});

router.delete('/notas/:id', auth, requireGrow, async (req, res) => {
  try {
    const { data, error } = await supabase.from('notas').delete()
      .eq('id', req.params.id).eq('user_id', req.userRow.id).select('id');
    if (error) return res.status(500).json({ erro: 'Não consegui apagar agora. Tente de novo.' });
    if (!data || !data.length) return res.status(404).json({ erro: 'Nota não encontrada.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Não consegui apagar agora. Tente de novo.' }); }
});

crud('dados_quadros', ['nome', 'cor', 'icone', 'ordem']);
crud('dados_secoes',  ['quadro_id', 'nome', 'icone', 'ordem'], 'quadro_id');
crud('dados_itens',   ['secao_id', 'tipo', 'titulo', 'valor', 'arquivo_url', 'arquivo_nome', 'ordem'], 'secao_id');

module.exports = router;
