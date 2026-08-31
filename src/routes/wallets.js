const express  = require('express');
const { CATEGORIA_FATURA } = require('../services/categorizar');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { debitarConta, registrarTransferencia, registrarFaturaExterna } = require('../services/contaDebito');
const { statusFatura, materializarRollover } = require('../services/faturaRollover');
const { competenciaAtual, cicloPorCompetencia, competenciaVizinha, hojeSP } = require('../services/cicloFatura');
const { valorExibido } = require('../services/faturaVista');
const norm     = p => p?.replace(/\D/g, '');

/** Aritmética do valor exibido — fonte única em services/faturaVista.js. */
const vistaDaFatura = (cartao, competencia, st) =>
  valorExibido(cartao, competencia, st, { parcelasPrevistas: parcelasPrevistasDe });

// Parcelas a vencer projetadas pelo sync do Open Finance (migration 116).
// A leitura mora em services/parcelasPrevistas.js pra ser a MESMA da agenda.
const { lerPrevistas: parcelasPrevistasDe } = require('../services/parcelasPrevistas');

// Moeda da carteira (migration 144). A CONVERSÃO MORA NO BACKEND de propósito:
// o painel recebe `saldo_brl` pronto e não precisa buscar câmbio no navegador —
// senão cada uma das 5 telas que somam saldo teria a sua própria cotação, e
// elas divergiriam entre si.
const { normalizarMoeda, taxas: taxasDe, saldoEmBRL } = require('../services/moeda');

/**
 * Anexa `moeda` e `saldo_brl` em cada carteira.
 * ⚠️ `saldo_brl` é null quando o câmbio falhou — NUNCA 0. Quem soma precisa
 * saber a diferença entre "vale zero" e "não sei quanto vale".
 */
