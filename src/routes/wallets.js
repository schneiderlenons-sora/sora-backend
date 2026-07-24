const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { debitarConta, registrarTransferencia, registrarFaturaExterna } = require('../services/contaDebito');
const norm     = p => p?.replace(/\D/g, '');

// Tenta as duas variantes de número brasileiro (com/sem 9º dígito)
function variantesPhone(phone) {
  const p = norm(phone) || '';
  const variantes = [p];
  if (p.length === 13 && p.startsWith('55'))
    variantes.push(p.slice(0, 4) + p.slice(5));
  if (p.length === 12 && p.startsWith('55'))
    variantes.push(p.slice(0, 4) + '9' + p.slice(4));
  return variantes;
}

// Identidade pelo usuário autenticado (JWT/e-mail), não por telefone.
async function getGrupoId(req) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('id', req.authUser?.id || '__none__').maybeSingle();
  return data?.grupo_ativo || null;
}

// GET /api/wallets/:phone
router.get('/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    // Join do dono (pra mostrar de quem é a conta em grupos). Fallback sem o
    // embed caso a FK ainda não exista (migration 049 não rodada).
    let { data, error } = await supabase.from('wallets')
      .select('*, dono:users!wallets_criado_por_fkey(id, name, phone, avatar_url, avatar_preset, avatar_cor)')
      .eq('grupo_id', grupoId).order('nome');
    if (error) {
      // Sem a migration 048 (preset/cor): tenta o join só com colunas seguras
      // pra não perder o dono; se a 049 (FK) também faltar, cai pro '*' puro.
      let r = await supabase.from('wallets')
        .select('*, dono:users!wallets_criado_por_fkey(id, name, phone, avatar_url)')
        .eq('grupo_id', grupoId).order('nome');
      if (r.error) r = await supabase.from('wallets').select('*').eq('grupo_id', grupoId).order('nome');
      data = r.data;
    }
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/wallets
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { nome, tipo, saldo, limite, cheque_especial,
            dia_fechamento, dia_vencimento, bandeira, ultimos4 } = req.body;
    const grupoId = req.grupoId; // grupo do usuário autenticado (exigirPermissao)
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    // Saldo ANTES do upsert: se a conta já existe e o saldo muda, a diferença
    // vira Ajuste (rastro). Se é CRIAÇÃO, o saldo é abertura (patrimônio) e NÃO
    // gera transação — você já tinha o dinheiro, não recebeu agora.
    const { data: antes } = await supabase.from('wallets')
      .select('id, saldo').eq('grupo_id', grupoId).eq('nome', nome).maybeSingle();

    const row = { grupo_id: grupoId, nome, tipo, saldo, limite };
    // Cheque especial (migration 094) — teto de saldo negativo da conta. Só
    // inclui quando enviado; guarda em módulo (positivo). Tolerante: se a
    // coluna não existe ainda, o upsert abaixo falha e cai no catch — por isso
    // só adiciona ao row quando o cliente mandou (contas de crédito não mandam).
    if (cheque_especial !== undefined) {
      row.cheque_especial = Math.abs(Number(cheque_especial) || 0);
    }
    // Campos de cartão de crédito (migration 023) — só inclui quando enviados
    if (dia_fechamento !== undefined) row.dia_fechamento = dia_fechamento || null;
    if (dia_vencimento !== undefined) row.dia_vencimento = dia_vencimento || null;
    if (bandeira       !== undefined) row.bandeira       = bandeira || null;
    if (ultimos4       !== undefined) row.ultimos4       = ultimos4 || null;

    let { data, error } = await supabase.from('wallets')
      .upsert(row, { onConflict: 'grupo_id,nome' })
      .select().single();
    // Tolerante à migration 094: se a coluna cheque_especial ainda não existe,
    // reenvia sem ela (não trava o salvar de conta até rodar a migration).
    if (error && /cheque_especial/i.test(error.message || '')) {
      const { cheque_especial: _drop, ...semCheque } = row;
      ({ data, error } = await supabase.from('wallets')
        .upsert(semCheque, { onConflict: 'grupo_id,nome' })
        .select().single());
    }
    if (error) throw error;

    // Define o dono SÓ na criação (não sobrescreve em edições/ajustes de saldo).
    // Tolerante: se a coluna criado_por não existe (migration 049), ignora.
    if (data && !data.criado_por && req.userId) {
      const { error: e2 } = await supabase.from('wallets')
        .update({ criado_por: req.userId }).eq('id', data.id);
      if (!e2) data.criado_por = req.userId;
    }

    // EDIÇÃO com saldo novo → registra o Ajuste. (Criação não entra: `antes` é
    // null. Saldo omitido no body também não — o upsert nem mexeu na coluna.)
    if (antes && saldo !== undefined && saldo !== null) {
      const diff = Math.round(((Number(saldo) || 0) - (antes.saldo || 0)) * 100) / 100;
      if (diff !== 0) {
        const { registrarAjuste } = require('../services/ajusteSaldo');
        await registrarAjuste({ grupoId, criadoPor: req.userId, carteiraNome: data.nome, diff });
      }
    }

    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/wallets/fatura/pagar — paga a fatura do cartão debitando de UMA ou
// VÁRIAS contas (cria uma transação de saída por conta e desconta cada saldo).
//
// Body aceita os dois formatos (retrocompatível):
//   • { cartao_id, wallet_id, valor }                       ← conta única
//   • { cartao_id, pagamentos: [{ wallet_id, valor }, ...] } ← dividido
// Cada item do split pode ser de uma conta real (wallet_id → debita a conta) OU
// EXTERNO (`externa: true` + descricao → só registra quem pagou, sem debitar
// nenhum saldo — pra quando a parte foi paga por familiar fora do painel).
router.post('/fatura/pagar', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { cartao_id, wallet_id, valor, pagamentos } = req.body;
    const grupoId = req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    // Normaliza pro formato lista. Single vira lista de 1.
    const lista = Array.isArray(pagamentos) && pagamentos.length
      ? pagamentos
      : [{ wallet_id, valor }];

    const itens = lista
      .map(p => ({
        wallet_id: p.wallet_id,
        valor:     parseFloat(p.valor),
        descricao: (p.descricao || '').toString().trim().slice(0, 40),
        externa:   !!p.externa,
      }))
      // externo entra mesmo sem wallet_id; conta real precisa do wallet_id.
      .filter(p => p.valor > 0 && (p.externa || p.wallet_id));

    if (!itens.length) return res.status(400).json({ erro: 'Escolha a conta e o valor do pagamento.' });

    const { data: cartao } = await supabase.from('wallets')
      .select('nome').eq('id', cartao_id).eq('grupo_id', grupoId).maybeSingle();

    // Uma transação por item. Conta real → debita o saldo; externo → só registra
    // (sem mexer em saldo). `descricao` (ex.: "Esposa") vira parte da observação
    // pra saber quem pagou o quê. Se um falhar, o erro sobe (os já gravados ficam).
    const debitos = [];
    for (const it of itens) {
      const obs = `Fatura ${cartao?.nome || 'cartão'}${it.descricao ? ` · ${it.descricao}` : ''}${it.externa ? ' (externo)' : ''}`;
      const d = it.externa
        ? await registrarFaturaExterna({ grupoId, valor: it.valor, observacao: obs, userId: req.userId })
        : await debitarConta({
            grupoId, walletId: it.wallet_id, valor: it.valor,
            categoria: 'Fatura cartão', observacao: obs, userId: req.userId,
          });
      debitos.push(d);
    }

    // Retorna `debito` (1º) pra retrocompat + `debitos` (todos) pro split.
    res.json({ ok: true, debito: debitos[0], debitos });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/wallets/transferir — move valor entre duas contas (ajusta os dois
// saldos) e grava UM registro de transferência (fora dos relatórios de gasto).
router.post('/transferir', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { origem_id, destino_id, valor } = req.body;
    const grupoId = req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    if (!origem_id || !destino_id) return res.status(400).json({ erro: 'Escolha as contas de origem e destino.' });
    if (origem_id === destino_id)  return res.status(400).json({ erro: 'Origem e destino devem ser diferentes.' });
    const v = parseFloat(valor);
    if (!v || v <= 0) return res.status(400).json({ erro: 'Valor inválido.' });

    // cheque_especial: teto de negativo (migration 094). Select tolerante: se a
    // coluna não existe ainda, refaz com '*' e trata como 0.
    let { data: contas, error: selErr } = await supabase.from('wallets')
      .select('id, nome, saldo, cheque_especial').eq('grupo_id', grupoId).in('id', [origem_id, destino_id]);
    if (selErr) {
      ({ data: contas } = await supabase.from('wallets')
        .select('*').eq('grupo_id', grupoId).in('id', [origem_id, destino_id]));
    }
    const origem  = (contas || []).find(c => c.id === origem_id);
    const destino = (contas || []).find(c => c.id === destino_id);
    if (!origem || !destino) return res.status(404).json({ erro: 'Conta não encontrada.' });
    // Permite ir negativo até o cheque especial: disponível = saldo + limite.
    const chequeOrigem = Math.abs(Number(origem.cheque_especial) || 0);
    const disponivel   = (origem.saldo || 0) + chequeOrigem;
    if (disponivel < v) {
      const extra = chequeOrigem > 0 ? ` (saldo + cheque especial: R$ ${disponivel.toFixed(2)})` : '';
      return res.status(400).json({ erro: `Saldo insuficiente em ${origem.nome}${extra}.` });
    }

    await supabase.from('wallets').update({ saldo: (origem.saldo || 0) - v }).eq('id', origem.id);
    await supabase.from('wallets').update({ saldo: (destino.saldo || 0) + v }).eq('id', destino.id);

    const tx = await registrarTransferencia({
      grupoId, origemNome: origem.nome, destinoNome: destino.nome, valor: v, userId: req.userId,
    });
    res.json({ ok: true, tx });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/wallets/:id — só do próprio grupo (anti-IDOR).
// Se a conta AINDA tem transações e nenhuma ação foi dita, devolve 409 com a
// contagem pro painel perguntar (mover pra outra conta OU excluir junto). Assim
// nunca deixamos transações órfãs (apontando pra uma conta que não existe mais).
//   ?transacoes=mover&destino=<walletId>  → move as transações e leva o saldo
//   ?transacoes=excluir                   → apaga as transações junto
router.delete('/:id', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo || '__nenhum__';
    const { data: wallet } = await supabase.from('wallets')
      .select('id, nome, saldo').eq('id', req.params.id).eq('grupo_id', grupoId).maybeSingle();
    if (!wallet) return res.json({ ok: true }); // já não existe

    // Quantas transações usam essa conta (match case-insensitive pelo nome).
    // Count exato (head) — não traz linhas (o select de linhas capa em 1000).
    const { count } = await supabase.from('transacoes')
      .select('id', { count: 'exact', head: true }).eq('grupo_id', grupoId).ilike('carteira_nome', wallet.nome);
    const total = count || 0;
    const acao = req.query.transacoes; // undefined | 'mover' | 'excluir'

    if (total > 0 && !acao) {
      return res.status(409).json({
        erro: `Essa conta tem ${total} lançamento(s).`,
        motivo: 'conta_com_transacoes', count: total, nome: wallet.nome,
      });
    }

    if (total > 0 && acao === 'mover') {
      const { data: destino } = await supabase.from('wallets')
        .select('id, nome, saldo').eq('id', req.query.destino).eq('grupo_id', grupoId).maybeSingle();
      if (!destino || destino.id === wallet.id) {
        return res.status(400).json({ erro: 'Escolha uma conta destino válida (diferente da excluída).' });
      }
      // Efeito no saldo do destino = soma dos lançamentos movidos.
      const { data: txs } = await supabase.from('transacoes')
        .select('valor, tipo').eq('grupo_id', grupoId).ilike('carteira_nome', wallet.nome);
      await supabase.from('transacoes').update({ carteira_nome: destino.nome })
        .eq('grupo_id', grupoId).ilike('carteira_nome', wallet.nome);
      const delta = (txs || []).reduce((s, t) => s + (t.valor || 0) * (t.tipo === 'Gasto' ? -1 : 1), 0);
      await supabase.from('wallets').update({ saldo: (destino.saldo || 0) + delta }).eq('id', destino.id);
    } else if (total > 0 && acao === 'excluir') {
      await supabase.from('transacoes').delete()
        .eq('grupo_id', grupoId).ilike('carteira_nome', wallet.nome);
    }

    await supabase.from('wallets').delete().eq('id', wallet.id).eq('grupo_id', grupoId);
    // Se era a conta padrão de alguém, limpa a referência (defensivo).
    try { await supabase.from('users').update({ wallet_padrao_id: null }).eq('wallet_padrao_id', wallet.id); } catch {}

    res.json({ ok: true, movidas: acao === 'mover' ? total : 0, excluidas: acao === 'excluir' ? total : 0 });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;