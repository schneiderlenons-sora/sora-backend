const express = require('express');
const router  = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { enviarTexto } = require('../services/zapi');
const norm = p => p?.replace(/\D/g, '');

async function getUser(phone) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo, plano, plano_grow, grow_trial_inicio, grow_trial_fim, painel_ativo')
    .eq('phone', norm(phone)).maybeSingle();
  return data;
}

// Acesso BASE ao Grow — todos os planos pagos (hábitos, tarefas, bem-estar,
// lista de compras, agenda).
function temAcessoGrow(user) {
  if (!user) return false;
  if (['basico', 'premium', 'black'].includes(user.plano)) return true;
  if (['grow_basico', 'grow_premium'].includes(user.plano_grow)) return true; // legado
  if (user.plano_grow === 'trial' && user.grow_trial_fim && new Date(user.grow_trial_fim) > new Date()) return true;
  return false;
}

// Grow PREMIUM — Saúde, Estudos e Casa avançada (despensa/receitas/manutenções).
function temGrowPremium(user) {
  if (!user) return false;
  if (['premium', 'black'].includes(user.plano)) return true;
  if (user.plano_grow === 'grow_premium') return true; // legado
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

// Pra rotas Premium+ do Grow (despensa, receitas, manutenções)
async function requirePremiumGrow(req, res, next) {
  const phone = req.params.phone || req.body.phone || req.query.phone;
  if (!phone) return res.status(400).json({ erro: 'phone obrigatorio' });
  const user = await getUser(phone);
  if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });
  if (!temGrowPremium(user)) return res.status(403).json({ erro: 'sem_acesso_premium', mensagem: 'Disponivel no plano Premium.' });
  req.userRow = user;
  next();
}