async function comMoeda(lista) {
  const ws = lista || [];
  if (!ws.some((w) => normalizarMoeda(w.moeda) !== 'BRL')) {
    // Caminho de 99% dos grupos: nenhuma conta estrangeira, nenhuma ida ao
    // Yahoo, nenhum campo novo além do espelho do saldo.
    return ws.map((w) => ({ ...w, moeda: normalizarMoeda(w.moeda), saldo_brl: Number(w.saldo) || 0 }));
  }
  const tabela = await taxasDe(ws.map((w) => w.moeda));
  return ws.map((w) => ({
    ...w,
    moeda: normalizarMoeda(w.moeda),
    saldo_brl: saldoEmBRL({ saldo: w.saldo, moeda: w.moeda }, tabela),
    taxa_brl: tabela[normalizarMoeda(w.moeda)] ?? null,
  }));
}

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
    res.json(await comMoeda(data));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/wallets
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { nome, tipo, saldo, limite, cheque_especial,
            dia_fechamento, dia_vencimento, bandeira, ultimos4, moeda } = req.body;
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
    // Data informada À MÃO vira a palavra final: o sync do Open Finance para de
    // regravar esses dois campos (migration 114). Existe porque o banco às vezes
    // está errado — o Mercado Pago publica "fecha 12 / vence 17" enquanto o app
    // dele mostra 8 / 14, e sem isso a correção do usuário voltava atrás no dia
    // seguinte. Tolerante: se a 114 não rodou, o upsert cai no catch e segue.
    if (dia_fechamento !== undefined || dia_vencimento !== undefined) {
      row.datas_manuais = !!(dia_fechamento || dia_vencimento);
    }
    if (bandeira       !== undefined) row.bandeira       = bandeira || null;
    if (ultimos4       !== undefined) row.ultimos4       = ultimos4 || null;
    // Moeda da conta (migration 144). `normalizarMoeda` devolve 'BRL' pra
    // qualquer coisa fora do catálogo — é aqui que mora a validação, e NÃO num
    // CHECK do banco (três incidentes desta base foram CHECK falhando calado).
    if (moeda !== undefined) row.moeda = normalizarMoeda(moeda);

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
    // Mesma tolerância pra migration 144: sem ela, salvar conta continua
    // funcionando (só não guarda a moeda) em vez de quebrar o cadastro inteiro.
    if (error && /moeda/i.test(error.message || '')) {
      const { moeda: _dropM, ...semMoeda } = row;
      ({ data, error } = await supabase.from('wallets')
        .upsert(semMoeda, { onConflict: 'grupo_id,nome' })
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

// PUT /api/wallets/:id — edita a conta/cartão POR ID (inclusive RENOMEAR).
//
// ⚠️ POR QUE ESTA ROTA EXISTE: o `POST /` salva com
// `upsert(onConflict: 'grupo_id,nome')` — a chave é o NOME. Renomear por lá não
// renomeia nada: como não existe carteira com o nome novo, ele CRIA outra e a
// antiga fica intacta. Era o relato do cliente ("edito, salvo, mas permanece o
// nome Banco"). Vale pra qualquer carteira, não só as do Open Finance.
//
// ⚠️⚠️ RENOMEAR TEM DE CASCATEAR. Transação NÃO aponta pra wallet por id: ela
// guarda `carteira_nome` (texto). Renomear só a wallet transforma todo o
// histórico em conta-fantasma — o bug que o CLAUDE.md já registra. Medido na
// base: as 4 carteiras chamadas "Banco" têm 779 transações. As duas únicas
// tabelas que ligam por nome são `transacoes.carteira_nome` e
// `recorrencias.carteira` (conferido: `dividas`/`metas` não têm essa coluna).
//
// ✅ SEGURO PRO OPEN FINANCE: o sync casa a carteira por `of_conta_id`, nunca
// por nome, e o `upsertWallet` NÃO grava `nome` em carteira existente — ele
// devolve `ja.nome`, então os lançamentos novos já entram com o nome escolhido
// pelo usuário. Renomear não desliga nem duplica a conexão.
router.put('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const { data: atual } = await supabase.from('wallets')
      .select('*').eq('id', req.params.id).eq('grupo_id', grupoId).maybeSingle();
    if (!atual) return res.status(404).json({ erro: 'Conta não encontrada' });

    const {
      nome, tipo, saldo, limite, cheque_especial,
      dia_fechamento, dia_vencimento, bandeira, ultimos4, nos_previstos, moeda,
    } = req.body;

    const nomeNovo = typeof nome === 'string' ? nome.trim().slice(0, 60) : null;
    const renomeando = !!nomeNovo && nomeNovo !== atual.nome;

    // Nome duplicado no grupo quebraria o unique (grupo_id,nome) e, pior,
    // fundiria duas contas na visão das transações (que casam por nome).
    if (renomeando) {
      const { data: colide } = await supabase.from('wallets')
        .select('id').eq('grupo_id', grupoId).ilike('nome', nomeNovo)
        .neq('id', atual.id).maybeSingle();
      if (colide) {
        return res.status(409).json({
          erro: `Você já tem uma conta chamada "${nomeNovo}". Escolha outro nome.`,
          motivo: 'nome_duplicado',
        });
      }
    }

    const patch = {};
    if (renomeando)                    patch.nome   = nomeNovo;
    if (tipo   !== undefined)          patch.tipo   = tipo;
    if (saldo  !== undefined && saldo !== null) patch.saldo = saldo;
    if (limite !== undefined)          patch.limite = limite;
    if (cheque_especial !== undefined) patch.cheque_especial = Math.abs(Number(cheque_especial) || 0);
    if (bandeira !== undefined)        patch.bandeira = bandeira || null;
    if (ultimos4 !== undefined)        patch.ultimos4 = ultimos4 || null;
    // Tirar/colocar a fatura no card "Previstos do mês" (migration 123).
    if (nos_previstos !== undefined)   patch.nos_previstos = !!nos_previstos;
    if (dia_fechamento !== undefined)  patch.dia_fechamento = dia_fechamento || null;
    if (dia_vencimento !== undefined)  patch.dia_vencimento = dia_vencimento || null;
    // Data corrigida à mão vira a palavra final pro sync do OF (migration 114).
    if (dia_fechamento !== undefined || dia_vencimento !== undefined) {
      patch.datas_manuais = !!(dia_fechamento || dia_vencimento);
    }
    // Moeda da conta (migration 144).
    //
    // ⚠️ TROCAR A MOEDA NÃO CONVERTE O HISTÓRICO, de propósito. As transações
    // antigas já têm o BRL congelado em `valor` (com a taxa do dia de cada
    // uma), e reescrevê-las com o câmbio de hoje inventaria um passado que
    // nunca existiu. O `saldo` também fica como está: ele passa a ser lido na
    // moeda nova, e quem trocou por engano é quem sabe o número certo.
    if (moeda !== undefined) patch.moeda = normalizarMoeda(moeda);

    if (!Object.keys(patch).length) return res.json(atual);

    // Renomeia a WALLET primeiro: é a operação que pode falhar por constraint,
    // e falhar aqui não deixa rastro. Só depois mexemos nas 700+ transações.
    let { data, error } = await supabase.from('wallets')
      .update(patch).eq('id', atual.id).select().single();
    // Tolerante às migrations 094 (cheque_especial), 114 (datas_manuais) e
    // 123 (nos_previstos): tenta com tudo e refaz só com o essencial.
    if (error) {
      const { cheque_especial: _c, datas_manuais: _d, nos_previstos: _n, ...simples } = patch;
      // ⚠️ Sem nada pra regravar, a única mudança pedida era justamente a
      // coluna que não existe. Silenciar aqui faria o toggle "funcionar" na
      // tela e voltar sozinho no reload — pior que um erro claro.
      if (!Object.keys(simples).length) {
        return res.status(400).json({
          erro: 'Recurso ainda não liberado no banco. Rode a migration sql/123_cartao_nos_previstos.sql.',
        });
      }
      ({ data, error } = await supabase.from('wallets')
        .update(simples).eq('id', atual.id).select().single());
    }
    if (error) throw error;

    let movidas = 0;
    if (renomeando) {
      // `%` e `_` são curingas no ilike — sem escapar, uma conta "Banco_1"
      // arrastaria as transações de "Banco11" junto.
      const alvo = atual.nome.replace(/([%_\\])/g, '\\$1');
      const { count, error: eTx } = await supabase.from('transacoes')
        .update({ carteira_nome: nomeNovo }, { count: 'exact' })
        .eq('grupo_id', grupoId).ilike('carteira_nome', alvo);

      if (eTx) {
        // Cascata falhou → desfaz o rename pra NÃO deixar histórico órfão.
        await supabase.from('wallets').update({ nome: atual.nome }).eq('id', atual.id);
        return res.status(500).json({ erro: 'Não consegui renomear os lançamentos dessa conta. Nada foi alterado.' });
      }
      movidas = count || 0;

      // Recorrências apontam por nome também. Tolerante: falhar aqui não
      // justifica desfazer o rename (o histórico, que é o caro, já foi).
      try {
        await supabase.from('recorrencias').update({ carteira: nomeNovo })
          .eq('grupo_id', grupoId).ilike('carteira', alvo);
      } catch { /* segue */ }
    }

    res.json({ ...data, renomeada: renomeando || undefined, transacoes_movidas: movidas || undefined });
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
      .select('id, nome, dia_fechamento, dia_vencimento').eq('id', cartao_id).eq('grupo_id', grupoId).maybeSingle();

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
            categoria: CATEGORIA_FATURA, observacao: obs, userId: req.userId,
          });
      debitos.push(d);
    }

    // Registra o pagamento da fatura (rastreio parcial/rollover, migration 096).
    // competencia = a fatura sendo paga; sem ela no body, a ATUAL do cartão
    // (próximo vencimento pelo ciclo real — não o mês-calendário).
    const totalPago = itens.reduce((s, it) => s + it.valor, 0);
    const competencia = /^\d{4}-\d{2}$/.test(req.body.competencia || '')
      ? req.body.competencia
      : competenciaAtual(cartao || {});
    if (cartao_id && totalPago > 0) {
      try {
        await supabase.from('pagamentos_fatura').insert({
          grupo_id: grupoId, user_id: req.userId, cartao_id, competencia,
          valor: totalPago, transacao_id: debitos[0]?.tx?.id || null,
        });
      } catch { /* tolerante: migration 096 pode não ter rodado */ }
    }

    // Retorna `debito` (1º) pra retrocompat + `debitos` (todos) pro split.
    res.json({ ok: true, debito: debitos[0], debitos });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/wallets/fatura/status/:phone?cartao_id=&competencia=YYYY-MM
