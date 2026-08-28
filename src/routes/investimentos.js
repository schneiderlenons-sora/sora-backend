const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPlano } = require('../middlewares/plano');
const { exigirPermissao } = require('../middlewares/permissao');
const {
  buscarCotacaoAcao, buscarDividendos, buscarTickers,
  buscarCotacaoCripto, buscarCriptos, listarCriptos, taxaParaBRL,
} = require('../services/cotacoes');
const { debitarConta } = require('../services/contaDebito');

const norm = p => p?.replace(/\D/g, '');

async function getGrupoId(req) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('id', req.authUser?.id || '__none__').single();
  return data?.grupo_ativo || null;
}

// ── BUSCAS PÚBLICAS DE COTAÇÃO ───────────────────────────────────

// GET /api/investimentos/buscar-ticker?q=PETR
router.get('/buscar-ticker', auth, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json([]);
  const r = await buscarTickers(q);
  res.json(r);
});

// GET /api/investimentos/buscar-cripto?q=bit
router.get('/buscar-cripto', auth, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json([]);
  res.json(await buscarCriptos(q));
});

// GET /api/investimentos/cotacao?ticker=AAPL&tipo=acao|cripto
// Retorna o preço atual JÁ em reais (converte moeda estrangeira via câmbio).
router.get('/cotacao', auth, async (req, res) => {
  try {
    const ticker = (req.query.ticker || '').toString().trim();
    const tipo   = (req.query.tipo || '').toString().toLowerCase();
    if (!ticker) return res.json({});

    if (tipo === 'cripto') {
      const c = await buscarCotacaoCripto(ticker.toLowerCase());
      if (c?.precoAtual == null) return res.json({});
      return res.json({ precoBRL: c.precoAtual, moeda: 'BRL', variacaoDia: c.variacaoDia ?? 0 });
    }

    const c = await buscarCotacaoAcao(ticker);
    if (c?.precoAtual == null) return res.json({});
    const moeda = c.moeda || 'BRL';
    if (moeda === 'BRL') {
      return res.json({ precoBRL: c.precoAtual, moeda: 'BRL', variacaoDia: c.variacaoDia ?? 0 });
    }
    // Moeda estrangeira → converte pra real.
    const taxa = await taxaParaBRL(moeda);
    if (!taxa) return res.json({ precoOriginal: c.precoAtual, moeda }); // sem câmbio
    return res.json({
      precoBRL: c.precoAtual * taxa, moeda: 'BRL',
      precoOriginal: c.precoAtual, moedaOriginal: moeda, taxa,
      variacaoDia: c.variacaoDia ?? 0,
    });
  } catch (err) {
    res.json({});
  }
});

// ── INVESTIMENTOS ────────────────────────────────────────────────

