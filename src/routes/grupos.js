const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { nanoid } = require('nanoid');
const norm     = p => p?.replace(/\D/g, '');

async function getUser(req) {
  const { data } = await supabase.from('users').select('*').eq('id', req.authUser?.id || '__none__').single();
  return data;
}

router.get('/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(404).json({ erro: 'Não encontrado' });

    // Grupos via membership.
    const { data: viaMembros } = await supabase.from('grupo_membros')
      .select('grupo_id, papel, grupos(id, nome, dono_id, emoji)').eq('user_id', user.id);
    // Grupos que o usuário é DONO — inclui o "Pessoal" (criado pelo trigger
    // sem linha em grupo_membros). Sem isso, o Pessoal não aparecia na lista e
    // não dava pra trocar de volta pra ele.
    const { data: viaDono } = await supabase.from('grupos')
      .select('id, nome, dono_id, emoji').eq('dono_id', user.id);

    const mapa = new Map();
    for (const m of viaMembros || []) {
      mapa.set(m.grupo_id, { grupo_id: m.grupo_id, papel: m.papel, grupos: m.grupos });
    }
    for (const g of viaDono || []) {
      if (!mapa.has(g.id)) mapa.set(g.id, { grupo_id: g.id, papel: 'admin', grupos: g });
    }
    res.json([...mapa.values()]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/convidar', auth, async (req, res) => {
  try {
    const { grupo_id } = req.body;
    // Usa SEMPRE o usuário autenticado (JWT) — nunca body.phone (anti-IDOR:
    // antes dava pra passar o telefone do dono de outro grupo e mintar convite).
    const userId = req.authUser?.id;
    if (!userId) return res.status(401).json({ erro: 'Não autenticado.' });
    if (!grupo_id) return res.status(400).json({ erro: 'Grupo não informado.' });

    // Só admin (ou dono) do GRUPO-ALVO pode convidar.
    const { data: membro } = await supabase.from('grupo_membros')
      .select('papel').eq('grupo_id', grupo_id).eq('user_id', userId).maybeSingle();
    let ehAdmin = membro?.papel === 'admin';
    if (!ehAdmin) {
      const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', grupo_id).maybeSingle();
      ehAdmin = grupo?.dono_id === userId;
    }
    if (!ehAdmin) return res.status(403).json({ erro: 'Apenas admins do grupo podem convidar.' });

    const codigo = nanoid(6).toUpperCase();
    await supabase.from('convites').insert({ grupo_id, codigo, criado_por: userId,
      expira_em: new Date(Date.now() + 7*24*60*60*1000).toISOString() });
    res.json({ codigo });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/aceitar', auth, async (req, res) => {
  try {
    const { phone, codigo } = req.body;
    const user = await getUser(req);
    const { data: convite } = await supabase.from('convites')
      .select('*, grupos(dono_id)').eq('codigo', codigo)
      .eq('usado', false).gte('expira_em', new Date().toISOString()).single();
    if (!convite) return res.status(400).json({ erro: 'Código inválido ou expirado' });

    // Limite de membros pelo plano do DONO do grupo (não deixa estourar o
    // limite do plano — antes não era checado e o grupo crescia sem limite).
    const { data: jaMembro } = await supabase.from('grupo_membros')
      .select('id').eq('grupo_id', convite.grupo_id).eq('user_id', user.id).maybeSingle();
    if (!jaMembro) {
      const { data: grupo } = await supabase.from('grupos')
        .select('users:dono_id(plano)').eq('id', convite.grupo_id).maybeSingle();
      const limite = LIMITE_MEMBROS[grupo?.users?.plano || 'inativo'] || 1;
      const { count } = await supabase.from('grupo_membros')
        .select('id', { count: 'exact', head: true }).eq('grupo_id', convite.grupo_id);
      if ((count || 0) >= limite) {
        return res.status(403).json({ erro: `Este grupo já atingiu o limite de ${limite} membro(s) do plano.` });
      }
    }

    await supabase.from('grupo_membros')
      .upsert({ grupo_id: convite.grupo_id, user_id: user.id, papel:'escrita' }, { onConflict:'grupo_id,user_id' });
    await supabase.from('convites').update({ usado: true }).eq('id', convite.id);
    await supabase.from('users').update({ grupo_ativo: convite.grupo_id }).eq('id', user.id);
    res.json({ ok: true, grupo_id: convite.grupo_id });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/trocar', auth, async (req, res) => {
  try {
    const { phone, grupo_id } = req.body;
    await supabase.from('users').update({ grupo_ativo: grupo_id }).eq('id', req.authUser?.id || '__none__');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Limite de membros por plano
const LIMITE_MEMBROS = { inativo: 1, basico: 1, premium: 3, black: 5 };

// POST /criar — cria um novo grupo (somente premium/black)
router.post('/criar', auth, async (req, res) => {
  try {
    const { phone, nome, emoji, copiar_dados } = req.body;
    const user = await getUser(req);
    if (!user) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (user.plano !== 'premium' && user.plano !== 'black') {
      return res.status(403).json({ erro: 'Recurso disponível apenas nos planos Premium e Black.' });
    }
    if (!nome?.trim()) return res.status(400).json({ erro: 'Informe o nome do grupo.' });

    const grupoAnterior = user.grupo_ativo; // de onde copiar (o grupo atual do usuário)

    const { data: grupo, error: erroGrupo } = await supabase.from('grupos')
      .insert({ nome: nome.trim(), emoji: emoji || '👨‍👩‍👧', dono_id: user.id })
      .select().single();
    if (erroGrupo) return res.status(500).json({ erro: erroGrupo.message });

    await supabase.from('grupo_membros').insert({
      grupo_id: grupo.id, user_id: user.id, papel: 'admin',
    });
    await supabase.from('users').update({ grupo_ativo: grupo.id }).eq('id', user.id);

    if (copiar_dados && grupoAnterior) {
      // Traz as finanças atuais (cópia) — categorias copiadas substituem as padrão.
      const { copiarDadosGrupo } = require('../services/copiarGrupo');
      await copiarDadosGrupo(grupoAnterior, grupo.id, user.id)
        .catch(e => console.warn('[grupos/criar] copiar dados:', e.message));
    } else {
      // Popula categorias padrão + extras (Encomendas/iFood/Uber e os subs
      // Nike/Shein/Adidas em Vestuário) — igual ao trigger de signup. Antes só
      // chamava a padrão, então grupos novos ficavam sem as subcategorias.
      try { await supabase.rpc('criar_categorias_padrao', { p_grupo_id: grupo.id }); } catch {}
      try { await supabase.rpc('criar_categorias_extra',  { p_grupo_id: grupo.id }); } catch {}
    }

    res.json({ ok: true, grupo });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /sair/:grupo_id — sai do grupo. Não pode sair do grupo Pessoal
router.delete('/sair/:grupo_id', auth, async (req, res) => {
  try {
    const { phone } = req.body;
    const user = await getUser(req);
    if (!user) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const grupoId = req.params.grupo_id;

    const { data: grupo } = await supabase.from('grupos')
      .select('id, nome, dono_id').eq('id', grupoId).single();
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    // Bloqueia sair do grupo Pessoal (o primeiro grupo criado para o user é o pessoal)
    if (grupo.dono_id === user.id && /pessoal/i.test(grupo.nome || '')) {
      return res.status(400).json({ erro: 'Não é possível sair do grupo Pessoal.' });
    }

    // Se for dono e há outros membros: transfere admin pro mais antigo
    if (grupo.dono_id === user.id) {
      const { data: outros } = await supabase.from('grupo_membros')
        .select('user_id, created_at').eq('grupo_id', grupoId)
        .neq('user_id', user.id).order('created_at', { ascending: true }).limit(1);
      if (outros?.length) {
        await supabase.from('grupos').update({ dono_id: outros[0].user_id }).eq('id', grupoId);
        await supabase.from('grupo_membros').update({ papel: 'admin' })
          .eq('grupo_id', grupoId).eq('user_id', outros[0].user_id);
      } else {
        // Sem membros restantes: deleta o grupo
        await supabase.from('grupos').delete().eq('id', grupoId);
      }
    }

    await supabase.from('grupo_membros').delete()
      .eq('grupo_id', grupoId).eq('user_id', user.id);

    // Se era o grupo ativo, troca para qualquer outro (ou null)
    if (user.grupo_ativo === grupoId) {
      const { data: prox } = await supabase.from('grupo_membros')
        .select('grupo_id').eq('user_id', user.id).limit(1).maybeSingle();
      await supabase.from('users').update({ grupo_ativo: prox?.grupo_id || null }).eq('id', user.id);
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PATCH /membro/:membro_id — atualiza papel (somente admin)
router.patch('/membro/:membro_id', auth, async (req, res) => {
  try {
    const { phone, papel } = req.body;
    if (!['admin','escrita','leitura'].includes(papel)) {
      return res.status(400).json({ erro: 'Papel inválido.' });
    }
    const user = await getUser(req);
    const { data: membro } = await supabase.from('grupo_membros')
      .select('grupo_id').eq('id', req.params.membro_id).single();
    if (!membro) return res.status(404).json({ erro: 'Membro não encontrado.' });

    // Verifica se quem pediu é admin do grupo
    const { data: meuPapel } = await supabase.from('grupo_membros')
      .select('papel').eq('grupo_id', membro.grupo_id).eq('user_id', user.id).single();
    if (meuPapel?.papel !== 'admin') return res.status(403).json({ erro: 'Apenas admins podem alterar papéis.' });

    await supabase.from('grupo_membros').update({ papel }).eq('id', req.params.membro_id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /membro/:membro_id — remove membro (somente admin)
router.delete('/membro/:membro_id', auth, async (req, res) => {
  try {
    const { phone } = req.body;
    const user = await getUser(req);
    const { data: membro } = await supabase.from('grupo_membros')
      .select('grupo_id, user_id').eq('id', req.params.membro_id).single();
    if (!membro) return res.status(404).json({ erro: 'Membro não encontrado.' });
    if (membro.user_id === user.id) return res.status(400).json({ erro: 'Use sair do grupo.' });

    const { data: meuPapel } = await supabase.from('grupo_membros')
      .select('papel').eq('grupo_id', membro.grupo_id).eq('user_id', user.id).single();
    if (meuPapel?.papel !== 'admin') return res.status(403).json({ erro: 'Apenas admins podem remover membros.' });

    await supabase.from('grupo_membros').delete().eq('id', req.params.membro_id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /:grupo_id/membros — lista membros (precisa ser do grupo)
router.get('/:grupo_id/membros', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('grupo_membros')
      .select('id, papel, created_at, user_id, users(id, name, phone, plano)')
      .eq('grupo_id', req.params.grupo_id)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ erro: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /:grupo_id/stats — métricas do grupo
router.get('/:grupo_id/stats', auth, async (req, res) => {
  try {
    const grupoId = req.params.grupo_id;
    const mes = new Date().toISOString().slice(0, 7);

    const { count: totalMembros } = await supabase.from('grupo_membros')
      .select('id', { count: 'exact', head: true }).eq('grupo_id', grupoId);

    const { count: totalCats } = await supabase.from('categorias')
      .select('id', { count: 'exact', head: true }).eq('grupo_id', grupoId).eq('ativa', true);

    const { data: txs } = await supabase.from('transacoes')
      .select('valor, tipo').eq('grupo_id', grupoId).gte('data', `${mes}-01`);
    const totalTransacoesMes = txs?.length || 0;
    const valorMovimentadoMes = (txs || []).reduce((s, t) => s + (t.valor || 0), 0);

    const { data: grupo } = await supabase.from('grupos')
      .select('users:dono_id(plano)').eq('id', grupoId).single();
    const planoDono = grupo?.users?.plano || 'inativo';
    const limite = LIMITE_MEMBROS[planoDono] || 1;

    res.json({
      total_membros: totalMembros || 0,
      limite_membros: limite,
      total_categorias: totalCats || 0,
      total_transacoes_mes: totalTransacoesMes,
      valor_movimentado_mes: valorMovimentadoMes,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PATCH /api/grupos/:grupo_id — edita nome/ícone do grupo (só o dono).
router.patch('/:grupo_id', auth, async (req, res) => {
  try {
    const grupoId = req.params.grupo_id;
    const { nome, emoji } = req.body;
    const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', grupoId).maybeSingle();
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado.' });
    if (grupo.dono_id !== req.authUser.id) return res.status(403).json({ erro: 'Só o dono do grupo pode editar.' });

    const patch = {};
    if (typeof nome === 'string' && nome.trim()) patch.nome = nome.trim().slice(0, 40);
    if (typeof emoji === 'string' && emoji) patch.emoji = emoji;
    if (!Object.keys(patch).length) return res.status(400).json({ erro: 'Nada para atualizar.' });

    const { data, error } = await supabase.from('grupos')
      .update(patch).eq('id', grupoId).select('id, nome, emoji').single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;