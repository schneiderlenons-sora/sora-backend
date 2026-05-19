// ─────────────────────────────────────────────────────────────────
// Sora Grow — Saude (perfil, peso, agua, nutricao, treinos, checkups,
// consultas, exames, medicamentos, medidas, fotos, sintomas, vacinas, ciclo)
// ─────────────────────────────────────────────────────────────────
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const nutricao = require('../services/nutricao');

const norm = p => p?.replace(/\D/g, '');

async function getUser(phone) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo, plano, plano_grow, grow_trial_fim')
    .eq('phone', norm(phone)).maybeSingle();
  return data;
}

function temAcessoGrow(u) {
  if (!u) return false;
  if (u.plano === 'black') return true;
  if (['grow_basico','grow_premium'].includes(u.plano_grow)) return true;
  if (u.plano_grow === 'trial' && u.grow_trial_fim && new Date(u.grow_trial_fim) > new Date()) return true;
  return false;
}

async function requireGrow(req, res, next) {
  const phone = req.params.phone || req.body.phone || req.query.phone;
  if (!phone) return res.status(400).json({ erro: 'phone obrigatório' });
  const user = await getUser(phone);
  if (!user) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  if (!temAcessoGrow(user)) return res.status(403).json({ erro: 'sem_acesso_grow' });
  req._user = user;
  next();
}

// IMC + classificação
function classificarIMC(imc) {
  if (!imc || imc <= 0) return null;
  if (imc < 18.5) return { faixa: 'abaixo',     label: 'Abaixo do peso', cor: '#06b6d4' };
  if (imc < 25)   return { faixa: 'ideal',      label: 'Peso ideal',     cor: '#22c55e' };
  if (imc < 30)   return { faixa: 'sobrepeso',  label: 'Sobrepeso',      cor: '#f59e0b' };
  if (imc < 35)   return { faixa: 'obesidade1', label: 'Obesidade I',    cor: '#f97316' };
  if (imc < 40)   return { faixa: 'obesidade2', label: 'Obesidade II',   cor: '#ef4444' };
  return { faixa: 'obesidade3', label: 'Obesidade III', cor: '#b91c1c' };
}

