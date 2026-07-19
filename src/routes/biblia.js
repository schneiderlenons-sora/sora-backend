// ─────────────────────────────────────────────────────────────────
// Sora · Bíblia (Estudos do Grow) — API REST · MVP por referência
//   GET    /api/biblia/:phone            estado (plano ativo + leituras 90d)
//   POST   /api/biblia/plano             define/troca o plano ativo
//   POST   /api/biblia/leitura           registra leitura (dia do plano ou avulsa)
//   DELETE /api/biblia/leitura/:id       desfaz uma leitura
//
// Conteúdo (planos/versículos) é estático no FRONTEND (lib/biblia.ts). Aqui só
// o estado do usuário. Mesmo requireGrow do estudos.js (Premium+).
// ─────────────────────────────────────────────────────────────────
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');

async function temAcessoGrow(id) {
  const { data: u } = await supabase.from('users').select('plano, plano_grow').eq('id', id).maybeSingle();
  if (!u) return false;
  if (['premium', 'black'].includes(u.plano)) return true;
  if (u.plano_grow === 'grow_premium') return true;
  return false;
}

async function requireGrow(req, res, next) {
  const id = req.authUser?.id;
  if (!id) return res.status(401).json({ erro: 'nao_autenticado' });
  if (!(await temAcessoGrow(id))) return res.status(403).json({ erro: 'sem_acesso_grow' });
  const { data: u } = await supabase.from('users').select('id, grupo_ativo').eq('id', id).maybeSingle();
  if (!u?.grupo_ativo) return res.status(404).json({ erro: 'usuario_nao_encontrado' });
  req._user = { id: u.id, grupo_ativo: u.grupo_ativo };
  next();
}

// Streak de dias (consecutivos até hoje/ontem) com pelo menos uma leitura.
function calcularStreak(datas) {
  const set = new Set(datas);
  let streak = 0;
  const d = new Date();
  // aceita começar hoje OU ontem (não zera se ainda não leu hoje).
  const hoje = d.toISOString().slice(0, 10);
  d.setDate(d.getDate() - 1);
  const ontem = d.toISOString().slice(0, 10);
  if (!set.has(hoje) && !set.has(ontem)) return 0;
  const cursor = new Date();
  if (!set.has(hoje)) cursor.setDate(cursor.getDate() - 1);
  for (;;) {
    const iso = cursor.toISOString().slice(0, 10);
    if (set.has(iso)) { streak++; cursor.setDate(cursor.getDate() - 1); }
    else break;
  }
  return streak;
}

