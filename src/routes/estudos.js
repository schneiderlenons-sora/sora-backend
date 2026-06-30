// ─────────────────────────────────────────────────────────────────
// Sora · Estudos — API REST
// CRUD: cursos, disciplinas, provas, sessoes_estudo, metas, anotacoes
// + endpoint /dashboard agregador
// ─────────────────────────────────────────────────────────────────
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');

const norm = p => p?.replace(/\D/g, '');

// Verifica acesso ao Grow (Black auto / Premium-trial / Grow pago)
// Estudos é Premium+ (não faz parte do Grow base do Básico).
async function temAcessoGrow(id) {
  const { data: u } = await supabase.from('users')
    .select('plano, plano_grow').eq('id', id).maybeSingle();
  if (!u) return false;
  if (['premium', 'black'].includes(u.plano)) return true;
  if (u.plano_grow === 'grow_premium') return true; // legado
  return false;
}

async function requireGrow(req, res, next) {
  // Identidade pelo usuário autenticado (JWT/e-mail), não por telefone.
  const id = req.authUser?.id;
  if (!id) return res.status(401).json({ erro: 'nao_autenticado' });
  if (!(await temAcessoGrow(id))) return res.status(403).json({ erro: 'sem_acesso_grow' });
  const { data: u } = await supabase.from('users').select('id, grupo_ativo').eq('id', id).maybeSingle();
  if (!u?.grupo_ativo) return res.status(404).json({ erro: 'usuario_nao_encontrado' });
  req._user = { id: u.id, grupo_ativo: u.grupo_ativo, phone: req.authUser.phone };
  next();
}

