// =============================================================================
// /api/divisoes — compra do cartão dividida com outra pessoa (migration 206).
// Regras em services/divisaoCompra.js (eval:divisao-compra).
//
//   PUT    /transacao/:id   dividir / mudar / tirar a divisão de uma compra
//   GET    /pessoas         nomes já usados (sugestão do "com quem?")
//   GET    /acertos         o que cada pessoa já acertou de uma fatura
//   GET    /recebimentos    entradas recentes de uma conta (pra ligar ao Pix dela)
//   POST   /acertos         registrar que a pessoa pagou a parte dela
//   DELETE /acertos/:id     desfazer esse registro
//
// ⚠️ Sem a 206 nada quebra: leitura devolve `liberado: false` e escrita
// responde 503 com texto pra cliente (o detalhe técnico fica no log).
// =============================================================================
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { creditarConta } = require('../services/contaDebito');
const { moverSaldo, gravarSaldo } = require('../services/saldoCarteira');
const D = require('../services/divisaoCompra');

const SEM_MIGRACAO = {
  erro: 'Dividir compras ainda está sendo liberado. Tente de novo mais tarde.',
  codigo: 'sem_migracao',
};
const semMigracao = (res, onde, error) => {
  console.warn(`[divisoes] ${onde}: falta a migration 206 —`, error?.message || error);
  return res.status(503).json(SEM_MIGRACAO);
};

const grupoDe = (req) => req.grupoId || req.authUser?.grupoAtivo || null;
const ehCompetencia = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));

async function carteiraPorNome(grupoId, nome) {
  const { data } = await supabase.from('wallets').select('id, nome, tipo, saldo, of_conta_id').eq('grupo_id', grupoId);
  return (data || []).find((w) => D.chavePessoa(w.nome) === D.chavePessoa(nome)) || null;
}

