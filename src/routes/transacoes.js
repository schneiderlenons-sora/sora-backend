const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { calcularResumo } = require('../services/resumoTransacoes');

const norm = p => p?.replace(/\D/g, '');
// Normaliza nome de conta pra comparar (lowercase, sem acento).
const normNome = s => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Primeiro dia do mês seguinte (YYYY-MM-01) — usado como limite exclusivo.
// Evita usar `${mes}-31` que é data inválida em meses de 30/28/29 dias
// (Postgres rejeita e a query falha → fatura aparece vazia).
function proximoMesPrimeiroDia(mes) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m, 1); // m (1-based) vira mês 0-based seguinte
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// Identidade pelo usuário AUTENTICADO (JWT/e-mail), não pelo telefone — assim
// quem tem só e-mail (sem WhatsApp) também acessa. O middleware `auth` já
// resolveu o grupo ativo a partir do user.id do login.
function usuarioReq(req) {
  return req.authUser?.grupoAtivo
    ? { id: req.authUser.id, grupo_ativo: req.authUser.grupoAtivo }
    : null;
}

// GET /api/transacoes/:phone?mes=2026-05&tipo=Gasto&categoria=Mercado&limit=50&offset=0&criado_por_me=true&criado_por_phone=XX
router.get('/:phone', auth, async (req, res) => {
  try {
    const user = usuarioReq(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const grupoId = user.grupo_ativo;

    const { mes, tipo, categoria, limit = 50, offset = 0, criado_por, criado_por_me, criado_por_phone, ate } = req.query;

    // Tenta com JOIN — se a FK não existir no schema, cai para SELECT * sem join
    let query = supabase.from('transacoes')
      .select('*, criador:users!transacoes_criado_por_fkey(id, name, phone, avatar_url, avatar_preset, avatar_cor)', { count: 'exact' })
      .eq('grupo_id', grupoId)
      .order('data', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (mes)       query = query.gte("data", `${mes}-01`).lt("data", proximoMesPrimeiroDia(mes));
    if (ate)       query = query.lte('data', ate); // exclui lançamentos futuros (ex.: parcelas)
    if (tipo)      query = query.eq('tipo', tipo);
    if (categoria) query = query.eq('categoria', categoria);

    if (criado_por) {
      query = query.eq('criado_por', criado_por); // filtro por membro (user_id) — escopo do grupo
    } else if (criado_por_me === 'true') {
      query = query.eq('criado_por', user.id);
    } else if (criado_por_phone) {
      const { data: outro } = await supabase.from('users')
        .select('id').eq('phone', norm(criado_por_phone)).maybeSingle();
      if (outro?.id) query = query.eq('criado_por', outro.id);
    }

    let { data, count, error } = await query;
    if (error) {
      // Fallback: mantém o criador com colunas seguras (sem preset/cor da
      // migration 048) pra o avatar do autor não sumir. Só cai pro '*' puro
      // se nem isso funcionar (FK ausente).
      console.warn('[transacoes] join fallback:', error.message);
      const baseQ2 = (embed) => {
        let q = supabase.from('transacoes').select(embed, { count: 'exact' })
          .eq('grupo_id', grupoId)
          .order('data', { ascending: false })
          .range(Number(offset), Number(offset) + Number(limit) - 1);
        if (mes)       q = q.gte("data", `${mes}-01`).lt("data", proximoMesPrimeiroDia(mes));
        if (ate)       q = q.lte('data', ate);
        if (tipo)      q = q.eq('tipo', tipo);
        if (categoria) q = q.eq('categoria', categoria);
        if (criado_por) q = q.eq('criado_por', criado_por);
        else if (criado_por_me === 'true') q = q.eq('criado_por', user.id);
        return q;
      };
      let r = await baseQ2('*, criador:users!transacoes_criado_por_fkey(id, name, phone, avatar_url)');
      if (r.error) r = await baseQ2('*');
      data = r.data; count = r.count;
    }
    // Alias wallet_nome → o frontend lê esse campo; no banco a coluna é carteira_nome
    const transacoes = (data || []).map(t => ({ ...t, wallet_nome: t.carteira_nome }));
    res.json({ transacoes, total: count || 0 });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/transacoes — cria transação pelo painel
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, tipo, categoria, valor, observacao, carteira_nome, data, pago } = req.body;
    const grupoId = req.grupoId;
    const userId  = req.userId;

    // Guardrail anti-conta-fantasma: casa a conta informada com uma wallet REAL
    // do grupo; se não existir, cai em 'Dinheiro' (nunca grava nome inexistente).
    const { data: wsGrupo } = await supabase.from('wallets').select('id, saldo, nome').eq('grupo_id', grupoId);
    const walletReal = (wsGrupo || []).find(w => normNome(w.nome) === normNome(carteira_nome));
    const contaFinal = walletReal ? walletReal.nome : 'Dinheiro';

    const idCurto = Math.random().toString(36).substring(2, 8).toUpperCase();

    const { data: tx, error } = await supabase.from('transacoes').insert({
      id_curto:      idCurto,
      grupo_id:      grupoId,
      criado_por:    userId,
      tipo,
      categoria,
      valor:         parseFloat(valor),
      observacao:    observacao || '',
      carteira_nome: contaFinal,
      pago:          pago !== false,
      data:          data || new Date().toISOString(),
    }).select().single();

    if (error) throw error;

    if (tx.pago && walletReal) {
      const mult = tipo === 'Gasto' ? -1 : 1;
      await supabase.from('wallets')
        .update({ saldo: (walletReal.saldo || 0) + (parseFloat(valor) * mult) }).eq('id', walletReal.id);
    }

    res.json(tx);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/transacoes/parcelado — compra parcelada NO CARTÃO DE CRÉDITO.
// Cria N transações (uma por mês), cada uma = valor_parcela. `pagas` = array com
// os números das parcelas já pagas (1..N). O modelo "1 tx por mês" faz o cartão
// mostrar a fatura mês a mês e o limite comprometido (soma das parcelas) sozinho.
router.post('/parcelado', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { categoria, observacao, carteira_nome, valor_parcela, num_parcelas, data, pagas } = req.body;
    const grupoId = req.grupoId, userId = req.userId;

    const n  = parseInt(num_parcelas, 10);
    const vp = parseFloat(valor_parcela);
    if (!Number.isInteger(n) || n < 1 || n > 60) return res.status(400).json({ erro: 'Número de parcelas inválido (1 a 60).' });
    if (!(vp > 0)) return res.status(400).json({ erro: 'Valor da parcela inválido.' });

    // Parcelado é só em CARTÃO DE CRÉDITO.
    const { data: wsGrupo } = await supabase.from('wallets').select('id, nome, tipo, saldo').eq('grupo_id', grupoId);
    const card = (wsGrupo || []).find(w => normNome(w.nome) === normNome(carteira_nome) && w.tipo === 'Crédito');
    if (!card) return res.status(400).json({ erro: 'Compra parcelada só pode ser lançada em um cartão de crédito.' });

    const pagasSet = new Set((Array.isArray(pagas) ? pagas : []).map(Number));
    const grupoParcela = 'P' + Math.random().toString(36).substring(2, 10).toUpperCase();
    // Data da 1ª parcela (meio-dia evita virar o dia por fuso). Parcela i = 1ª + (i-1) meses.
    const base = data ? new Date(`${String(data).slice(0, 10)}T12:00:00`) : new Date();

    const rows = [];
    for (let i = 1; i <= n; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + (i - 1), base.getDate(), 12, 0, 0);
      rows.push({
        id_curto:      Math.random().toString(36).substring(2, 8).toUpperCase(),
        grupo_id:      grupoId,
        criado_por:    userId,
        tipo:          'Gasto',
        categoria:     categoria || '📦 Outros',
        valor:         vp,
        observacao:    (observacao || '').toString().slice(0, 200),
        carteira_nome: card.nome,
        pago:          pagasSet.has(i),
        data:          d.toISOString(),
        parcela_num:   i,
        parcela_total: n,
        parcela_grupo: grupoParcela,
      });
    }

    const { data: inseridas, error } = await supabase.from('transacoes').insert(rows).select('id');
    if (error) throw error;

    // Simetria com o POST single: parcela PAGA desconta o saldo do cartão (as
    // futuras ficam pago=false e não mexem). O DELETE reverte por parcela paga.
    const pagasCount = rows.filter(r => r.pago).length;
    if (pagasCount > 0) {
      await supabase.from('wallets')
        .update({ saldo: (card.saldo || 0) - (vp * pagasCount) }).eq('id', card.id);
    }

    res.json({ ok: true, parcela_grupo: grupoParcela, criadas: inseridas?.length || n });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/transacoes/bulk — importação em massa (OFX/CSV)
router.post('/bulk', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { transacoes } = req.body;
    if (!Array.isArray(transacoes) || transacoes.length === 0) {
      return res.status(400).json({ erro: 'Lista de transações vazia.' });
    }
    if (transacoes.length > 1000) {
      return res.status(400).json({ erro: 'Limite de 1000 transações por importação.' });
    }

    // Dedup por FITID (id único da transação no OFX): descarta o que já existe
    // no grupo. Rede de segurança contra reimportar o mesmo extrato.
    const fitidsEnviados = transacoes.map(t => t.fitid).filter(Boolean);
    let jaExistem = new Set();
    if (fitidsEnviados.length) {
      const { data: existentes } = await supabase.from('transacoes')
        .select('fitid').eq('grupo_id', req.grupoId).in('fitid', fitidsEnviados);
      jaExistem = new Set((existentes || []).map(e => e.fitid));
    }

    // Guardrail anti-conta-fantasma: casa cada carteira_nome com uma wallet REAL
    // do grupo; se não existir, cai em 'Dinheiro'. Evita gravar conta que não
    // existe (cliente antigo/bug), que sumia com o dinheiro em conta nenhuma.
    const { data: walletsGrupo } = await supabase.from('wallets').select('nome').eq('grupo_id', req.grupoId);
    const nomesReais = new Map((walletsGrupo || []).map(w => [normNome(w.nome), w.nome]));
    const reconciliarConta = (cn) => {
      const k = normNome(cn);
      if (!k || k === 'dinheiro') return 'Dinheiro';
      return nomesReais.get(k) || 'Dinheiro';
    };

    const rows = transacoes
      .filter(t => !t.fitid || !jaExistem.has(t.fitid))
      .map(t => ({
        id_curto:      Math.random().toString(36).substring(2, 8).toUpperCase(),
        grupo_id:      req.grupoId,
        criado_por:    req.userId,
        tipo:          t.tipo === 'Recebimento' ? 'Recebimento' : 'Gasto',
        categoria:     t.categoria || '📦 Outros',
        valor:         Math.abs(parseFloat(t.valor) || 0),
        observacao:    (t.observacao || '').toString().slice(0, 200),
        carteira_nome: reconciliarConta(t.carteira_nome),
        pago:          t.pago !== false,
        data:          t.data,
        fitid:         t.fitid || null,
      }));

    const duplicados = transacoes.length - rows.length;
    if (rows.length === 0) return res.json({ inserted: 0, duplicados });

    // Não mexe no saldo: o extrato do banco já reflete essas transações; o
    // saldo da conta é informado/ajustado separadamente pelo usuário.
    const { data, error } = await supabase.from('transacoes').insert(rows).select('id');
    if (error) throw error;

    res.json({ inserted: data?.length || 0, duplicados });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/transacoes/:id — edita (update PARCIAL: só os campos enviados)
router.put('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { tipo, categoria, valor, observacao, carteira_nome, data, pago } = req.body;
    const patch = {};
    if (tipo !== undefined)          patch.tipo = tipo;
    if (categoria !== undefined)     patch.categoria = categoria;
    if (valor !== undefined)         patch.valor = parseFloat(valor);
    if (observacao !== undefined)    patch.observacao = observacao;
    if (carteira_nome !== undefined) patch.carteira_nome = carteira_nome;
    if (data !== undefined)          patch.data = data;
    if (pago !== undefined)          patch.pago = pago;

    // Estado ANTES (pra reconciliar o saldo da carteira pela diferença).
    const { data: antes } = await supabase.from('transacoes')
      .select('*').eq('id', req.params.id).eq('grupo_id', req.grupoId).maybeSingle();

    // Só edita transação do próprio grupo (anti-IDOR)
    const { data: tx, error } = await supabase.from('transacoes')
      .update(patch).eq('id', req.params.id).eq('grupo_id', req.grupoId).select().single();
    if (error) throw error;

    // Reconcilia o saldo da carteira: efeito = pago ? (Gasto −valor / Receita +valor) : 0.
    // Aplica a DIFERENÇA (depois − antes) — cobre marcar pendente→pago (ex.: confirmar
    // um "previsto" variável), mudar o valor de um pago, ou trocar de conta. Pula
    // transferências e fatura de cartão (têm débito próprio) pra não contar em dobro.
    try {
      const especial = (t) => !t || t.transferencia === true || t.categoria === 'Fatura cartão' || t.categoria === 'Transferências';
      if (!especial(antes) && !especial(tx)) {
        const efeito = (t) => (t.pago ? (t.tipo === 'Gasto' ? -1 : 1) * (Number(t.valor) || 0) : 0);
        const ajustar = async (nome, delta) => {
          if (!delta || !nome) return;
          const { data: w } = await supabase.from('wallets')
            .select('id, saldo').eq('grupo_id', req.grupoId).ilike('nome', nome).maybeSingle();
          if (w) await supabase.from('wallets').update({ saldo: (w.saldo || 0) + delta }).eq('id', w.id);
        };
        if (normNome(antes.carteira_nome) === normNome(tx.carteira_nome)) {
          await ajustar(tx.carteira_nome, efeito(tx) - efeito(antes));
        } else {
          await ajustar(antes.carteira_nome, -efeito(antes)); // tira o efeito da conta antiga
          await ajustar(tx.carteira_nome, efeito(tx));         // aplica na conta nova
        }
      }
    } catch (e) { console.warn('[transacoes PUT] reconcilia saldo falhou:', e.message); }

    res.json(tx);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/transacoes/antecipar-cartao — paga parcelas do cartão debitando
// de uma conta bancária. Pagar fatura é uma transferência (conta → cartão):
// marca as parcelas como pagas (libera limite) e debita o saldo da conta,
// sem criar gasto novo (não duplica nos relatórios).
router.post('/antecipar-cartao', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { ids, conta_nome } = req.body;
    const grupoId = req.grupoId;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ erro: 'Nenhuma parcela informada.' });
    }
    if (!conta_nome) return res.status(400).json({ erro: 'Conta de pagamento não informada.' });

    // Soma só das parcelas em aberto (evita debitar o que já estava pago)
    const { data: parcelas } = await supabase.from('transacoes')
      .select('id, valor, pago').eq('grupo_id', grupoId).in('id', ids);
    const emAberto = (parcelas || []).filter(p => p.pago === false);
    if (emAberto.length === 0) return res.json({ ok: true, debitado: 0 });
    const total = emAberto.reduce((s, p) => s + (p.valor || 0), 0);

    // Marca como pagas
    await supabase.from('transacoes').update({ pago: true })
      .in('id', emAberto.map(p => p.id));

    // Debita o saldo da conta escolhida
    const { data: conta } = await supabase.from('wallets')
      .select('id, saldo').eq('grupo_id', grupoId).ilike('nome', conta_nome).maybeSingle();
    if (conta) {
      await supabase.from('wallets')
        .update({ saldo: (conta.saldo || 0) - total }).eq('id', conta.id);
    }

    res.json({ ok: true, debitado: total, conta: conta_nome });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/transacoes/:id
router.delete('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    // Só a transação do próprio grupo (anti-IDOR)
    const { data: tx } = await supabase.from('transacoes')
      .select('*').eq('id', req.params.id).eq('grupo_id', req.grupoId).maybeSingle();
    if (!tx) return res.status(404).json({ erro: 'Transação não encontrada' });

    // Excluir a COMPRA PARCELADA inteira? (?parcelas=todas) — apaga todas as
    // parcelas do mesmo parcela_grupo. Senão, só a parcela/transação clicada.
    const excluirTodas = req.query.parcelas === 'todas' && tx.parcela_grupo;
    let alvos = [tx];
    if (excluirTodas) {
      const { data: grupo } = await supabase.from('transacoes')
        .select('*').eq('grupo_id', req.grupoId).eq('parcela_grupo', tx.parcela_grupo);
      if (grupo?.length) alvos = grupo;
    }

    // Reverte o saldo de cada alvo PAGO (por carteira).
    for (const t of alvos) {
      if (!t.pago) continue;
      const mult = t.tipo === 'Gasto' ? 1 : -1;
      const { data: wallet } = await supabase.from('wallets')
        .select('id, saldo').eq('grupo_id', t.grupo_id).ilike('nome', t.carteira_nome).maybeSingle();
      if (wallet) {
        await supabase.from('wallets')
          .update({ saldo: (wallet.saldo || 0) + (t.valor * mult) }).eq('id', wallet.id);
      }
    }

    if (excluirTodas) {
      await supabase.from('transacoes').delete().eq('grupo_id', req.grupoId).eq('parcela_grupo', tx.parcela_grupo);
    } else {
      await supabase.from('transacoes').delete().eq('id', req.params.id).eq('grupo_id', req.grupoId);
    }
    res.json({ ok: true, excluidas: alvos.length });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/transacoes/:phone/resumo?mes=2026-05&criado_por_me=true
router.get('/:phone/resumo', auth, async (req, res) => {
  try {
    const user = usuarioReq(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    // Fonte única (services/resumoTransacoes) — mesma regra do dashboard.
    const resumo = await calcularResumo({
      grupoId: user.grupo_ativo, mes,
      // criado_por (user_id) filtra por membro; criado_por_me = o próprio user.
      // Escopo é sempre o grupo do user (calcularResumo filtra por grupo_ativo).
      criadoPorId: req.query.criado_por || (req.query.criado_por_me === 'true' ? user.id : undefined),
    });
    res.json(resumo);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