// Retorna { fatura, pago, restante, ciclo, rollover? } do cartão na competência
// (default = a fatura ATUAL do cartão pelo ciclo real, não o mês-calendário).
// Base do pagamento parcial + banner de rollover. (096)
router.get('/fatura/status/:phone', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const cartaoId = req.query.cartao_id;
    if (!cartaoId) return res.status(400).json({ erro: 'cartao_id obrigatório' });

    const { data: cartao } = await supabase.from('wallets')
      .select('id, nome, of_conta_id, saldo, dia_fechamento, dia_vencimento')
      .eq('id', cartaoId).eq('grupo_id', grupoId).maybeSingle();
    if (!cartao) return res.status(404).json({ erro: 'Cartão não encontrado.' });

    const competencia = /^\d{4}-\d{2}$/.test(req.query.competencia || '')
      ? req.query.competencia
      : competenciaAtual(cartao);

    const st = await statusFatura(grupoId, cartao, competencia);
    const vista = await vistaDaFatura(cartao, competencia, st);

    // Rollover aguardando confirmação (se a tabela existir).
    let rollover = null;
    try {
      const { data } = await supabase.from('fatura_rollover')
        .select('id, valor, competencia, status, confirmar_ate')
        .eq('cartao_id', cartaoId).eq('status', 'aguardando')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (data) rollover = data;
    } catch { /* tolerante à 096 */ }

    // Parcelas que o banco já sabe que vão cair nesta fatura e que a Sora não
    // tem como transação (o Mercado Pago manda parcela sem o marcador "N/M").
    // É PROJEÇÃO (migration 116) — some e é regravada a cada sync. Só existe
    // pra competência FUTURA: na fatura em curso a compra já veio pelo extrato
    // e somar as duas fontes contaria em dobro.
    // Leitura tolerante: sem a migration 118 devolve null e a tela cai no ciclo.
    let billDaComp = null;
    try {
      const { data: pf } = await supabase.from('of_faturas')
        .select('of_bill_id').eq('cartao_id', cartaoId).eq('competencia', competencia).maybeSingle();
      billDaComp = pf ? pf.of_bill_id : null;
    } catch { /* 118 pendente */ }

    const { linhas: previstas, total: totalPrevisto } = await parcelasPrevistasDe(cartaoId, competencia);

    res.json({
      ...st, ...vista, competencia, rollover,
      // Fatura do EMISSOR nesta competência — o modal usa pra agrupar os
      // lançamentos como o banco agrupa (pertenceAFatura, modo híbrido).
      of_bill_id: billDaComp,
      parcelas_previstas: previstas, total_previsto: totalPrevisto,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/wallets/faturas/:phone?offset=0
// Faturas de TODOS os cartões do grupo em UMA chamada (o painel fazia N
// chamadas de /fatura/status, uma por cartão). `offset` navega entre faturas
// pelo CICLO: 0 = a atual (próximo vencimento), -1 = anterior, +1 = próxima.
//
// Cada item traz o período do ciclo (`ini`/`fim`/`label`) pra a UI poder
// mostrar "Fatura de agosto · 25/06 a 24/07" sem recalcular nada.
// Cartão do Open Finance: a fatura vem do BANCO (`-saldo`, já sem parcelas a
// vencer) — não somamos transações. Cartão sem dia_fechamento → mês-calendário.
router.get('/faturas/:phone', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo || req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const offset = parseInt(req.query.offset, 10) || 0;
    const hoje = hojeSP();

    // ⚠️ `select('*')` de propósito: `nos_previstos` é da migration 123 e, se
    // ela ainda não rodou, um select por NOME de coluna falha inteiro e a tela
    // de faturas some. Com '*' a coluna ausente simplesmente não vem (mesma
    // lição do `datas_manuais` no upsertWallet).
    const { data: cartoes } = await supabase.from('wallets')
      .select('*')
      .eq('grupo_id', grupoId).eq('tipo', 'Crédito').order('created_at', { ascending: true });

    const faturas = [];
    for (const c of cartoes || []) {
      const compAtual = competenciaAtual(c);
      const competencia = offset === 0 ? compAtual : competenciaVizinha(c, compAtual, offset);
      const ciclo = cicloPorCompetencia(c, competencia);
      const ehOF = !!c.of_conta_id;

      // Mesma conta da rota de status — fonte única (ver `valorExibido`).
      const st = await statusFatura(grupoId, c, competencia);
      const { fatura, pago, restante, quitada } = await vistaDaFatura(c, competencia, st);

      // Fatura ANTERIOR que já venceu e ainda tem saldo: sem isto ela sumiria da
      // tela (a "atual" é sempre a próxima a vencer, que pode estar vazia) e o
      // usuário perderia de vista uma dívida real até o rollover rodar.
      let vencida = null;
      if (!ehOF && offset === 0) {
        try {
          const compAnt = competenciaVizinha(c, competencia, -1);
          const cicloAnt = cicloPorCompetencia(c, compAnt);
          if (cicloAnt.venc < hoje) {
            const stAnt = await statusFatura(grupoId, c, compAnt);
            if (stAnt.restante > 0.01) {
              vencida = { competencia: compAnt, venc: cicloAnt.venc, restante: stAnt.restante, label: cicloAnt.label };
            }
          }
        } catch { /* informativo — nunca derruba a listagem */ }
      }

      // ⚠️ FATURA FECHADA E QUITADA: a tela precisa saber quanto vale a
      // SEGUINTE, que é a que está viva. Sem isto o dashboard mostra R$ 0,00
      // num cartão com compras novas — caso real medido: o EQI BLACK fechou
      // 15/08, foi pago, e no dia 19 o dashboard exibia R$ 0,00 enquanto a aba
      // de cartões exibia R$ 1.243,02 (as compras de 15 a 18/08). Duas telas,
      // dois números, no mesmo cartão e no mesmo dia.
      //
      // A aba de cartões já pulava sozinha (CartaoClient), o dashboard não —
      // então o pulo passa a vir PRONTO daqui, e as duas bebem da mesma fonte.
      // Só é calculado quando realmente pula: uma consulta a mais por cartão
      // quitado, não por cartão.
      let proxima = null;
      if (offset === 0 && quitada && ciclo.fim < hoje) {
        try {
          const compProx = competenciaVizinha(c, competencia, 1);
          const cicloProx = cicloPorCompetencia(c, compProx);
          const stProx = await statusFatura(grupoId, c, compProx);
          const vProx = await vistaDaFatura(c, compProx, stProx);
          proxima = {
            competencia: compProx, restante: vProx.restante, fatura: vProx.fatura,
            venc: cicloProx.venc, label: cicloProx.label,
          };
        } catch { /* informativo — nunca derruba a listagem */ }
      }

      // Parcelas que o banco conhece e a Sora não (só em fatura FUTURA — ver
      // parcelasPrevistasDe). Entram como parcela SEPARADA do total: quem soma
      // as transações continua sendo `somarFatura`, intocado.
      // Leitura tolerante: sem a 118 devolve vazio e a tela cai no ciclo.
      let publicadaDaComp = null;
      try {
        const { data: pf } = await supabase.from('of_faturas')
          .select('of_bill_id').eq('cartao_id', c.id).eq('competencia', competencia).maybeSingle();
        publicadaDaComp = pf || null;
      } catch { /* migration 118 pendente */ }

      const prev = await parcelasPrevistasDe(c.id, competencia);

      faturas.push({
        cartao_id: c.id, nome: c.nome, limite: c.limite ?? null,
        competencia, ini: ciclo.ini, fim: ciclo.fim, fimExcl: ciclo.fimExcl,
        venc: ciclo.venc, label: ciclo.label, porCiclo: ciclo.porCiclo,
        of: ehOF, fatura, pago, restante, vencida, quitada, proxima,
        // Fatura do EMISSOR nesta competência. É o que permite a tela agrupar
        // os lançamentos como o banco agrupa, em vez de só pela data da compra
        // (ver `pertenceAFatura` modo híbrido). Vem de of_faturas (118).
        of_bill_id: publicadaDaComp ? publicadaDaComp.of_bill_id : null,
        fechada: ciclo.fim < hoje,
        parcelas_previstas: prev.linhas, total_previsto: prev.total,
        // Entra no card "Previstos do mês"? (migration 123). Sem a coluna,
        // `undefined !== false` → true, que é o padrão desejado.
        nos_previstos: c.nos_previstos !== false,
      });
    }

    // Rollovers aguardando confirmação (1 query pra todos os cartões).
    try {
      const ids = (cartoes || []).map(c => c.id);
      if (ids.length) {
        const { data: rolls } = await supabase.from('fatura_rollover')
          .select('id, cartao_id, valor, competencia, status, confirmar_ate')
          .in('cartao_id', ids).eq('status', 'aguardando');
        for (const r of rolls || []) {
          const f = faturas.find(x => x.cartao_id === r.cartao_id);
          if (f) f.rollover = r;
        }
      }
    } catch { /* tolerante à 096 */ }

    res.json({ offset, faturas });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/wallets/fatura/rolar — confirma o rollover (materializa agora).
// Body: { rollover_id } OU { cartao_id, competencia } (cria+rola se ainda não existe).
router.post('/fatura/rolar', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId || req.authUser?.grupoAtivo;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { rollover_id, cartao_id, competencia } = req.body;

    let row = null;
    if (rollover_id) {
      const { data } = await supabase.from('fatura_rollover').select('*').eq('id', rollover_id).eq('grupo_id', grupoId).maybeSingle();
      row = data;
    } else if (cartao_id && /^\d{4}-\d{2}$/.test(competencia || '')) {
      // Cria o rollover na hora (usuário pediu pra rolar direto do painel).
      const { data: cartao } = await supabase.from('wallets')
        .select('id, nome, dia_fechamento, dia_vencimento')
        .eq('id', cartao_id).eq('grupo_id', grupoId).maybeSingle();
      if (!cartao) return res.status(404).json({ erro: 'Cartão não encontrado.' });
      const st = await statusFatura(grupoId, cartao, competencia);
      if (st.restante <= 0) return res.status(400).json({ erro: 'Fatura já quitada — nada a rolar.' });
      const { data } = await supabase.from('fatura_rollover').upsert({
        grupo_id: grupoId, user_id: req.userId, cartao_id, competencia, valor: st.restante, status: 'aguardando',
      }, { onConflict: 'cartao_id,competencia' }).select().single();
      row = data;
    }
    if (!row) return res.status(404).json({ erro: 'Rollover não encontrado.' });
    if (row.status === 'rolado') return res.json({ ok: true, jaRolado: true });

    const { data: cartao } = await supabase.from('wallets')
      .select('id, nome, dia_fechamento, dia_vencimento').eq('id', row.cartao_id).maybeSingle();
    const tx = await materializarRollover(row, cartao?.nome || 'cartão', cartao);
    res.json({ ok: true, transacao_id: tx?.id || null });
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