// ─── Privacidade / compartilhamento do Grow ──────────────────────────
// Cada linha guarda user_id (dono) + grupo_id. Abas pessoais (Hábitos,
// Tarefas, Agenda, Bem-estar) leem SEMPRE por user_id. Abas opcionais
// (Casa + Coleções) leem por grupo_id quando a flag do grupo está ligada,
// senão por user_id. Alternar a flag não migra dado — só troca o filtro.
const { growShareCfg } = require('../services/growShare');
// Aplica o filtro de leitura numa query: compartilhado→grupo_id, privado→user_id.
function escopoLeitura(query, req, compartilhado) {
  return compartilhado
    ? query.eq('grupo_id', req.userRow.grupo_ativo)
    : query.eq('user_id', req.userRow.id);
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
    let qh = supabase.from('habitos').select('*').eq('user_id', req.userRow.id);
    if (!incluirArquivados) qh = qh.eq('ativo', true);
    qh = qh.order('ordem', { ascending: true }).order('created_at', { ascending: true });
    const { data: habitos } = await qh;
    const { data: registros } = await supabase.from('registros_habito')
      .select('habito_id, data, concluido')
      .eq('user_id', req.userRow.id).gte('data', inicio);
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
    const { nome, descricao, icone, cor, frequencia, dias_semana, horario_lembrete, motivo, tipo, ordem, treino_id, treino_duracao_padrao } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatorio' });
    const insert = {
      grupo_id: req.userRow.grupo_ativo, user_id: req.userRow.id,
      nome: nome.trim(), descricao, icone: icone || '🎯', cor: cor || '#7c3aed',
      frequencia: frequencia || 'diario',
      dias_semana: dias_semana || [1,2,3,4,5,6,7],
      horario_lembrete: horario_lembrete || null,
      motivo: motivo || null,
      tipo: tipo || 'construir',
      ordem: ordem ?? 0,
    };
    // Só inclui os campos de treino quando vier um vínculo — assim hábitos
    // normais continuam sendo criados mesmo se a migration 045 não rodou.
    if (treino_id) {
      insert.treino_id = treino_id;
      insert.treino_duracao_padrao = treino_duracao_padrao ?? null;
    }
    const { data, error } = await supabase.from('habitos').insert(insert).select().single();
    if (error) {
      console.error('❌ POST /habitos:', error.message);
      // Coluna faltando → migration 015 (motivo/tipo/ordem) não rodou.
      const faltaCol = /column .* does not exist|could not find/i.test(error.message);
      const migr = treino_id ? '045' : '015';
      return res.status(faltaCol ? 503 : 500).json({
        erro: faltaCol ? `Falta rodar a migration ${migr} no Supabase. (${error.message})` : error.message,
      });
    }
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/habitos/:id', auth, requireGrow, async (req, res) => {
  try {
    const allowed = ['nome','descricao','icone','cor','frequencia','dias_semana','horario_lembrete','ativo','motivo','tipo','ordem','treino_id','treino_duracao_padrao'];
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
      supabase.from('habitos').update({ ordem: o.ordem }).eq('id', o.id).eq('user_id', req.userRow.id)
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
    let resultado, concluido;
    if (existing) {
      concluido = !existing.concluido;
      const { data: upd } = await supabase.from('registros_habito')
        .update({ concluido }).eq('id', existing.id).select().single();
      resultado = upd;
    } else {
      concluido = true;
      const { data: novo } = await supabase.from('registros_habito').insert({
        habito_id: req.params.id, grupo_id: req.userRow.grupo_ativo, user_id: req.userRow.id, data: dataReg, concluido: true,
      }).select().single();
      resultado = novo;
    }
    // Hábito vinculado a treino → reflete o check na aba Treinos.
    // Tolerante: se a migration 045 não rodou, ignora sem quebrar o toggle.
    await sincronizarTreinoDoHabito(req.params.id, req.userRow, dataReg, concluido).catch(() => {});
    res.json(resultado);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
function data_req(v) { return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date().toISOString().slice(0, 10); }

// Sync hábito → treino. Checar cria a sessão do dia (origem 'habito') com a
// duração padrão; desmarcar remove só essa sessão auto-criada (nunca uma
// sessão detalhada digitada à mão). Se já existe QUALQUER sessão no dia, não duplica.
async function sincronizarTreinoDoHabito(habitoId, userRow, dataReg, concluido) {
  const { data: h } = await supabase.from('habitos')
    .select('treino_id, treino_duracao_padrao, nome').eq('id', habitoId).maybeSingle();
  if (!h || !h.treino_id) return;
  if (concluido) {
    const { data: ja } = await supabase.from('treino_registros')
      .select('id').eq('user_id', userRow.id).eq('treino_id', h.treino_id).eq('data', dataReg).limit(1);
    if (ja && ja.length) return; // já há sessão (manual ou auto) — não duplica
    await supabase.from('treino_registros').insert({
      grupo_id: userRow.grupo_ativo, user_id: userRow.id,
      treino_id: h.treino_id, treino_nome: h.nome,
      data: dataReg, duracao_min: h.treino_duracao_padrao || null,
      origem: 'habito',
    });
  } else {
    await supabase.from('treino_registros').delete()
      .eq('user_id', userRow.id).eq('treino_id', h.treino_id)
      .eq('data', dataReg).eq('origem', 'habito');
  }
}

// ─── TAREFAS ─────────────────────────────────────────────────────────
router.get('/tarefas/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { concluida, projeto_id, prioridade } = req.query;
    let q = supabase.from('tarefas').select('*, projetos(nome,cor,icone)')
      .eq('user_id', req.userRow.id).order('created_at', { ascending: false });
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
      grupo_id: req.userRow.grupo_ativo, user_id: req.userRow.id, titulo: titulo.trim(), descricao,
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
    const { data } = await supabase.from('projetos').select('*').eq('user_id', req.userRow.id).order('created_at');
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/projetos', auth, requireGrow, async (req, res) => {
  try {
    const { nome, descricao, cor, icone, data_prazo } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatorio' });
    const { data } = await supabase.from('projetos').insert({
      grupo_id: req.userRow.grupo_ativo, user_id: req.userRow.id, nome: nome.trim(), descricao,
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
      .select('*').eq('user_id', req.userRow.id)
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

router.get('/lista-compras/:phone', auth, requirePremiumGrow, async (req, res) => {
  try {
    const cfg = await growShareCfg(req.userRow.grupo_ativo);
    const listaId = await getOrCreateLista(req.userRow.grupo_ativo);
    let qi = supabase.from('itens_lista_compras').select('*').eq('lista_id', listaId);
    if (!cfg.casa) qi = qi.eq('user_id', req.userRow.id);
    const { data: itens } = await qi.order('created_at', { ascending: false });
    res.json({ lista_id: listaId, itens: itens || [] });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/lista-compras/item', auth, requirePremiumGrow, async (req, res) => {
  try {
    const { nome, quantidade, unidade, categoria, preco_estimado } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatorio' });
    const listaId = await getOrCreateLista(req.userRow.grupo_ativo);
    const { data } = await supabase.from('itens_lista_compras').insert({
      lista_id: listaId, nome: nome.trim(), user_id: req.userRow.id,
      quantidade: quantidade || '1', unidade: unidade || null,
      categoria: categoria || null,
      preco_estimado: preco_estimado ? parseFloat(preco_estimado) : null,
    }).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.patch('/lista-compras/item/:id', auth, requirePremiumGrow, async (req, res) => {
  try {
    const allowed = ['comprado','nome','quantidade','unidade','categoria','preco_estimado'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data } = await supabase.from('itens_lista_compras').update(patch).eq('id', req.params.id).select().single();
    // Loop: comprou um item que veio da despensa → repõe (volta status 'tem')
    if (data && data.despensa_item_id && patch.comprado === true) {
      await supabase.from('despensa_itens')
        .update({ status: 'tem', updated_at: new Date().toISOString() })
        .eq('id', data.despensa_item_id);
    }
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/lista-compras/item/:id', auth, requirePremiumGrow, async (req, res) => {
  try {
    await supabase.from('itens_lista_compras').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/lista-compras/limpar', auth, requirePremiumGrow, async (req, res) => {
  try {
    const cfg = await growShareCfg(req.userRow.grupo_ativo);
    const listaId = await getOrCreateLista(req.userRow.grupo_ativo);
    let qdel = supabase.from('itens_lista_compras').delete().eq('lista_id', listaId).eq('comprado', true);
    if (!cfg.casa) qdel = qdel.eq('user_id', req.userRow.id);
    await qdel;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Envia a lista de compras (itens pendentes, agrupados por categoria) pro WhatsApp
router.post('/lista-compras/enviar', auth, requirePremiumGrow, async (req, res) => {
  try {
    const phone = req.authUser?.phone;
    if (!phone) return res.status(400).json({ erro: 'Nenhum WhatsApp vinculado à sua conta.' });
    const cfg = await growShareCfg(req.userRow.grupo_ativo);
    const listaId = await getOrCreateLista(req.userRow.grupo_ativo);
    let qe = supabase.from('itens_lista_compras').select('nome, quantidade, categoria, comprado').eq('lista_id', listaId);
    if (!cfg.casa) qe = qe.eq('user_id', req.userRow.id);
    const { data: itens } = await qe;
    const pendentes = (itens || []).filter(i => !i.comprado);
    if (!pendentes.length) {
      await enviarTexto(phone, '🛒 Sua lista de compras está vazia — não há nada pendente. 🎉');
      return res.json({ ok: true, enviados: 0 });
    }
    // Agrupa por categoria
    const grupos = {};
    for (const i of pendentes) {
      const c = i.categoria || '📦 Outros';
      (grupos[c] = grupos[c] || []).push(i);
    }
    const blocos = Object.entries(grupos).map(([cat, lista]) => {
      const linhas = lista.map(i => `⬜ ${i.nome}${i.quantidade && i.quantidade !== '1' ? ` (${i.quantidade})` : ''}`);
      return `*${cat}*\n${linhas.join('\n')}`;
    });
    const msg = `🛒 *Lista de compras*\n\n${blocos.join('\n\n')}\n\n_${pendentes.length} item${pendentes.length === 1 ? '' : 's'} pra comprar_`;
    await enviarTexto(phone, msg);
    res.json({ ok: true, enviados: pendentes.length });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── DESPENSA ────────────────────────────────────────────────────────
// Mantém a lista de compras em sincronia: item "acabou"/"acabando" entra na
// lista (linkado); item que volta pra "tem" sai da lista (se ainda pendente).
async function sincronizarDespensaLista(grupoId, item) {
  const listaId = await getOrCreateLista(grupoId);
  const { data: pendente } = await supabase.from('itens_lista_compras')
    .select('id').eq('lista_id', listaId).eq('despensa_item_id', item.id)
    .eq('comprado', false).maybeSingle();

  if (item.status === 'acabou' || item.status === 'acabando') {
    if (!pendente) {
      await supabase.from('itens_lista_compras').insert({
        lista_id: listaId, nome: item.nome, user_id: item.user_id || null,
        quantidade: item.quantidade_ideal || '1', unidade: item.unidade || null,
        categoria: item.categoria || null, despensa_item_id: item.id,
      });
    }
  } else if (pendente) {
    // status 'tem' → foi reposto, remove da lista o item ainda não comprado
    await supabase.from('itens_lista_compras').delete().eq('id', pendente.id);
  }
}

router.get('/despensa/:phone', auth, requirePremiumGrow, async (req, res) => {
  try {
    const cfg = await growShareCfg(req.userRow.grupo_ativo);
    const { data } = await escopoLeitura(supabase.from('despensa_itens').select('*'), req, cfg.casa)
      .order('created_at', { ascending: false });
    res.json({ itens: data || [] });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/despensa', auth, requirePremiumGrow, async (req, res) => {
  try {
    const { nome, categoria, status, quantidade_ideal, unidade } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatorio' });
    const st = ['tem','acabando','acabou'].includes(status) ? status : 'tem';
    const { data, error } = await supabase.from('despensa_itens').insert({
      grupo_id: req.userRow.grupo_ativo, user_id: req.userRow.id, nome: nome.trim(),
      categoria: categoria || null, status: st,
      quantidade_ideal: quantidade_ideal || null, unidade: unidade || null,
    }).select().single();
    if (error) return res.status(500).json({ erro: error.message });
    if (st !== 'tem') await sincronizarDespensaLista(req.userRow.grupo_ativo, data);
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/despensa/:id', auth, requirePremiumGrow, async (req, res) => {
  try {
    const allowed = ['nome','categoria','status','quantidade_ideal','unidade'];
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if (patch.status && !['tem','acabando','acabou'].includes(patch.status))
      return res.status(400).json({ erro: 'status invalido' });
    const { data, error } = await supabase.from('despensa_itens')
      .update(patch).eq('id', req.params.id).eq('grupo_id', req.userRow.grupo_ativo)
      .select().single();
    if (error || !data) return res.status(404).json({ erro: 'Item nao encontrado' });
    if ('status' in patch) await sincronizarDespensaLista(req.userRow.grupo_ativo, data);
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/despensa/:id', auth, requirePremiumGrow, async (req, res) => {
  try {
    await supabase.from('despensa_itens').delete()
      .eq('id', req.params.id).eq('grupo_id', req.userRow.grupo_ativo);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── MANUTENÇÕES ─────────────────────────────────────────────────────
router.get('/manutencoes/:phone', auth, requirePremiumGrow, async (req, res) => {
  try {
    const cfg = await growShareCfg(req.userRow.grupo_ativo);
    const { data } = await escopoLeitura(supabase.from('manutencoes').select('*'), req, cfg.casa)
      .order('created_at', { ascending: false });
    res.json({ itens: data || [] });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/manutencoes', auth, requirePremiumGrow, async (req, res) => {
  try {
    const { nome, icone, frequencia_dias, ultima_data, observacao, lembrete_ativo } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatorio' });
    const freq = parseInt(frequencia_dias);
    const { data, error } = await supabase.from('manutencoes').insert({
      grupo_id: req.userRow.grupo_ativo, user_id: req.userRow.id, nome: nome.trim(),
      icone: icone || '🔧',
      frequencia_dias: freq > 0 ? freq : 90,
      ultima_data: ultima_data || null,
      observacao: observacao || null,
      lembrete_ativo: !!lembrete_ativo,
    }).select().single();
    if (error) return res.status(500).json({ erro: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/manutencoes/:id', auth, requirePremiumGrow, async (req, res) => {
  try {
    const allowed = ['nome','icone','frequencia_dias','ultima_data','observacao','lembrete_ativo'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if ('frequencia_dias' in patch) patch.frequencia_dias = parseInt(patch.frequencia_dias) || 90;
    if ('lembrete_ativo' in patch) patch.lembrete_ultimo = null; // reabilita o aviso
    const { data, error } = await supabase.from('manutencoes')
      .update(patch).eq('id', req.params.id).eq('grupo_id', req.userRow.grupo_ativo)
      .select().single();
    if (error || !data) return res.status(404).json({ erro: 'Manutencao nao encontrada' });
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Marca como feita hoje → recalcula a próxima e zera o dedup do lembrete
router.post('/manutencoes/:id/feito', auth, requirePremiumGrow, async (req, res) => {
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase.from('manutencoes')
      .update({ ultima_data: req.body.data || hoje, lembrete_ultimo: null })
      .eq('id', req.params.id).eq('grupo_id', req.userRow.grupo_ativo)
      .select().single();
    if (error || !data) return res.status(404).json({ erro: 'Manutencao nao encontrada' });
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/manutencoes/:id', auth, requirePremiumGrow, async (req, res) => {
  try {
    await supabase.from('manutencoes').delete()
      .eq('id', req.params.id).eq('grupo_id', req.userRow.grupo_ativo);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── RECEITAS ────────────────────────────────────────────────────────
// Cada receita carrega seus ingredientes embutidos. "Cozinhar" cruza os
// ingredientes com a despensa e manda o que falta pra lista de compras.
async function ingredientesDe(receitaIds) {
  if (!receitaIds.length) return [];
  const { data } = await supabase.from('receita_ingredientes')
    .select('*').in('receita_id', receitaIds).order('ordem');
  return data || [];
}

router.get('/receitas/:phone', auth, requirePremiumGrow, async (req, res) => {
  try {
    const cfg = await growShareCfg(req.userRow.grupo_ativo);
    const { data: receitas } = await escopoLeitura(supabase.from('receitas').select('*'), req, cfg.casa)
      .order('created_at', { ascending: false });
    const ings = await ingredientesDe((receitas || []).map(r => r.id));
    const itens = (receitas || []).map(r => ({
      ...r, ingredientes: ings.filter(i => i.receita_id === r.id),
    }));
    res.json({ itens });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/receitas', auth, requirePremiumGrow, async (req, res) => {
  try {
    const { nome, icone, porcoes, tempo_min, modo_preparo, ingredientes } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatorio' });
    const { data: receita, error } = await supabase.from('receitas').insert({
      grupo_id: req.userRow.grupo_ativo, user_id: req.userRow.id, nome: nome.trim(), icone: icone || '🍳',
      porcoes: porcoes ? parseInt(porcoes) : null,
      tempo_min: tempo_min ? parseInt(tempo_min) : null,
      modo_preparo: modo_preparo || null,
    }).select().single();
    if (error) return res.status(500).json({ erro: error.message });
    const ings = Array.isArray(ingredientes) ? ingredientes.filter(i => i?.nome?.trim()) : [];
    if (ings.length) {
      await supabase.from('receita_ingredientes').insert(ings.map((i, idx) => ({
        receita_id: receita.id, nome: i.nome.trim(),
        quantidade: i.quantidade || null, categoria: i.categoria || null, ordem: idx,
      })));
    }
    res.json({ ...receita, ingredientes: await ingredientesDe([receita.id]) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/receitas/:id', auth, requirePremiumGrow, async (req, res) => {
  try {
    const allowed = ['nome', 'icone', 'porcoes', 'tempo_min', 'modo_preparo'];
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if ('porcoes' in patch)   patch.porcoes   = patch.porcoes ? parseInt(patch.porcoes) : null;
    if ('tempo_min' in patch) patch.tempo_min = patch.tempo_min ? parseInt(patch.tempo_min) : null;
    const { data: receita, error } = await supabase.from('receitas')
      .update(patch).eq('id', req.params.id).eq('grupo_id', req.userRow.grupo_ativo)
      .select().single();
    if (error || !receita) return res.status(404).json({ erro: 'Receita nao encontrada' });
    // Substitui ingredientes inteiros quando vierem no body
    if (Array.isArray(req.body.ingredientes)) {
      await supabase.from('receita_ingredientes').delete().eq('receita_id', receita.id);
      const ings = req.body.ingredientes.filter(i => i?.nome?.trim());
      if (ings.length) {
        await supabase.from('receita_ingredientes').insert(ings.map((i, idx) => ({
          receita_id: receita.id, nome: i.nome.trim(),
          quantidade: i.quantidade || null, categoria: i.categoria || null, ordem: idx,
        })));
      }
    }
    res.json({ ...receita, ingredientes: await ingredientesDe([receita.id]) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/receitas/:id', auth, requirePremiumGrow, async (req, res) => {
  try {
    await supabase.from('receitas').delete()
      .eq('id', req.params.id).eq('grupo_id', req.userRow.grupo_ativo);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Cozinhar: o que falta (não está 'tem' na despensa) vai pra lista de compras
router.post('/receitas/:id/cozinhar', auth, requirePremiumGrow, async (req, res) => {
  try {
    const grupoId = req.userRow.grupo_ativo;
    const cfg = await growShareCfg(grupoId);
    const { data: receita } = await supabase.from('receitas')
      .select('id, nome').eq('id', req.params.id).eq('grupo_id', grupoId).maybeSingle();
    if (!receita) return res.status(404).json({ erro: 'Receita nao encontrada' });
    const ings = await ingredientesDe([receita.id]);
    if (!ings.length) return res.json({ ok: true, receita: receita.nome, adicionados: [], jaTem: [] });

    const { data: despensa } = await escopoLeitura(
      supabase.from('despensa_itens').select('id, nome, status'), req, cfg.casa);
    const acha = nome => (despensa || []).find(d => {
      const a = d.nome.toLowerCase(), b = nome.toLowerCase();
      return a.includes(b) || b.includes(a);
    });

    const listaId = await getOrCreateLista(grupoId);
    const adicionados = [], jaTem = [];
    for (const ing of ings) {
      const match = acha(ing.nome);
      if (match && match.status === 'tem') { jaTem.push(ing.nome); continue; }
      let qd = supabase.from('itens_lista_compras')
        .select('id').eq('lista_id', listaId).ilike('nome', ing.nome).eq('comprado', false);
      if (!cfg.casa) qd = qd.eq('user_id', req.userRow.id);
      const { data: dup } = await qd.maybeSingle();
      if (!dup) {
        await supabase.from('itens_lista_compras').insert({
          lista_id: listaId, nome: ing.nome, quantidade: ing.quantidade || '1', user_id: req.userRow.id,
          categoria: ing.categoria || null, despensa_item_id: match ? match.id : null,
        });
      }
      adicionados.push(ing.nome);
    }
    res.json({ ok: true, receita: receita.nome, adicionados, jaTem });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── AGENDA / COMPROMISSOS ───────────────────────────────────────────
const CATS_COMP = ['pessoal', 'trabalho', 'familia', 'saude', 'financas', 'estudos', 'outro'];

router.get('/compromissos/:phone', auth, requireGrow, async (req, res) => {
  try {
    let q = supabase.from('compromissos')
      .select('*').eq('user_id', req.userRow.id);
    if (req.query.de)  q = q.gte('data', req.query.de);
    if (req.query.ate) q = q.lte('data', req.query.ate);
    const { data } = await q.order('data', { ascending: true }).order('hora', { ascending: true, nullsFirst: true });
    res.json({ itens: data || [] });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/compromissos', auth, requireGrow, async (req, res) => {
  try {
    const { titulo, descricao, data, hora, local, categoria, cor, lembrete_ativo, lembrete_antecedencia } = req.body;
    if (!titulo?.trim()) return res.status(400).json({ erro: 'Titulo obrigatorio' });
    if (!data)           return res.status(400).json({ erro: 'Data obrigatoria' });
    const { data: novo, error } = await supabase.from('compromissos').insert({
      grupo_id: req.userRow.grupo_ativo, user_id: req.userRow.id, titulo: titulo.trim(),
      descricao: descricao || null, data, hora: hora || null, local: local || null,
      categoria: CATS_COMP.includes(categoria) ? categoria : 'pessoal',
      cor: cor || '#7c3aed',
      lembrete_ativo: !!lembrete_ativo,
      lembrete_antecedencia: Number.isInteger(lembrete_antecedencia) ? lembrete_antecedencia : 60,
    }).select().single();
    if (error) return res.status(500).json({ erro: error.message });
    res.json(novo);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/compromissos/:id', auth, requireGrow, async (req, res) => {
  try {
    const allowed = ['titulo', 'descricao', 'data', 'hora', 'local', 'categoria', 'cor', 'lembrete_ativo', 'lembrete_antecedencia'];
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if ('categoria' in patch && !CATS_COMP.includes(patch.categoria)) patch.categoria = 'pessoal';
    // Mexeu em data/hora/lembrete → reabilita o disparo do aviso
    if ('data' in patch || 'hora' in patch || 'lembrete_ativo' in patch || 'lembrete_antecedencia' in patch) {
      patch.lembrete_enviado = false;
    }
    const { data, error } = await supabase.from('compromissos')
      .update(patch).eq('id', req.params.id).eq('user_id', req.userRow.id)
      .select().single();
    if (error || !data) return res.status(404).json({ erro: 'Compromisso nao encontrado' });
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/compromissos/:id', auth, requireGrow, async (req, res) => {
  try {
    await supabase.from('compromissos').delete()
      .eq('id', req.params.id).eq('user_id', req.userRow.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── AGENDA: FEED UNIFICADO (Fase 2 — agregador) ─────────────────────
// Lógica em src/services/agendaFeed.js (reutilizada pelo briefing matinal).
const { montarFeed, isoLocal } = require('../services/agendaFeed');

router.get('/agenda/feed/:phone', auth, requireGrow, async (req, res) => {
  try {
    const hoje = new Date();
    const de  = req.query.de  || isoLocal(new Date(hoje.getTime() - 31 * 86400000));
    const ate = req.query.ate || isoLocal(new Date(hoje.getTime() + 180 * 86400000));
    const cfg = await growShareCfg(req.userRow.grupo_ativo);
    const eventos = await montarFeed(req.userRow.grupo_ativo, de, ate, { userId: req.userRow.id, casaCompartilhada: cfg.casa, incluirTransacoes: true });
    res.json({ eventos });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── AGENDA: briefing matinal (opt-in) ───────────────────────────────
// Lê/grava de forma tolerante: se a migration 036 não rodou, não quebra.
router.get('/agenda/briefing/:phone', auth, requireGrow, async (req, res) => {
  try {
    const { data } = await supabase.from('users')
      .select('agenda_briefing_ativo, agenda_briefing_horario')
      .eq('id', req.userRow.id).maybeSingle();
    res.json({ ativo: !!data?.agenda_briefing_ativo, horario: data?.agenda_briefing_horario || '07:00' });
  } catch {
    res.json({ ativo: false, horario: '07:00' });
  }
});

router.post('/agenda/briefing', auth, requireGrow, async (req, res) => {
  try {
    const patch = {};
    if ('ativo' in req.body)   patch.agenda_briefing_ativo = !!req.body.ativo;
    if ('horario' in req.body && /^\d{2}:\d{2}$/.test(req.body.horario)) patch.agenda_briefing_horario = req.body.horario;
    if (patch.agenda_briefing_ativo) patch.agenda_briefing_ultimo = null; // reabilita pra hoje
    const { error } = await supabase.from('users').update(patch).eq('id', req.userRow.id);
    if (error) return res.status(503).json({ erro: 'Briefing indisponível: rode a migration 036 no Supabase.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────
// COLEÇÕES DO GROW — Viagens, Bucket list, Mídia (filmes/séries), Leituras.
// CRUD genérico (base do Grow, todos os planos pagos). Migration 038.
// ─────────────────────────────────────────────────────────────────────
// `flag` = chave em growShareCfg que decide se a coleção é compartilhada
// (bucket_list compartilha a flag de viagens — são a mesma aba no app).
function crudColecao(tabela, campos, obrigatorio, flag) {
  router.get(`/${tabela}/:phone`, auth, requirePremiumGrow, async (req, res) => {
    try {
      const cfg = await growShareCfg(req.userRow.grupo_ativo);
      const { data, error } = await escopoLeitura(supabase.from(tabela).select('*'), req, !!cfg[flag])
        .order('created_at', { ascending: false });
      if (error) return res.status(503).json({ erro: `Coleção indisponível: rode a migration 038. (${error.message})` });
      res.json(data || []);
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  router.post(`/${tabela}`, auth, requirePremiumGrow, async (req, res) => {
    try {
      if (obrigatorio && !String(req.body[obrigatorio] ?? '').trim())
        return res.status(400).json({ erro: `${obrigatorio} obrigatório` });
      const ins = { grupo_id: req.userRow.grupo_ativo, user_id: req.userRow.id };
      for (const k of campos) if (k in req.body) ins[k] = req.body[k];
      const { data, error } = await supabase.from(tabela).insert(ins).select().single();
      if (error) return res.status(500).json({ erro: error.message });
      res.json(data);
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  router.put(`/${tabela}/:id`, auth, requirePremiumGrow, async (req, res) => {
    try {
      const patch = {};
      for (const k of campos) if (k in req.body) patch[k] = req.body[k];
      const { data, error } = await supabase.from(tabela).update(patch).eq('id', req.params.id).select().single();
      if (error) return res.status(500).json({ erro: error.message });
      res.json(data);
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  router.delete(`/${tabela}/:id`, auth, requirePremiumGrow, async (req, res) => {
    try {
      await supabase.from(tabela).delete().eq('id', req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
}

crudColecao('viagens',     ['destino','emoji','data_inicio','data_fim','orcamento','status','notas','checklist','cover_url'], 'destino', 'viagens');
crudColecao('bucket_list', ['titulo','categoria','emoji','status','notas'], 'titulo', 'viagens');
crudColecao('midia',       ['titulo','tipo','status','nota','cover_url','genero','ano','comentario','favorito'], 'titulo', 'midia');
crudColecao('leituras',    ['titulo','autor','status','nota','cover_url','total_paginas','pagina_atual','genero','comentario','favorito'], 'titulo', 'leituras');

// ─── COMPARTILHAMENTO DO GROW (toggles por aba, por grupo) ───────────
// Abas opcionais: Casa + Coleções. Hábitos/Saúde/Tarefas/Agenda são sempre
// privados (sem flag). Só admin do grupo altera; o estado é por grupo.
const SHARE_ABAS = {
  casa:     'grow_compartilha_casa',
  viagens:  'grow_compartilha_viagens',
  midia:    'grow_compartilha_midia',
  leituras: 'grow_compartilha_leituras',
};

router.get('/share-config/:phone', auth, requireGrow, async (req, res) => {
  try {
    const grupoId = req.userRow.grupo_ativo;
    const cfg = await growShareCfg(grupoId);
    // quantos membros + se sou admin (compartilhar só faz sentido com 2+)
    const { data: membros } = await supabase.from('grupo_membros')
      .select('user_id, papel').eq('grupo_id', grupoId);
    const eu = (membros || []).find(m => m.user_id === req.userRow.id);
    res.json({
      config: cfg,
      totalMembros: (membros || []).length || 1,
      isAdmin: eu ? eu.papel === 'admin' : true, // grupo pessoal sem linha de membro → trata como admin
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/share-config', auth, requireGrow, async (req, res) => {
  try {
    const { aba, valor } = req.body;
    const coluna = SHARE_ABAS[aba];
    if (!coluna) return res.status(400).json({ erro: 'aba invalida' });
    const grupoId = req.userRow.grupo_ativo;
    // só admin do grupo pode alterar (grupo pessoal de 1 membro: dono é admin)
    const { data: eu } = await supabase.from('grupo_membros')
      .select('papel').eq('grupo_id', grupoId).eq('user_id', req.userRow.id).maybeSingle();
    if (eu && eu.papel !== 'admin')
      return res.status(403).json({ erro: 'Apenas o admin do grupo pode mudar o compartilhamento.' });
    const { error } = await supabase.from('grupos').update({ [coluna]: !!valor }).eq('id', grupoId);
    if (error) return res.status(503).json({ erro: 'Compartilhamento indisponível: rode a migration 040 no Supabase.' });
    res.json({ ok: true, config: await growShareCfg(grupoId) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
