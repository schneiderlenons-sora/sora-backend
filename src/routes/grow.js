const express = require('express');
const router  = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const norm = p => p?.replace(/\D/g, '');

async function getUser(phone) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo, plano, plano_grow, grow_trial_inicio, grow_trial_fim, painel_ativo')
    .eq('phone', norm(phone)).maybeSingle();
  return data;
}

function temAcessoGrow(user) {
  if (!user) return false;
  if (user.plano === 'black') return true;
  if (['grow_basico','grow_premium'].includes(user.plano_grow)) return true;
  if (user.plano_grow === 'trial' && user.grow_trial_fim && new Date(user.grow_trial_fim) > new Date()) return true;
  return false;
}

async function requireGrow(req, res, next) {
  const phone = req.params.phone || req.body.phone || req.query.phone;
  if (!phone) return res.status(400).json({ erro: 'phone obrigatorio' });
  const user = await getUser(phone);
  if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });
  if (!temAcessoGrow(user)) return res.status(403).json({ erro: 'sem_acesso_grow', mensagem: 'Acesso ao Sora Grow indisponivel no seu plano.' });
  req.userRow = user;
  next();
}

// ─── STATUS ──────────────────────────────────────────────────────────
router.get('/status/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });
    const agora = new Date();
    const diasTrial = user.grow_trial_fim
      ? Math.max(0, Math.ceil((new Date(user.grow_trial_fim) - agora) / 86400000)) : 0;
    res.json({
      temAcesso: temAcessoGrow(user),
      plano: user.plano,
      planoGrow: user.plano_grow,
      painelAtivo: user.painel_ativo || 'finance',
      trial: {
        ativo: user.plano_grow === 'trial' && diasTrial > 0,
        diasRestantes: diasTrial,
        inicio: user.grow_trial_inicio,
        fim: user.grow_trial_fim,
      },
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/ativar-trial/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });
    // Premium e Black JÁ incluem o Sora Grow — o trial de 7 dias é do Básico.
    if (['premium','black'].includes(user.plano))
      return res.status(400).json({ erro: 'Seu plano ja inclui o Sora Grow.' });
    if (user.plano_grow !== 'sem_acesso')
      return res.status(400).json({ erro: 'Trial ja utilizado ou voce ja tem acesso' });
    const inicio = new Date();
    const fim    = new Date(inicio.getTime() + 7 * 86400000);
    await supabase.from('users').update({
      plano_grow: 'trial',
      grow_trial_inicio: inicio.toISOString(),
      grow_trial_fim:    fim.toISOString(),
      painel_ativo:      'grow',
    }).eq('phone', norm(req.params.phone));
    res.json({ ok: true, fim: fim.toISOString(), diasRestantes: 7 });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/trocar-painel/:phone', auth, async (req, res) => {
  try {
    const { painel } = req.body;
    if (!['finance','grow'].includes(painel)) return res.status(400).json({ erro: 'Painel invalido' });
    await supabase.from('users').update({ painel_ativo: painel }).eq('phone', norm(req.params.phone));
    res.json({ ok: true, painelAtivo: painel });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── HABITOS ─────────────────────────────────────────────────────────
router.get('/habitos/:phone', auth, requireGrow, async (req, res) => {
  try {
    const dias = parseInt(req.query.dias) || 120;
    const incluirArquivados = req.query.incluir_arquivados === 'true';
    const inicio = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
    let qh = supabase.from('habitos').select('*').eq('grupo_id', req.userRow.grupo_ativo);
    if (!incluirArquivados) qh = qh.eq('ativo', true);
    qh = qh.order('ordem', { ascending: true }).order('created_at', { ascending: true });
    const { data: habitos } = await qh;
    const { data: registros } = await supabase.from('registros_habito')
      .select('habito_id, data, concluido')
      .eq('grupo_id', req.userRow.grupo_ativo).gte('data', inicio);
    // Lembrete buscado à parte e tolerante: se a migration 031 ainda não
    // rodou, as colunas não existem → data vem null e devolvemos o default
    // sem derrubar a listagem de hábitos.
    let lembrete = { ativo: false, horario: null };
    const { data: u } = await supabase.from('users')
      .select('habito_lembrete_ativo, habito_lembrete_horario')
      .eq('id', req.userRow.id).maybeSingle();
    if (u) lembrete = { ativo: !!u.habito_lembrete_ativo, horario: u.habito_lembrete_horario || null };
    res.json({ habitos: habitos || [], registros: registros || [], lembrete });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Liga/desliga o lembrete diário de hábitos (opt-in) + horário (HH:MM, fuso SP).
// Registrada ANTES de PUT /habitos/:id pra não cair na rota de :id.
router.post('/habitos/lembrete', auth, requireGrow, async (req, res) => {
  try {
    const { ativo, horario } = req.body;
    const patch = { habito_lembrete_ativo: !!ativo };
    if (horario !== undefined) {
      patch.habito_lembrete_horario = horario && /^\d{1,2}:\d{2}$/.test(horario) ? horario : null;
    }
    // Ao reativar/atualizar, zera o dedup pra poder enviar hoje ainda.
    patch.habito_lembrete_ultimo = null;
    const { error } = await supabase.from('users').update(patch).eq('id', req.userRow.id);
    if (error) {
      return res.status(503).json({ erro: 'Lembrete indisponível: rode a migration 031 no Supabase.' });
    }
    res.json({
      ok: true,
      lembrete: {
        ativo: patch.habito_lembrete_ativo,
        horario: patch.habito_lembrete_horario !== undefined ? patch.habito_lembrete_horario : null,
      },
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/habitos', auth, requireGrow, async (req, res) => {
  try {
    const { nome, descricao, icone, cor, frequencia, dias_semana, horario_lembrete, motivo, tipo, ordem } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatorio' });
    const { data } = await supabase.from('habitos').insert({
      grupo_id: req.userRow.grupo_ativo,
      nome: nome.trim(), descricao, icone: icone || '🎯', cor: cor || '#7c3aed',
      frequencia: frequencia || 'diario',
      dias_semana: dias_semana || [1,2,3,4,5,6,7],
      horario_lembrete: horario_lembrete || null,
      motivo: motivo || null,
      tipo: tipo || 'construir',
      ordem: ordem ?? 0,
    }).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/habitos/:id', auth, requireGrow, async (req, res) => {
  try {
    const allowed = ['nome','descricao','icone','cor','frequencia','dias_semana','horario_lembrete','ativo','motivo','tipo','ordem'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data } = await supabase.from('habitos').update(patch).eq('id', req.params.id).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/habitos/reordenar', auth, requireGrow, async (req, res) => {
  try {
    const { ordens } = req.body;
    if (!Array.isArray(ordens)) return res.status(400).json({ erro: 'ordens deve ser array de {id, ordem}' });
    await Promise.all(ordens.map((o) =>
      supabase.from('habitos').update({ ordem: o.ordem }).eq('id', o.id).eq('grupo_id', req.userRow.grupo_ativo)
    ));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/habitos/:id', auth, requireGrow, async (req, res) => {
  try {
    await supabase.from('habitos').update({ ativo: false }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/habitos/:id/toggle', auth, requireGrow, async (req, res) => {
  try {
    const { data: hoje } = req.body;
    const dataReg = data_req(hoje);
    const { data: existing } = await supabase.from('registros_habito')
      .select('id, concluido').eq('habito_id', req.params.id).eq('data', dataReg).maybeSingle();
    if (existing) {
      const { data: upd } = await supabase.from('registros_habito')
        .update({ concluido: !existing.concluido }).eq('id', existing.id).select().single();
      return res.json(upd);
    }
    const { data: novo } = await supabase.from('registros_habito').insert({
      habito_id: req.params.id, grupo_id: req.userRow.grupo_ativo, data: dataReg, concluido: true,
    }).select().single();
    res.json(novo);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
function data_req(v) { return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date().toISOString().slice(0, 10); }

// ─── TAREFAS ─────────────────────────────────────────────────────────
router.get('/tarefas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { concluida, projeto_id, prioridade } = req.query;
    let q = supabase.from('tarefas').select('*, projetos(nome,cor,icone)')
      .eq('grupo_id', req.userRow.grupo_ativo).order('created_at', { ascending: false });
    if (concluida !== undefined) q = q.eq('concluida', concluida === 'true');
    if (projeto_id) q = q.eq('projeto_id', projeto_id);
    if (prioridade) q = q.eq('prioridade', prioridade);
    const { data } = await q;
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/tarefas', auth, requireGrow, async (req, res) => {
  try {
    const { titulo, descricao, prioridade, data_vencimento, recorrente, projeto_id, tags, status_kanban } = req.body;
    if (!titulo?.trim()) return res.status(400).json({ erro: 'Titulo obrigatorio' });
    const { data } = await supabase.from('tarefas').insert({
      grupo_id: req.userRow.grupo_ativo, titulo: titulo.trim(), descricao,
      prioridade: prioridade || 'media',
      data_vencimento: data_vencimento || null,
      recorrente: !!recorrente, projeto_id: projeto_id || null,
      tags: tags || null, status_kanban: status_kanban || 'a_fazer',
      criado_por: req.userRow.id,
    }).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/tarefas/:id', auth, requireGrow, async (req, res) => {
  try {
    const allowed = ['titulo','descricao','concluida','prioridade','data_vencimento','projeto_id','tags','status_kanban'];
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if ('concluida' in req.body && req.body.concluida === true) patch.status_kanban = 'concluida';
    const { data } = await supabase.from('tarefas').update(patch).eq('id', req.params.id).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/tarefas/:id', auth, requireGrow, async (req, res) => {
  try {
    await supabase.from('tarefas').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── PROJETOS ────────────────────────────────────────────────────────
router.get('/projetos/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('projetos').select('*').eq('grupo_id', req.userRow.grupo_ativo).order('created_at');
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/projetos', auth, requireGrow, async (req, res) => {
  try {
    const { nome, descricao, cor, icone, data_prazo } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatorio' });
    const { data } = await supabase.from('projetos').insert({
      grupo_id: req.userRow.grupo_ativo, nome: nome.trim(), descricao,
      cor: cor || '#7c3aed', icone: icone || '📋', data_prazo: data_prazo || null,
    }).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/projetos/:id', auth, requireGrow, async (req, res) => {
  try {
    await supabase.from('projetos').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── HUMOR / BEM-ESTAR ───────────────────────────────────────────────
router.get('/humor/:phone', auth, requireGrow, async (req, res) => {
  try {
    const dias = parseInt(req.query.dias) || 30;
    const inicio = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
    const { data } = await supabase.from('registros_humor')
      .select('*').eq('grupo_id', req.userRow.grupo_ativo)
      .gte('data', inicio).order('data', { ascending: true });
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/humor', auth, requireGrow, async (req, res) => {
  try {
    const { humor, nota, gratidao, energia, sono_horas, data } = req.body;
    if (!humor || humor < 1 || humor > 5) return res.status(400).json({ erro: 'Humor 1-5 obrigatorio' });
    const reg = data_req(data);
    const { data: r } = await supabase.from('registros_humor').upsert({
      grupo_id: req.userRow.grupo_ativo, user_id: req.userRow.id, data: reg,
      humor: parseInt(humor),
      nota: nota || null,
      gratidao: gratidao && gratidao.length ? gratidao : null,
      energia: energia ? parseInt(energia) : null,
      sono_horas: sono_horas ? parseFloat(sono_horas) : null,
    }, { onConflict: 'grupo_id,user_id,data' }).select().single();
    res.json(r);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── LISTA DE COMPRAS ────────────────────────────────────────────────
async function getOrCreateLista(grupoId) {
  const { data: existing } = await supabase.from('listas_compras')
    .select('id').eq('grupo_id', grupoId).eq('ativa', true).maybeSingle();
  if (existing) return existing.id;
  const { data: novo } = await supabase.from('listas_compras')
    .insert({ grupo_id: grupoId }).select('id').single();
  return novo.id;
}

router.get('/lista-compras/:phone', auth, requireGrow, async (req, res) => {
  try {
    const listaId = await getOrCreateLista(req.userRow.grupo_ativo);
    const { data: itens } = await supabase.from('itens_lista_compras')
      .select('*').eq('lista_id', listaId).order('created_at', { ascending: false });
    res.json({ lista_id: listaId, itens: itens || [] });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/lista-compras/item', auth, requireGrow, async (req, res) => {
  try {
    const { nome, quantidade, unidade, categoria, preco_estimado } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatorio' });
    const listaId = await getOrCreateLista(req.userRow.grupo_ativo);
    const { data } = await supabase.from('itens_lista_compras').insert({
      lista_id: listaId, nome: nome.trim(),
      quantidade: quantidade || '1', unidade: unidade || null,
      categoria: categoria || null,
      preco_estimado: preco_estimado ? parseFloat(preco_estimado) : null,
    }).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.patch('/lista-compras/item/:id', auth, requireGrow, async (req, res) => {
  try {
    const allowed = ['comprado','nome','quantidade','unidade','categoria','preco_estimado'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data } = await supabase.from('itens_lista_compras').update(patch).eq('id', req.params.id).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/lista-compras/item/:id', auth, requireGrow, async (req, res) => {
  try {
    await supabase.from('itens_lista_compras').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/lista-compras/limpar', auth, requireGrow, async (req, res) => {
  try {
    const listaId = await getOrCreateLista(req.userRow.grupo_ativo);
    await supabase.from('itens_lista_compras').delete().eq('lista_id', listaId).eq('comprado', true);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