// ── PUT /transacao/:id { divisao, aplicar_parcelas } ─────────────────────────
router.put('/transacao/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId;
    const v = D.validarDivisao(req.body?.divisao);
    if (!v.ok) return res.status(400).json({ erro: v.erro });

    const { data: tx, error } = await supabase.from('transacoes')
      .select('*').eq('id', req.params.id).eq('grupo_id', grupoId).maybeSingle();
    if (error) return res.status(500).json({ erro: 'Não consegui ler o lançamento agora.' });
    if (!tx) return res.status(404).json({ erro: 'Lançamento não encontrado.' });

    // Tirar a divisão vale sempre; dividir, só compra de cartão.
    if (v.divisao) {
      const motivo = D.motivoNaoDivide(tx, await carteiraPorNome(grupoId, tx.carteira_nome));
      if (motivo) return res.status(400).json({ erro: motivo });
    }
    const r = await D.aplicarDivisao({
      grupoId, tx, divisao: v.divisao, aplicarParcelas: req.body?.aplicar_parcelas === true,
    });
    if (!r.ok) {
      if (r.codigo === 'sem_migracao') return semMigracao(res, 'PUT transacao', 'coluna dividida_com');
      return res.status(r.status || 400).json({ erro: r.erro });
    }
    res.json({ ok: true, atualizadas: r.atualizadas, linhas: r.linhas, divisao: v.divisao });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── GET /pessoas → nomes já usados, mais recentes primeiro ──────────────────
router.get('/pessoas', auth, async (req, res) => {
  try {
    const g = grupoDe(req);
    if (!g) return res.json({ pessoas: [], liberado: true });
    const { data, error } = await supabase.from('transacoes')
      .select('dividida_com').eq('grupo_id', g).not('dividida_com', 'is', null)
      .order('data', { ascending: false }).limit(300);
    if (error) {
      if (D.faltaMigracao(error)) return res.json({ pessoas: [], liberado: false });
      return res.status(500).json({ erro: 'Não consegui ler os nomes agora.' });
    }
    const vistos = new Set();
    const pessoas = [];
    for (const r of data || []) {
      const nome = D.normalizarPessoa(r.dividida_com);
      const k = D.chavePessoa(nome);
      if (!nome || vistos.has(k)) continue;
      vistos.add(k);
      pessoas.push(nome);
      if (pessoas.length >= 20) break;
    }
    res.json({ pessoas, liberado: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── GET /acertos?cartao_id=&competencia= ────────────────────────────────────
router.get('/acertos', auth, async (req, res) => {
  try {
    const g = grupoDe(req);
    const { cartao_id, competencia } = req.query;
    if (!g || !cartao_id || !ehCompetencia(competencia)) return res.json({ acertos: [], liberado: true });
    const { data, error } = await supabase.from('divisoes_acertos')
      .select('id, pessoa, pessoa_chave, valor, forma, wallet_id, transacao_id, created_at')
      .eq('grupo_id', g).eq('cartao_id', cartao_id).eq('competencia', competencia)
      .order('created_at', { ascending: true });
    if (error) {
      if (D.faltaMigracao(error)) return res.json({ acertos: [], liberado: false });
      return res.status(500).json({ erro: 'Não consegui ler os acertos agora.' });
    }
    res.json({ acertos: data || [], liberado: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── GET /recebimentos?wallet_id=&esperado= ──────────────────────────────────
// Entradas dos últimos 45 dias na conta, pra pessoa apontar "foi este Pix".
router.get('/recebimentos', auth, async (req, res) => {
  try {
    const g = grupoDe(req);
    const { wallet_id } = req.query;
    if (!g || !wallet_id) return res.status(400).json({ erro: 'Escolha a conta.' });
    const { data: conta } = await supabase.from('wallets')
      .select('id, nome, tipo, of_conta_id').eq('id', wallet_id).eq('grupo_id', g).maybeSingle();
    if (!conta || conta.tipo === 'Crédito') return res.status(400).json({ erro: 'Escolha uma conta (não um cartão).' });

    const d = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const cols = 'id, tipo, valor, data, observacao, transferencia';
    let { data: txs, error } = await supabase.from('transacoes')
      .select(`${cols}, ignorar_em`).eq('grupo_id', g).ilike('carteira_nome', conta.nome)
      .eq('tipo', 'Recebimento').gte('data', d).order('data', { ascending: false }).limit(100);
    if (error) {
      ({ data: txs, error } = await supabase.from('transacoes')
        .select(cols).eq('grupo_id', g).ilike('carteira_nome', conta.nome)
        .eq('tipo', 'Recebimento').gte('data', d).order('data', { ascending: false }).limit(100));
    }
    if (error) return res.status(500).json({ erro: 'Não consegui ler as entradas desta conta agora.' });

    // Entrada já ligada a outro acerto não aparece de novo (o mesmo dinheiro
    // não paga duas partes). Sem a 206, ninguém foi ligado ainda.
    let jaUsados = new Set();
    const ids = (txs || []).map((t) => t.id);
    if (ids.length) {
      const { data: us } = await supabase.from('divisoes_acertos').select('transacao_id').in('transacao_id', ids);
      jaUsados = new Set((us || []).map((u) => u.transacao_id));
    }
    const recebimentos = D.candidatosDeRecebimento(txs, { esperado: req.query.esperado, jaUsados }).slice(0, 20);
    res.json({ recebimentos, conta: { id: conta.id, nome: conta.nome, banco: !!conta.of_conta_id } });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── POST /acertos ───────────────────────────────────────────────────────────
router.post('/acertos', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId;
    const v = D.validarAcerto(req.body);
    if (!v.ok) return res.status(400).json({ erro: v.erro });
    const a = v.acerto;

    const { data: cartao } = await supabase.from('wallets')
      .select('id, nome, tipo').eq('id', a.cartao_id).eq('grupo_id', grupoId).maybeSingle();
    if (!cartao || cartao.tipo !== 'Crédito') return res.status(400).json({ erro: 'Cartão não encontrado.' });

    // ⚠️ A tabela tem de existir ANTES de mexer em dinheiro: lançar a entrada e
    // só então descobrir que o acerto não grava deixaria saldo mexido à toa.
    const sonda = await supabase.from('divisoes_acertos').select('id').limit(1);
    if (sonda.error) {
      if (D.faltaMigracao(sonda.error)) return semMigracao(res, 'POST acertos', sonda.error);
      return res.status(500).json({ erro: 'Não consegui registrar agora. Tente de novo.' });
    }

    const linha = {
      grupo_id: grupoId, cartao_id: a.cartao_id, competencia: a.competencia,
      pessoa: a.pessoa, pessoa_chave: a.pessoa_chave, valor: a.valor, forma: a.forma,
      wallet_id: a.wallet_id, transacao_id: a.transacao_id, criado_por: req.userId || null,
    };

    if (a.forma === 'conta') {
      const { data: conta } = await supabase.from('wallets')
        .select('id, nome, tipo, saldo, of_conta_id').eq('id', a.wallet_id).eq('grupo_id', grupoId).maybeSingle();
      if (!conta || conta.tipo === 'Crédito') return res.status(400).json({ erro: 'Escolha uma conta (não um cartão).' });
      // ⚠️ Conta do banco: o Pix chega sozinho pelo extrato. Lançar aqui faria a
      // mesma entrada aparecer duas vezes — o caminho é apontar a que chegou.
      if (conta.of_conta_id) {
        return res.status(409).json({
          erro: 'Esta conta vem do seu banco: o dinheiro dela aparece sozinho no extrato. Escolha o Pix que chegou.',
          codigo: 'conta_do_banco',
        });
      }
      const saldoAntes = Number(conta.saldo) || 0;
      // Entrada FORA das receitas (transferencia): é o dinheiro da compra
      // voltando, não renda. Mesma função do resgate de investimento.
      const cr = await creditarConta({
        grupoId, walletId: conta.id, valor: a.valor, categoria: 'Reembolso',
        observacao: D.descricaoDoReembolso(a.pessoa, cartao.nome), userId: req.userId,
      });
      linha.transacao_id = cr?.tx?.id || null;
      const { data: ac, error } = await supabase.from('divisoes_acertos').insert(linha).select().single();
      if (error) {
        // Desfaz a entrada: sem o acerto ela seria dinheiro sem explicação.
        if (linha.transacao_id) {
          await supabase.from('transacoes').delete().eq('id', linha.transacao_id).eq('grupo_id', grupoId);
          // O saldo volta ao que era ANTES da entrada (lido antes de creditar).
          await gravarSaldo(conta, saldoAntes);
        }
        return res.status(500).json({ erro: 'Não consegui registrar agora. Tente de novo.' });
      }
      return res.json({ ok: true, acerto: ac, transacao_id: linha.transacao_id });
    }

    if (a.forma === 'vincular') {
      const { data: tx } = await supabase.from('transacoes')
        .select('id, tipo, transferencia, carteira_nome').eq('id', a.transacao_id).eq('grupo_id', grupoId).maybeSingle();
      if (!tx || tx.tipo !== 'Recebimento') return res.status(400).json({ erro: 'Escolha uma entrada de dinheiro.' });
      if (tx.transferencia === true) return res.status(409).json({ erro: 'Esta entrada já não conta como receita. Escolha "De outro jeito" pra só registrar o acerto.' });
      const { data: usado } = await supabase.from('divisoes_acertos').select('id').eq('transacao_id', tx.id).limit(1);
      if (usado && usado.length) return res.status(409).json({ erro: 'Esta entrada já foi usada em outro acerto.' });
      // A entrada sai das receitas (é o dinheiro da compra voltando). O saldo
      // não muda: o dinheiro já estava lá.
      const { error: eu } = await supabase.from('transacoes').update({ transferencia: true })
        .eq('id', tx.id).eq('grupo_id', grupoId);
      if (eu) return res.status(500).json({ erro: 'Não consegui marcar a entrada agora. Tente de novo.' });
      const { data: ac, error } = await supabase.from('divisoes_acertos').insert(linha).select().single();
      if (error) {
        await supabase.from('transacoes').update({ transferencia: false }).eq('id', tx.id).eq('grupo_id', grupoId);
        return res.status(500).json({ erro: 'Não consegui registrar agora. Tente de novo.' });
      }
      return res.json({ ok: true, acerto: ac });
    }

    // 'registro': pagou de outro jeito (dinheiro em mão etc.). Só anota.
    const { data: ac, error } = await supabase.from('divisoes_acertos').insert(linha).select().single();
    if (error) return res.status(500).json({ erro: 'Não consegui registrar agora. Tente de novo.' });
    res.json({ ok: true, acerto: ac });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── DELETE /acertos/:id ─────────────────────────────────────────────────────
router.delete('/acertos/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId;
    const { data: ac, error } = await supabase.from('divisoes_acertos')
      .select('*').eq('id', req.params.id).eq('grupo_id', grupoId).maybeSingle();
    if (error) {
      if (D.faltaMigracao(error)) return semMigracao(res, 'DELETE acertos', error);
      return res.status(500).json({ erro: 'Não consegui ler o acerto agora.' });
    }
    if (!ac) return res.status(404).json({ erro: 'Acerto não encontrado.' });

    // 'fatura': só a MARCAÇÃO sai (a parte volta a constar como a receber). O
    // pagamento da fatura é outra coisa e se desfaz na lista de pagamentos dela
    // — apagar daqui deixaria a fatura com pagamento sem lançamento.
    const aviso = ac.forma === 'fatura'
      ? 'O pagamento da fatura continua registrado. Se ele foi um engano, desfaça na lista de pagamentos da fatura.'
      : undefined;

    if (ac.forma === 'conta' && ac.transacao_id) {
      // Apaga a entrada que a Sora lançou e devolve o saldo da conta. O acerto
      // sai junto (ON DELETE CASCADE).
      const { data: tx } = await supabase.from('transacoes')
        .select('id, valor, carteira_nome, pago').eq('id', ac.transacao_id).eq('grupo_id', grupoId).maybeSingle();
      if (tx) {
        const conta = await carteiraPorNome(grupoId, tx.carteira_nome);
        const { error: ed } = await supabase.from('transacoes').delete().eq('id', tx.id).eq('grupo_id', grupoId);
        if (ed) return res.status(500).json({ erro: 'Não consegui desfazer agora. Tente de novo.' });
        if (conta && tx.pago) await moverSaldo(conta, -Number(tx.valor || 0));
      }
    }
    if (ac.forma === 'vincular' && ac.transacao_id) {
      // A entrada volta a ser o que era: uma receita comum.
      await supabase.from('transacoes').update({ transferencia: false })
        .eq('id', ac.transacao_id).eq('grupo_id', grupoId);
    }
    await supabase.from('divisoes_acertos').delete().eq('id', ac.id).eq('grupo_id', grupoId);
    res.json({ ok: true, aviso });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