// ═════════════════════════════════════════════════════════════════
// DASHBOARD AGREGADOR
// ═════════════════════════════════════════════════════════════════
router.get('/dashboard/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const hoje = new Date();
    const hojeStr = hoje.toISOString().slice(0, 10);
    const inicioSemana = new Date(hoje); inicioSemana.setDate(inicioSemana.getDate() - 6);
    const inicioMes    = new Date(hoje); inicioMes.setDate(inicioMes.getDate() - 30);

    const [{ data: cursos }, { data: disciplinas }, { data: provas }, { data: sessoes }] = await Promise.all([
      supabase.from('cursos').select('*').eq('user_id', u.id).order('created_at', { ascending: false }),
      supabase.from('disciplinas').select('*').eq('user_id', u.id).eq('status', 'ativa'),
      supabase.from('provas').select('*, disciplinas(nome, cor, icone)').eq('user_id', u.id).gte('data', hojeStr).eq('realizada', false).order('data').limit(10),
      supabase.from('sessoes_estudo').select('data, duracao_min, disciplina_id').eq('user_id', u.id).gte('data', inicioMes.toISOString().slice(0,10)).order('data', { ascending: false }),
    ]);

    // Streak: dias consecutivos com pelo menos 1 sessão
    const datasComSessao = new Set((sessoes || []).map(s => s.data));
    let streak = 0;
    const cur = new Date(); cur.setHours(0,0,0,0);
    for (let i = 0; i < 365; i++) {
      const d = new Date(cur); d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      if (datasComSessao.has(iso)) streak++;
      else if (i === 0) continue;
      else break;
    }

    // Minutos esta semana + hoje
    const minSemana = (sessoes || []).filter(s => s.data >= inicioSemana.toISOString().slice(0,10)).reduce((sum, s) => sum + (s.duracao_min || 0), 0);
    const minHoje   = (sessoes || []).filter(s => s.data === hojeStr).reduce((sum, s) => sum + (s.duracao_min || 0), 0);

    res.json({
      cursos: cursos || [],
      cursos_ativos: (cursos || []).filter(c => c.status === 'ativo'),
      disciplinas: disciplinas || [],
      provas_proximas: provas || [],
      streak,
      min_hoje: minHoje,
      min_semana: minSemana,
      sessoes_total: (sessoes || []).length,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// CURSOS
// ═════════════════════════════════════════════════════════════════
router.get('/cursos/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { tipo, status } = req.query;
    let q = supabase.from('cursos').select('*').eq('user_id', u.id).order('created_at', { ascending: false });
    if (tipo) q = q.eq('tipo', tipo);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/cursos', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { nome, tipo, instituicao, instrutor, cor, icone, data_inicio, data_fim, carga_horaria_h, url, observacao, status, progresso_pct } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'nome obrigatorio' });
    const { data, error } = await supabase.from('cursos').insert({
      grupo_id: u.grupo_ativo, user_id: u.id,
      nome: nome.trim(), tipo: tipo || 'online',
      instituicao, instrutor, cor, icone,
      data_inicio: data_inicio || null, data_fim: data_fim || null,
      carga_horaria_h, url, observacao,
      status: status || 'ativo', progresso_pct: progresso_pct || 0,
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/cursos/:id', auth, requireGrow, async (req, res) => {
  try {
    const allowed = ['nome','tipo','instituicao','instrutor','cor','icone','data_inicio','data_fim','carga_horaria_h','url','observacao','status','progresso_pct'];
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data, error } = await supabase.from('cursos').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/cursos/:id', auth, requireGrow, async (req, res) => {
  try {
    const { error } = await supabase.from('cursos').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// DISCIPLINAS
// ═════════════════════════════════════════════════════════════════
router.get('/disciplinas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { curso_id } = req.query;
    let q = supabase.from('disciplinas').select('*, cursos(nome, tipo)').eq('user_id', u.id);
    if (curso_id) q = q.eq('curso_id', curso_id);
    const { data, error } = await q.order('prioridade', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/disciplinas', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { nome, curso_id, cor, icone, prioridade, meta_minutos_semana, observacao } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'nome obrigatorio' });
    const { data, error } = await supabase.from('disciplinas').insert({
      grupo_id: u.grupo_ativo, user_id: u.id,
      nome: nome.trim(), curso_id: curso_id || null,
      cor, icone, prioridade: prioridade || 3,
      meta_minutos_semana, observacao,
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/disciplinas/:id', auth, requireGrow, async (req, res) => {
  try {
    const allowed = ['nome','curso_id','cor','icone','prioridade','meta_minutos_semana','status','observacao'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data, error } = await supabase.from('disciplinas').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/disciplinas/:id', auth, requireGrow, async (req, res) => {
  try {
    const { error } = await supabase.from('disciplinas').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// PROVAS
// ═════════════════════════════════════════════════════════════════
router.get('/provas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { curso_id, realizada } = req.query;
    let q = supabase.from('provas').select('*, disciplinas(nome, cor, icone), cursos(nome, tipo)').eq('user_id', u.id);
    if (curso_id) q = q.eq('curso_id', curso_id);
    if (realizada !== undefined) q = q.eq('realizada', realizada === 'true');
    const { data, error } = await q.order('data', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/provas', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { titulo, tipo, data, hora, disciplina_id, curso_id, peso, nota_obtida, nota_maxima, observacao, realizada } = req.body;
    if (!titulo?.trim() || !data) return res.status(400).json({ erro: 'titulo e data obrigatorios' });
    const { data: novo, error } = await supabase.from('provas').insert({
      grupo_id: u.grupo_ativo, user_id: u.id,
      titulo: titulo.trim(), tipo: tipo || 'prova', data, hora: hora || null,
      disciplina_id: disciplina_id || null, curso_id: curso_id || null,
      peso, nota_obtida, nota_maxima: nota_maxima || 10,
      observacao, realizada: realizada || false,
    }).select().single();
    if (error) throw error;
    res.json(novo);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/provas/:id', auth, requireGrow, async (req, res) => {
  try {
    const allowed = ['titulo','tipo','data','hora','disciplina_id','curso_id','peso','nota_obtida','nota_maxima','observacao','realizada'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data, error } = await supabase.from('provas').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/provas/:id', auth, requireGrow, async (req, res) => {
  try {
    const { error } = await supabase.from('provas').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// SESSÕES DE ESTUDO
// ═════════════════════════════════════════════════════════════════
router.get('/sessoes/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { dias, curso_id, disciplina_id } = req.query;
    const desde = new Date(); desde.setDate(desde.getDate() - (parseInt(dias) || 365));
    let q = supabase.from('sessoes_estudo')
      .select('*, disciplinas(nome, cor, icone), cursos(nome, tipo)')
      .eq('user_id', u.id)
      .gte('data', desde.toISOString().slice(0, 10));
    if (curso_id) q = q.eq('curso_id', curso_id);
    if (disciplina_id) q = q.eq('disciplina_id', disciplina_id);
    const { data, error } = await q.order('data', { ascending: false }).order('hora_inicio', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/sessoes', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { duracao_min, data, hora_inicio, hora_fim, disciplina_id, curso_id, tipo, tema, observacao, produtividade } = req.body;
    if (!duracao_min || duracao_min <= 0) return res.status(400).json({ erro: 'duracao_min invalida' });
    const { data: novo, error } = await supabase.from('sessoes_estudo').insert({
      grupo_id: u.grupo_ativo, user_id: u.id,
      duracao_min: parseInt(duracao_min),
      data: data || new Date().toISOString().slice(0, 10),
      hora_inicio: hora_inicio || null, hora_fim: hora_fim || null,
      disciplina_id: disciplina_id || null, curso_id: curso_id || null,
      tipo: tipo || 'estudo', tema, observacao, produtividade,
    }).select().single();
    if (error) throw error;
    res.json(novo);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/sessoes/:id', auth, requireGrow, async (req, res) => {
  try {
    const { error } = await supabase.from('sessoes_estudo').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// METAS DE ESTUDO
// ═════════════════════════════════════════════════════════════════
router.get('/metas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { curso_id } = req.query;
    const { data } = await supabase.from('metas_estudo').select('*')
      .eq('user_id', u.id).eq('curso_id', curso_id || null).maybeSingle();
    res.json(data || null);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/metas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { meta_minutos_diaria, meta_minutos_semanal, meta_sessoes_semanal, curso_id } = req.body;
    const payload = {
      grupo_id: u.grupo_ativo, user_id: u.id,
      meta_minutos_diaria, meta_minutos_semanal, meta_sessoes_semanal,
      curso_id: curso_id || null, updated_at: new Date().toISOString(),
    };
    const { data: existing } = await supabase.from('metas_estudo').select('id')
      .eq('user_id', u.id).eq('curso_id', curso_id || null).maybeSingle();
    const r = existing
      ? await supabase.from('metas_estudo').update(payload).eq('id', existing.id).select().single()
      : await supabase.from('metas_estudo').insert(payload).select().single();
    if (r.error) throw r.error;
    res.json(r.data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// ANOTAÇÕES
// ═════════════════════════════════════════════════════════════════
router.get('/anotacoes/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { disciplina_id, curso_id } = req.query;
    let q = supabase.from('anotacoes_estudo').select('*').eq('user_id', u.id);
    if (disciplina_id) q = q.eq('disciplina_id', disciplina_id);
    if (curso_id) q = q.eq('curso_id', curso_id);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/anotacoes', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { titulo, conteudo, tags, disciplina_id, curso_id } = req.body;
    const { data, error } = await supabase.from('anotacoes_estudo').insert({
      grupo_id: u.grupo_ativo, user_id: u.id,
      titulo, conteudo, tags,
      disciplina_id: disciplina_id || null, curso_id: curso_id || null,
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/anotacoes/:id', auth, requireGrow, async (req, res) => {
  try {
    const { error } = await supabase.from('anotacoes_estudo').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