// ── GET estado ────────────────────────────────────────────────────
router.get('/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const desde = new Date(); desde.setDate(desde.getDate() - 90);
    const desdeStr = desde.toISOString().slice(0, 10);

    const [prog, leit] = await Promise.all([
      supabase.from('biblia_progresso').select('plano_id, iniciado_em').eq('user_id', u.id).maybeSingle(),
      supabase.from('biblia_leituras').select('id, data, plano_id, dia, referencia, duracao_min, reflexao')
        .eq('user_id', u.id).gte('data', desdeStr).order('data', { ascending: false }),
    ]);

    const leituras = leit.data || [];
    const streak = calcularStreak(leituras.map(l => l.data));

    res.json({
      plano: prog.data || null,                 // { plano_id, iniciado_em } | null
      leituras,                                  // 90 dias (pro heatmap + histórico)
      diasConcluidos: leituras.filter(l => l.plano_id && l.dia != null).map(l => ({ plano_id: l.plano_id, dia: l.dia })),
      streak,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── POST plano ativo (troca) ──────────────────────────────────────
router.post('/plano', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const plano_id = String(req.body?.plano_id || '').trim();
    if (!plano_id) return res.status(400).json({ erro: 'plano_id obrigatório' });
    const { data, error } = await supabase.from('biblia_progresso')
      .upsert({ grupo_id: u.grupo_ativo, user_id: u.id, plano_id, iniciado_em: new Date().toISOString().slice(0, 10), atualizado_em: new Date().toISOString() },
              { onConflict: 'grupo_id,user_id' })
      .select('plano_id, iniciado_em').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── POST leitura (dia do plano ou avulsa) ─────────────────────────
router.post('/leitura', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { plano_id = null, dia = null, referencia, duracao_min = 0, reflexao = null } = req.body || {};
    if (!referencia) return res.status(400).json({ erro: 'referencia obrigatória' });
    const row = {
      grupo_id: u.grupo_ativo, user_id: u.id,
      data: new Date().toISOString().slice(0, 10),
      plano_id, dia: dia != null ? Number(dia) : null,
      referencia: String(referencia).slice(0, 200),
      duracao_min: Math.max(0, Math.min(1440, Number(duracao_min) || 0)),
      reflexao: reflexao ? String(reflexao).slice(0, 2000) : null,
    };
    const { data, error } = await supabase.from('biblia_leituras').insert(row).select('*').single();
    if (error) {
      // dia do plano já concluído (unique index) → não é erro pro usuário.
      if (error.code === '23505') return res.json({ ja: true });
      throw error;
    }
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── DELETE leitura ────────────────────────────────────────────────
router.delete('/leitura/:id', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    await supabase.from('biblia_leituras').delete().eq('id', req.params.id).eq('user_id', u.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// FASE 2 — ORAÇÃO
// ═══════════════════════════════════════════════════════════════════
router.get('/oracoes/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('biblia_oracoes')
      .select('id, pedido, respondida, respondida_em, created_at')
      .eq('user_id', req._user.id).order('created_at', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/oracoes', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const pedido = String(req.body?.pedido || '').trim();
    if (!pedido) return res.status(400).json({ erro: 'pedido obrigatório' });
    const { data, error } = await supabase.from('biblia_oracoes')
      .insert({ grupo_id: u.grupo_ativo, user_id: u.id, pedido: pedido.slice(0, 500) })
      .select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Alterna "respondida" (ou seta pelo body).
router.put('/oracoes/:id', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const respondida = !!req.body?.respondida;
    const { data, error } = await supabase.from('biblia_oracoes')
      .update({ respondida, respondida_em: respondida ? new Date().toISOString().slice(0, 10) : null })
      .eq('id', req.params.id).eq('user_id', u.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/oracoes/:id', auth, requireGrow, async (req, res) => {
  try {
    await supabase.from('biblia_oracoes').delete().eq('id', req.params.id).eq('user_id', req._user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// FASE 2 — MEMORIZAÇÃO (repetição espaçada)
// nivel → dias até a próxima revisão. Acertou = sobe de nível; errou = volta.
// ═══════════════════════════════════════════════════════════════════
const INTERVALOS = [1, 1, 3, 7, 14, 30, 60]; // dias por nível (0..6)
const addDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

router.get('/memorizacao/:phone', auth, requireGrow, async (req, res) => {
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const { data } = await supabase.from('biblia_memorizacao')
      .select('id, referencia, texto, nivel, proxima_revisao, ultima_revisao')
      .eq('user_id', req._user.id).order('created_at', { ascending: false });
    const versos = data || [];
    res.json({ versos, paraRevisar: versos.filter(v => v.proxima_revisao <= hoje).length });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/memorizacao', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const referencia = String(req.body?.referencia || '').trim();
    if (!referencia) return res.status(400).json({ erro: 'referencia obrigatória' });
    const { data, error } = await supabase.from('biblia_memorizacao')
      .insert({ grupo_id: u.grupo_ativo, user_id: u.id, referencia: referencia.slice(0, 200),
                texto: req.body?.texto ? String(req.body.texto).slice(0, 1000) : null })
      .select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Revisão: acertou=true sobe de nível (intervalo maior); false volta pro nível 1.
router.post('/memorizacao/:id/revisar', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const acertou = !!req.body?.acertou;
    const { data: v } = await supabase.from('biblia_memorizacao')
      .select('nivel').eq('id', req.params.id).eq('user_id', u.id).maybeSingle();
    if (!v) return res.status(404).json({ erro: 'não encontrado' });
    const nivel = acertou ? Math.min(6, (v.nivel || 0) + 1) : 1;
    const { data, error } = await supabase.from('biblia_memorizacao')
      .update({ nivel, proxima_revisao: addDias(INTERVALOS[nivel]), ultima_revisao: new Date().toISOString().slice(0, 10) })
      .eq('id', req.params.id).eq('user_id', u.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/memorizacao/:id', auth, requireGrow, async (req, res) => {
  try {
    await supabase.from('biblia_memorizacao').delete().eq('id', req.params.id).eq('user_id', req._user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