// ═════════════════════════════════════════════════════════════════
// GET /api/saude/dashboard/:phone — agregado pro dashboard
// ═════════════════════════════════════════════════════════════════
router.get('/dashboard/:phone', auth, requireGrow, async (req, res) => {
  try {
    const user = req._user;
    const hoje = new Date().toISOString().slice(0, 10);
    const ini30 = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
    const iniSemana = (() => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0,10); })();

    const [
      { data: perfil },
      { data: ultimoPeso },
      { data: pesos30 },
      { data: aguaHoje },
      { data: meta },
      { data: refeicoes30 },
      { data: itensRef },
      { data: treinosSem },
      { data: checkHoje },
      { data: consultasProx },
      { data: medicamentosAtivos },
    ] = await Promise.all([
      supabase.from('perfil_saude').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('pesos').select('*').eq('user_id', user.id).order('data', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('pesos').select('data, peso_kg').eq('user_id', user.id).gte('data', ini30).order('data'),
      supabase.from('agua_registros').select('ml').eq('user_id', user.id).eq('data', hoje),
      supabase.from('metas_nutricao').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('refeicoes').select('id, data').eq('user_id', user.id).gte('data', ini30),
      supabase.from('refeicao_itens').select('refeicao_id, calorias, proteinas_g, carboidratos_g, gorduras_g').in('refeicao_id',
        // subquery via raw isn't supported here, so we'll filter on JS
        (await supabase.from('refeicoes').select('id').eq('user_id', user.id).gte('data', ini30)).data?.map(r => r.id) || []
      ),
      supabase.from('treino_registros').select('data, duracao_min, treino_nome').eq('user_id', user.id).gte('data', iniSemana),
      supabase.from('checkups').select('*').eq('user_id', user.id).eq('data', hoje).maybeSingle(),
      supabase.from('consultas').select('*').eq('user_id', user.id).eq('status', 'agendada').gte('data', hoje).order('data').limit(3),
      supabase.from('medicamentos').select('id, nome, dosagem, horarios, estoque_atual, estoque_alerta').eq('user_id', user.id).eq('ativo', true),
    ]);

    // Agua hoje (soma)
    const aguaHojeML = (aguaHoje || []).reduce((s, r) => s + (r.ml || 0), 0);

    // Macros hoje (soma)
    const refIdsHoje = (refeicoes30 || []).filter(r => r.data === hoje).map(r => r.id);
    const itensHoje = (itensRef || []).filter(i => refIdsHoje.includes(i.refeicao_id));
    const macrosHoje = itensHoje.reduce((acc, i) => ({
      calorias:       acc.calorias       + (parseFloat(i.calorias) || 0),
      proteinas_g:    acc.proteinas_g    + (parseFloat(i.proteinas_g) || 0),
      carboidratos_g: acc.carboidratos_g + (parseFloat(i.carboidratos_g) || 0),
      gorduras_g:     acc.gorduras_g     + (parseFloat(i.gorduras_g) || 0),
    }), { calorias: 0, proteinas_g: 0, carboidratos_g: 0, gorduras_g: 0 });

    // IMC
    let imc = null, imcClass = null;
    if (perfil?.altura_cm && ultimoPeso?.peso_kg) {
      const m = perfil.altura_cm / 100;
      imc = ultimoPeso.peso_kg / (m * m);
      imcClass = classificarIMC(imc);
    }

    // Projecao de meta de peso (assume 0.5kg/semana saudavel)
    let metaProjecao = null;
    if (perfil?.meta_peso_kg && ultimoPeso?.peso_kg) {
      const diff = parseFloat(ultimoPeso.peso_kg) - parseFloat(perfil.meta_peso_kg);
      const direcao = diff > 0 ? 'perder' : 'ganhar';
      const totalKg = Math.abs(diff);
      const semanas = Math.ceil(totalKg / 0.5);
      const dataProjecao = new Date(Date.now() + semanas * 7 * 86400000).toISOString().slice(0, 10);
      metaProjecao = {
        kg_restantes: parseFloat(totalKg.toFixed(2)),
        direcao,
        semanas_projetadas: semanas,
        data_projetada: dataProjecao,
        data_objetivo:  perfil.meta_peso_data,
      };
    }

    // Treinos da semana (count e duracao)
    const treinosSemana = (treinosSem || []).length;
    const minutosSemana = (treinosSem || []).reduce((s, t) => s + (t.duracao_min || 0), 0);

    res.json({
      perfil: perfil || null,
      peso_atual: ultimoPeso?.peso_kg || null,
      peso_data: ultimoPeso?.data || null,
      historico_peso: pesos30 || [],
      imc, imc_classificacao: imcClass,
      meta_projecao: metaProjecao,
      agua: {
        hoje_ml: aguaHojeML,
        meta_ml: meta?.agua_ml || 2000,
        pct: meta?.agua_ml ? Math.min(100, Math.round((aguaHojeML / meta.agua_ml) * 100)) : 0,
      },
      macros_hoje: macrosHoje,
      meta_macros: meta || null,
      treinos_semana: {
        count: treinosSemana,
        minutos: minutosSemana,
        lista:  treinosSem || [],
      },
      checkup_hoje: checkHoje || null,
      consultas_proximas: consultasProx || [],
      medicamentos_ativos: medicamentosAtivos || [],
    });
  } catch (err) { console.error('[saude/dashboard]', err); res.status(500).json({ erro: err.message }); }
});