// GET /api/investimentos/:phone
router.get('/:phone', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('investimentos')
      .select('*').eq('grupo_id', grupoId).order('created_at');
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/:phone/movimentos?limite=300
//
// Aportes, resgates e proventos que o Open Finance devolve por investimento
// (migration 139). Alimenta a aba Aportes e o card de dividendos, que viviam
// vazios porque essa fonte nunca era chamada.
router.get('/:phone/movimentos', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const limite = Math.min(parseInt(req.query.limite, 10) || 300, 1000);

    const { data, error } = await supabase.from('investimento_movimentos')
      .select('*, investimentos(nome, ticker, tipo, instituicao)')
      .eq('grupo_id', grupoId)
      .order('data', { ascending: false })
      .limit(limite);

    // ⚠️ Migration 139 pendente devolve LISTA VAZIA, não 500. A aba depende
    // desta rota, e derrubá-la por causa de uma tabela que ainda não existe
    // levaria junto os aportes lançados à mão.
    if (error) return res.json({ movimentos: [], totais: null, pendente: true });

    // Totais por classe — é o que a tela mostra acima da lista.
    // ⚠️ `neutro` fica de FORA: transferência de custódia não é dinheiro
    // entrando nem saindo (ver CLASSE_MOVIMENTO no sync).
    const totais = { aporte: 0, resgate: 0, provento: 0, imposto: 0 };
    for (const m of data || []) {
      if (totais[m.classe] !== undefined) totais[m.classe] += Number(m.valor) || 0;
    }
    res.json({ movimentos: data || [], totais });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/:phone/distribuicao
router.get('/:phone/distribuicao', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data: invs } = await supabase.from('investimentos')
      .select('tipo, valor_atual').eq('grupo_id', grupoId);

    const agrupado = {};
    let total = 0;
    (invs || []).forEach(i => {
      agrupado[i.tipo] = (agrupado[i.tipo] || 0) + i.valor_atual;
      total += i.valor_atual;
    });

    const distribuicao = Object.entries(agrupado).map(([tipo, valor]) => ({
      tipo, valor, percentual: total > 0 ? (valor / total) * 100 : 0
    })).sort((a,b) => b.valor - a.valor);

    res.json({ distribuicao, total });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos
//
// ⚠️ O `error` do insert É LIDO. Antes a rota fazia `const { data } = await
// ...insert()` e respondia `res.json(data)`: quando o insert falhava, `data`
// vinha null e o painel recebia **200 OK com null** — achava que salvou, fechava
// o modal e recarregava a lista vazia. Era o relato "não está salvando" SEM
// nenhuma mensagem de erro. A causa por trás era a CHECK constraint de `tipo`
// (migration 121), mas qualquer falha futura teria sumido do mesmo jeito.
router.post('/', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const {
      tipo, nome, ticker, quantidade, preco_unitario, valor_aportado, data_compra,
      is_reserva_emergencia, taxa_anual, data_vencimento, indexador, percentual_indexador,
    } = req.body;
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    if (!tipo || !nome) return res.status(400).json({ erro: 'Informe o tipo e o nome do investimento.' });

    const qtd   = parseFloat(quantidade) || 1;
    const preco = parseFloat(preco_unitario) || parseFloat(valor_aportado);
    const aporte = parseFloat(valor_aportado);
    if (!Number.isFinite(aporte)) return res.status(400).json({ erro: 'Informe o valor investido.' });

    const base = {
      grupo_id: grupoId, tipo, nome,
      ticker: ticker || null,
      quantidade: qtd, preco_unitario: preco,
      valor_aportado: aporte,
      valor_atual: qtd * preco,
      data_compra: data_compra || new Date().toISOString(),
    };
    const linha = { ...base };
    // Campos que o modal JÁ enviava e a rota descartava em silêncio — inclusive
    // `is_reserva_emergencia`, que é o que faz o tipo "Reserva" contar na aba
    // Reserva de emergência.
    const extras = {
      is_reserva_emergencia: is_reserva_emergencia === true || undefined,
      taxa_anual: taxa_anual != null ? parseFloat(taxa_anual) : undefined,
      data_vencimento: data_vencimento || undefined,
      indexador: indexador || undefined,
      percentual_indexador: percentual_indexador != null ? parseFloat(percentual_indexador) : undefined,
    };
    for (const [k, v] of Object.entries(extras)) if (v !== undefined) linha[k] = v;

    let { data, error } = await supabase.from('investimentos').insert(linha).select().single();

    // Coluna nova ainda sem migration → regrava só com o essencial, em vez de
    // perder o investimento inteiro (lição do CLAUDE.md).
    if (error && Object.keys(extras).some((k) => (error.message || '').includes(k))) {
      ({ data, error } = await supabase.from('investimentos').insert(base).select().single());
    }

    if (error) {
      // O CHECK de `tipo` era exatamente este caso: mensagem crua do Postgres
      // não ajuda ninguém, então traduz.
      const constraintTipo = /investimentos_tipo_check/i.test(error.message || '');
      console.error('[investimentos] insert falhou:', error.message);
      return res.status(constraintTipo ? 400 : 500).json({
        erro: constraintTipo
          ? `O tipo "${tipo}" ainda não está liberado no banco. Rode a migration sql/121_investimentos_tipo_check.sql.`
          : `Não consegui salvar: ${error.message}`,
      });
    }

    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/investimentos/:id
// Mesmo problema do POST: o `error` era descartado e a edição "sumia" sem aviso.
router.put('/:id', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const campos = ['nome','ticker','quantidade','preco_unitario','valor_atual','valor_aportado'];
    const update = {};
    campos.forEach(c => { if (req.body[c] !== undefined) update[c] = req.body[c]; });
    if (!Object.keys(update).length) return res.status(400).json({ erro: 'Nada para atualizar.' });

    const { data, error } = await supabase.from('investimentos')
      .update(update).eq('id', req.params.id).eq('grupo_id', req.grupoId).select().single();
    if (error) {
      console.error('[investimentos] update falhou:', error.message);
      return res.status(500).json({ erro: `Não consegui atualizar: ${error.message}` });
    }
    // `single()` sem linha = id de outro grupo (ou apagado). 404 explícito em vez
    // de 200 com null.
    if (!data) return res.status(404).json({ erro: 'Investimento não encontrado.' });
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/investimentos/:id
router.delete('/:id', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    await supabase.from('investimentos').delete().eq('id', req.params.id).eq('grupo_id', req.grupoId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── APORTES ──────────────────────────────────────────────────────

// GET /api/investimentos/:phone/aportes
router.get('/:phone/aportes', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('aportes')
      .select('*, investimentos(nome)').eq('grupo_id', grupoId)
      .order('data', { ascending: false }).limit(50);
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/aportes
router.post('/aportes', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, valor, investimento_id, descricao } = req.body;
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const v = parseFloat(valor);
    if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ erro: 'Informe um valor maior que zero.' });

    // `tipo` NÃO é enviado de propósito: a coluna tem default 'aporte'
    // (migration 122), então isto continua funcionando antes de ela rodar.
    // ⚠️ O `error` É LIDO — esta rota tinha o mesmo defeito do POST de
    // investimento: `const { data } = insert()` e `res.json(data)` devolviam
    // 200 com null quando falhava, e o painel achava que tinha salvado.
    const { data: aporte, error: eAp } = await supabase.from('aportes').insert({
      grupo_id: grupoId, valor: v,
      investimento_id: investimento_id || null,
      descricao: descricao || 'Aporte manual'
    }).select().single();
    if (eAp) {
      console.error('[aportes] insert falhou:', eAp.message);
      return res.status(500).json({ erro: `Não consegui registrar o aporte: ${eAp.message}` });
    }

    // Atualiza o investimento vinculado
    let nomeInv = null;
    if (investimento_id) {
      const { data: inv } = await supabase.from('investimentos')
        .select('nome, valor_aportado, valor_atual').eq('id', investimento_id)
        .eq('grupo_id', grupoId).maybeSingle();
      if (inv) {
        nomeInv = inv.nome;
        await supabase.from('investimentos').update({
          valor_aportado: (Number(inv.valor_aportado) || 0) + v,
          valor_atual:    (Number(inv.valor_atual)    || 0) + v,
          ultima_atualizacao: new Date().toISOString(),
        }).eq('id', investimento_id);
      }
    }

    // Opcional: desconta de uma conta e registra a saída nas transações.
    let debito = null;
    if (req.body.wallet_id) {
      try {
        debito = await debitarConta({
          grupoId, walletId: req.body.wallet_id, valor: parseFloat(valor),
          categoria: 'Investimentos', observacao: `Aporte: ${nomeInv || descricao || 'investimento'}`,
          userId: req.userId,
        });
      } catch (e) { debito = { erro: e.message }; }
    }

    res.json({ ...aporte, debito });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/resgates — tira dinheiro de um investimento.
//
// Relato de usuário: "não achei a opção de resgate de investimentos". Não
// achou porque não existia — só METAS tinham resgate.
//
// ⚠️ O abatimento é PROPORCIONAL (services/resgateInvestimento.js): mexer só
// no valor atual e deixar o aportado intacto faria um saque parcial virar
// "prejuízo" na tela. Travado em `npm run eval:resgate`.
router.post('/resgates', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { valor, investimento_id, descricao, wallet_id } = req.body;
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    if (!investimento_id) return res.status(400).json({ erro: 'Escolha de qual investimento é o resgate.' });

    const { data: inv, error: eInv } = await supabase.from('investimentos')
      .select('id, nome, valor_aportado, valor_atual, quantidade')
      .eq('id', investimento_id).eq('grupo_id', grupoId).maybeSingle();
    if (eInv) return res.status(500).json({ erro: `Não consegui ler o investimento: ${eInv.message}` });
    if (!inv) return res.status(404).json({ erro: 'Investimento não encontrado.' });

    const { aplicarResgate } = require('../services/resgateInvestimento');
    const calc = aplicarResgate(inv, valor);
    if (!calc.ok) return res.status(400).json({ erro: calc.erro });

    // Extrato primeiro: se a linha do resgate falhar, nada foi alterado ainda.
    const linha = {
      grupo_id: grupoId, valor: calc.resgatado,
      investimento_id, tipo: 'resgate',
      descricao: descricao || `Resgate: ${inv.nome}`,
    };
    let { data: mov, error: eMov } = await supabase.from('aportes').insert(linha).select().single();
    // Migration 122 pendente (sem a coluna `tipo`) → o resgate NÃO pode entrar
    // como se fosse aporte, senão o extrato mente. Melhor recusar com instrução.
    if (eMov && /tipo/i.test(eMov.message || '')) {
      return res.status(400).json({
        erro: 'Resgate ainda não liberado no banco. Rode a migration sql/122_aportes_resgate.sql.',
      });
    }
    if (eMov) return res.status(500).json({ erro: `Não consegui registrar o resgate: ${eMov.message}` });

    const { error: eUp } = await supabase.from('investimentos')
      .update({ ...calc.patch, ultima_atualizacao: new Date().toISOString() })
      .eq('id', investimento_id).eq('grupo_id', grupoId);
    if (eUp) {
      // Desfaz o extrato pra não sobrar resgate registrado sem efeito nenhum.
      await supabase.from('aportes').delete().eq('id', mov.id);
      return res.status(500).json({ erro: `Não consegui atualizar o investimento: ${eUp.message}` });
    }

    // Opcional: o dinheiro volta pra uma conta (entrada marcada como
    // transferência — resgate não é renda nova, ver creditarConta).
    let credito = null;
    if (wallet_id) {
      try {
        const { creditarConta } = require('../services/contaDebito');
        credito = await creditarConta({
          grupoId, walletId: wallet_id, valor: calc.resgatado,
          categoria: 'Investimentos', observacao: `Resgate: ${inv.nome}`,
          userId: req.userId,
        });
      } catch (e) { credito = { erro: e.message }; }
    }

    res.json({ ...mov, zerou: calc.zerou, credito });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── METAS ────────────────────────────────────────────────────────

// GET /api/investimentos/:phone/metas
router.get('/:phone/metas', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('metas')
      .select('*').eq('grupo_id', grupoId);
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/metas
router.post('/metas', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, nome, valor_objetivo, prazo_anos, taxa_anual, investimento_id } = req.body;
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const taxa = parseFloat(taxa_anual) || 10;
    const n    = parseFloat(prazo_anos) * 12;
    const jm   = Math.pow(1 + taxa/100, 1/12) - 1;
    let aporte = (parseFloat(valor_objetivo) * jm) / (Math.pow(1+jm,n) - 1);
    if (!isFinite(aporte)) aporte = parseFloat(valor_objetivo) / n;

    const { data } = await supabase.from('metas').insert({
      grupo_id: grupoId, nome,
      valor_objetivo: parseFloat(valor_objetivo),
      prazo_anos: parseFloat(prazo_anos),
      taxa_anual: taxa,
      aporte_mensal_sugerido: parseFloat(aporte.toFixed(2)),
      investimento_id: investimento_id || null
    }).select().single();

    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/investimentos/metas/:id
router.delete('/metas/:id', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    await supabase.from('metas').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── COTAÇÕES + RESERVA DE EMERGÊNCIA ─────────────────────────────

// POST /api/investimentos/atualizar-precos/:phone
router.post('/atualizar-precos/:phone', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    const { data: invs } = await supabase.from('investimentos').select('*').eq('grupo_id', grupoId);
    let atualizados = 0;

    for (const inv of invs || []) {
      if (!inv.ticker) continue;
      let cotacao = null;
      if (inv.tipo === 'Cripto') {
        cotacao = await buscarCotacaoCripto(inv.ticker.toLowerCase());
      } else if (['Ações', 'FIIs', 'ETFs'].includes(inv.tipo)) {
        cotacao = await buscarCotacaoAcao(inv.ticker);
      }
      if (!cotacao || cotacao.precoAtual == null) continue;

      const valorAtual = cotacao.precoAtual * (inv.quantidade || 0);
      const divs = ['Ações', 'FIIs', 'ETFs'].includes(inv.tipo)
        ? await buscarDividendos(inv.ticker, inv.data_compra)
        : 0;
      const valorTotal = valorAtual + (divs * (inv.quantidade || 0));
      const rent = inv.valor_aportado > 0 ? (valorTotal - inv.valor_aportado) / inv.valor_aportado : 0;

      await supabase.from('investimentos').update({
        valor_atual:           valorAtual,
        variacao_dia:          cotacao.variacaoDia ?? 0,
        rentabilidade:         rent,
        dividendos_acumulados: divs * (inv.quantidade || 0),
        ultima_atualizacao:    new Date().toISOString(),
      }).eq('id', inv.id);

      atualizados++;
      await new Promise(r => setTimeout(r, 600)); // rate limit
    }

    res.json({ atualizados, total: invs?.length || 0 });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/caixinhas/:phone
// Caixinhas / cofrinhos vindos do Open Finance (saldos reservados).
//
// ⚠️ Esse dinheiro NÃO está no saldo da conta — a doc da Celcoin diz que
// `balance.available_amount` "não inclui (…) reservas de saldo". Por isso a
// aba mostra o total separado: somar junto ao saldo seria inventar, e não
// mostrar era esconder dinheiro do cliente.
//
// Leitura TOLERANTE: a tabela existe desde a 069, mas as colunas de remuneração
// são da 120. Se a migration não rodou, devolve o básico em vez de estourar
// (lição da casa: coluna nova em select de caminho crítico derruba a aba toda).
router.get('/caixinhas/:phone', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    const COMPLETO = 'id,nome,tipo,saldo,moeda,atualizado_em,indexador,indexador_pct,taxa_pre,periodicidade';
    let { data, error } = await supabase.from('of_caixinhas')
      .select(COMPLETO).eq('grupo_id', grupoId).order('saldo', { ascending: false });

    if (error) {
      const r2 = await supabase.from('of_caixinhas')
        .select('id,nome,tipo,saldo,moeda,atualizado_em').eq('grupo_id', grupoId)
        .order('saldo', { ascending: false });
      // Tabela ausente (069 pendente) → lista vazia, a aba só não mostra a seção.
      if (r2.error) return res.json({ caixinhas: [], total: 0 });
      data = r2.data;
    }

    const caixinhas = data || [];
    const total = caixinhas.reduce((s, c) => s + (Number(c.saldo) || 0), 0);
    res.json({ caixinhas, total: Math.round(total * 100) / 100 });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/reserva/:phone
router.get('/reserva/:phone', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    const { data: config } = await supabase.from('reserva_emergencia_config')
      .select('*').eq('grupo_id', grupoId).maybeSingle();

    const { data: invs } = await supabase.from('investimentos')
      .select('valor_atual').eq('grupo_id', grupoId).eq('is_reserva_emergencia', true);
    const valorAtual = (invs || []).reduce((s, i) => s + (i.valor_atual || 0), 0);

    const seisMesesAtras = new Date();
    seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);
    const { data: gastos } = await supabase.from('transacoes')
      .select('valor').eq('grupo_id', grupoId).eq('tipo', 'Gasto')
      .gte('data', seisMesesAtras.toISOString().slice(0, 10));

    const totalGastos = (gastos || []).reduce((s, g) => s + (g.valor || 0), 0);
    const gastoMedio  = totalGastos / 6;
    const mesesObj    = config?.meses_objetivo || 6;
    const objetivo    = gastoMedio * mesesObj;
    const pct         = objetivo > 0 ? Math.min((valorAtual / objetivo) * 100, 100) : 0;
    const mesesCob    = gastoMedio > 0 ? valorAtual / gastoMedio : 0;

    res.json({
      valorAtual,
      gastoMedioMensal: gastoMedio,
      mesesObjetivo:    mesesObj,
      valorObjetivo:    objetivo,
      percentual:       pct,
      mesesCobertos:    mesesCob,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/reserva/:phone
router.post('/reserva/:phone', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { meses_objetivo } = req.body;
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    await supabase.from('reserva_emergencia_config').upsert(
      { grupo_id: grupoId, meses_objetivo: parseInt(meses_objetivo, 10) || 6, updated_at: new Date().toISOString() },
      { onConflict: 'grupo_id' }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/:phone/patrimonio — evolução histórica
router.get('/:phone/patrimonio', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('patrimonio_historico')
      .select('*').eq('grupo_id', grupoId)
      .order('data', { ascending: true }).limit(365);
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;