// ═════════════════════════════════════════════════════════════════
// PERFIL SAUDE
// ═════════════════════════════════════════════════════════════════
router.get('/perfil/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('perfil_saude').select('*').eq('user_id', req._user.id).maybeSingle();
    res.json(data || null);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/perfil/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const patch = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id, updated_at: new Date().toISOString() };
    delete patch.phone;
    const { data: existing } = await supabase.from('perfil_saude').select('id').eq('user_id', u.id).maybeSingle();
    let result;
    if (existing) {
      result = await supabase.from('perfil_saude').update(patch).eq('id', existing.id).select().single();
    } else {
      result = await supabase.from('perfil_saude').insert(patch).select().single();
    }
    if (result.error) throw result.error;
    res.json(result.data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// PESO
// ═════════════════════════════════════════════════════════════════
router.get('/pesos/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { dias } = req.query;
    const ini = new Date(Date.now() - (parseInt(dias) || 90) * 86400000).toISOString().slice(0,10);
    const { data } = await supabase.from('pesos').select('*').eq('user_id', req._user.id).gte('data', ini).order('data');
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/pesos', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { peso_kg, data, observacao } = req.body;
    const { data: r, error } = await supabase.from('pesos').upsert({
      grupo_id: u.grupo_ativo, user_id: u.id,
      data: data || new Date().toISOString().slice(0,10),
      peso_kg: parseFloat(peso_kg),
      observacao,
    }, { onConflict: 'user_id,data' }).select().single();
    if (error) throw error;
    res.json(r);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/pesos/:id', auth, requireGrow, async (req, res) => {
  try { await supabase.from('pesos').delete().eq('id', req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// AGUA
// ═════════════════════════════════════════════════════════════════
router.get('/agua/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { dias } = req.query;
    const ini = new Date(Date.now() - (parseInt(dias) || 30) * 86400000).toISOString().slice(0,10);
    const { data } = await supabase.from('agua_registros').select('*').eq('user_id', req._user.id).gte('data', ini).order('data', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/agua', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { ml, data } = req.body;
    const { data: r, error } = await supabase.from('agua_registros').insert({
      grupo_id: u.grupo_ativo, user_id: u.id,
      data: data || new Date().toISOString().slice(0,10),
      ml: parseInt(ml),
    }).select().single();
    if (error) throw error;
    res.json(r);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/agua/:id', auth, requireGrow, async (req, res) => {
  try { await supabase.from('agua_registros').delete().eq('id', req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// METAS NUTRICIONAIS (manual ou via calculadora)
// ═════════════════════════════════════════════════════════════════
router.get('/metas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('metas_nutricao').select('*').eq('user_id', req._user.id).maybeSingle();
    res.json(data || null);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/metas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const patch = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id, updated_at: new Date().toISOString() };
    delete patch.phone;
    const { data: existing } = await supabase.from('metas_nutricao').select('id').eq('user_id', u.id).maybeSingle();
    const result = existing
      ? await supabase.from('metas_nutricao').update(patch).eq('id', existing.id).select().single()
      : await supabase.from('metas_nutricao').insert(patch).select().single();
    if (result.error) throw result.error;
    res.json(result.data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// REFEICOES (com itens)
// ═════════════════════════════════════════════════════════════════
router.get('/refeicoes/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { dias } = req.query;
    const ini = new Date(Date.now() - (parseInt(dias) || 30) * 86400000).toISOString().slice(0,10);
    const { data } = await supabase.from('refeicoes')
      .select('*, refeicao_itens(*)')
      .eq('user_id', req._user.id).gte('data', ini)
      .order('data', { ascending: false }).order('hora', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/refeicoes', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { tipo, data, hora, observacao, itens } = req.body;
    const { data: ref, error } = await supabase.from('refeicoes').insert({
      grupo_id: u.grupo_ativo, user_id: u.id,
      tipo: tipo || 'lanche',
      data: data || new Date().toISOString().slice(0,10),
      hora: hora || null,
      observacao,
    }).select().single();
    if (error) throw error;
    if (Array.isArray(itens) && itens.length) {
      const insertIts = itens.map(i => ({ ...i, refeicao_id: ref.id }));
      await supabase.from('refeicao_itens').insert(insertIts);
    }
    res.json(ref);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/refeicoes/:id', auth, requireGrow, async (req, res) => {
  try { await supabase.from('refeicoes').delete().eq('id', req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// NUTRIÇÃO — Calculadora, Parser, Diagnóstico, Banco de alimentos
// ═════════════════════════════════════════════════════════════════
router.get('/nutricao/alimentos', auth, requireGrow, async (req, res) => {
  try {
    const { q } = req.query;
    res.json(nutricao.buscarAlimentos(q));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/nutricao/analisar', auth, requireGrow, async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto?.trim()) return res.status(400).json({ erro: 'texto obrigatório' });
    const itens = await nutricao.analisarRefeicao(texto);
    res.json({ itens });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/nutricao/calcular', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { peso_kg, altura_cm, idade, sexo, nivel_atividade, objetivo, tipo_dieta, salvar } = req.body;
    const metas = nutricao.calcularMetas({ peso_kg, altura_cm, idade, sexo, nivel_atividade, objetivo, tipo_dieta });

    // Se pediu pra salvar, faz upsert em metas_nutricao
    let saved = null;
    if (salvar !== false) {
      const payload = { ...metas, grupo_id: u.grupo_ativo, user_id: u.id, updated_at: new Date().toISOString(), calculada_em: new Date().toISOString() };
      const { data: existing } = await supabase.from('metas_nutricao').select('id').eq('user_id', u.id).maybeSingle();
      const r = existing
        ? await supabase.from('metas_nutricao').update(payload).eq('id', existing.id).select().single()
        : await supabase.from('metas_nutricao').insert(payload).select().single();
      if (r.error) throw r.error;
      saved = r.data;
    }

    res.json({ ...metas, saved });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/nutricao/diagnostico/:phone', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const hoje = new Date().toISOString().slice(0, 10);

    const [{ data: meta }, { data: refeicoesHoje }] = await Promise.all([
      supabase.from('metas_nutricao').select('*').eq('user_id', u.id).maybeSingle(),
      supabase.from('refeicoes').select('id').eq('user_id', u.id).eq('data', hoje),
    ]);
    const refIds = (refeicoesHoje || []).map(r => r.id);
    let macrosHoje = { calorias: 0, proteinas_g: 0, carboidratos_g: 0, gorduras_g: 0 };
    if (refIds.length) {
      const { data: itens } = await supabase.from('refeicao_itens')
        .select('calorias, proteinas_g, carboidratos_g, gorduras_g').in('refeicao_id', refIds);
      (itens || []).forEach(i => {
        macrosHoje.calorias       += parseFloat(i.calorias) || 0;
        macrosHoje.proteinas_g    += parseFloat(i.proteinas_g) || 0;
        macrosHoje.carboidratos_g += parseFloat(i.carboidratos_g) || 0;
        macrosHoje.gorduras_g     += parseFloat(i.gorduras_g) || 0;
      });
    }
    res.json({ macros_hoje: macrosHoje, meta, diagnostico: nutricao.gerarDiagnostico(macrosHoje, meta) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// TREINOS (catalog + registros)
// ═════════════════════════════════════════════════════════════════
router.get('/treinos/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('treinos').select('*').eq('grupo_id', req._user.grupo_ativo).eq('ativo', true).order('nome');
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/treinos', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { nome, categoria, icone, cor } = req.body;
    const { data, error } = await supabase.from('treinos').insert({ grupo_id: u.grupo_ativo, nome, categoria, icone, cor }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/treino-registros/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { dias } = req.query;
    const ini = new Date(Date.now() - (parseInt(dias) || 365) * 86400000).toISOString().slice(0,10);
    const { data } = await supabase.from('treino_registros')
      .select('*, treinos(nome, icone, cor, categoria)')
      .eq('user_id', req._user.id).gte('data', ini)
      .order('data', { ascending: false }).order('hora', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/treino-registros', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { treino_id, treino_nome, data, hora, duracao_min, intensidade, calorias_kcal, observacao } = req.body;
    const { data: r, error } = await supabase.from('treino_registros').insert({
      grupo_id: u.grupo_ativo, user_id: u.id,
      treino_id: treino_id || null, treino_nome,
      data: data || new Date().toISOString().slice(0,10),
      hora, duracao_min, intensidade, calorias_kcal, observacao,
    }).select().single();
    if (error) throw error;
    res.json(r);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/treino-registros/:id', auth, requireGrow, async (req, res) => {
  try { await supabase.from('treino_registros').delete().eq('id', req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// CHECKUPS
// ═════════════════════════════════════════════════════════════════
router.get('/checkups/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { dias } = req.query;
    const ini = new Date(Date.now() - (parseInt(dias) || 90) * 86400000).toISOString().slice(0,10);
    const { data } = await supabase.from('checkups').select('*').eq('user_id', req._user.id).gte('data', ini).order('data', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/checkups', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const payload = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id, data: req.body.data || new Date().toISOString().slice(0,10) };
    delete payload.phone;
    const { data, error } = await supabase.from('checkups').upsert(payload, { onConflict: 'user_id,data' }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// CONSULTAS
// ═════════════════════════════════════════════════════════════════
router.get('/consultas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { status } = req.query;
    let q = supabase.from('consultas').select('*').eq('user_id', req._user.id).order('data', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data } = await q;
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/consultas', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const payload = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id };
    delete payload.phone;
    const { data, error } = await supabase.from('consultas').insert(payload).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/consultas/:id', auth, requireGrow, async (req, res) => {
  try {
    const patch = { ...req.body }; delete patch.phone;
    const { data, error } = await supabase.from('consultas').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/consultas/:id', auth, requireGrow, async (req, res) => {
  try { await supabase.from('consultas').delete().eq('id', req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// EXAMES
// ═════════════════════════════════════════════════════════════════
router.get('/exames/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { nome } = req.query;
    let q = supabase.from('exames').select('*').eq('user_id', req._user.id).order('data', { ascending: false });
    if (nome) q = q.eq('nome', nome);
    const { data } = await q;
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/exames', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const payload = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id };
    delete payload.phone;
    const { data, error } = await supabase.from('exames').insert(payload).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/exames/:id', auth, requireGrow, async (req, res) => {
  try { await supabase.from('exames').delete().eq('id', req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// MEDICAMENTOS + DOSES
// ═════════════════════════════════════════════════════════════════
router.get('/medicamentos/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('medicamentos').select('*').eq('user_id', req._user.id).order('nome');
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/medicamentos', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const payload = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id };
    delete payload.phone;
    const { data, error } = await supabase.from('medicamentos').insert(payload).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/medicamentos/:id', auth, requireGrow, async (req, res) => {
  try {
    const patch = { ...req.body }; delete patch.phone;
    const { data, error } = await supabase.from('medicamentos').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/medicamentos/:id', auth, requireGrow, async (req, res) => {
  try { await supabase.from('medicamentos').delete().eq('id', req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/medicamentos/:id/tomar', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const { data: med } = await supabase.from('medicamentos').select('estoque_atual').eq('id', req.params.id).maybeSingle();
    await supabase.from('medicamento_doses').insert({
      medicamento_id: req.params.id, user_id: u.id,
      datetime_planejado: req.body?.datetime_planejado || null,
      status: 'tomou',
    });
    if (med?.estoque_atual != null && med.estoque_atual > 0) {
      await supabase.from('medicamentos').update({ estoque_atual: med.estoque_atual - 1 }).eq('id', req.params.id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/medicamentos/:id/doses', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('medicamento_doses').select('*').eq('medicamento_id', req.params.id).order('datetime_tomado', { ascending: false }).limit(60);
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// MEDIDAS CORPORAIS
// ═════════════════════════════════════════════════════════════════
router.get('/medidas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('medidas_corporais').select('*').eq('user_id', req._user.id).order('data', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/medidas', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const payload = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id };
    delete payload.phone;
    const { data, error } = await supabase.from('medidas_corporais').insert(payload).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// FOTOS DE PROGRESSO
// ═════════════════════════════════════════════════════════════════
router.get('/fotos/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('fotos_progresso').select('*').eq('user_id', req._user.id).order('data', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/fotos', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const payload = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id };
    delete payload.phone;
    const { data, error } = await supabase.from('fotos_progresso').insert(payload).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// SINTOMAS / VACINAS / CICLO
// ═════════════════════════════════════════════════════════════════
router.get('/sintomas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { dias } = req.query;
    const ini = new Date(Date.now() - (parseInt(dias) || 60) * 86400000).toISOString().slice(0,10);
    const { data } = await supabase.from('sintomas').select('*').eq('user_id', req._user.id).gte('data', ini).order('data', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/sintomas', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const payload = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id };
    delete payload.phone;
    const { data, error } = await supabase.from('sintomas').insert(payload).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/vacinas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('vacinas').select('*').eq('user_id', req._user.id).order('data_aplicacao', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/vacinas', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const payload = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id };
    delete payload.phone;
    const { data, error } = await supabase.from('vacinas').insert(payload).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/ciclo/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('ciclo_menstrual').select('*').eq('user_id', req._user.id).order('data_inicio', { ascending: false }).limit(24);
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/ciclo', auth, requireGrow, async (req, res) => {
  try {
    const u = req._user;
    const payload = { ...req.body, grupo_id: u.grupo_ativo, user_id: u.id };
    delete payload.phone;
    const { data, error } = await supabase.from('ciclo_menstrual').insert(payload).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
