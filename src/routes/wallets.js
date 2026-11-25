const express  = require('express');
const { CATEGORIA_FATURA } = require('../services/categorizar');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { debitarConta, registrarTransferencia, registrarFaturaExterna } = require('../services/contaDebito');
const { statusFatura, rolarFatura } = require('../services/faturaRollover');
const { faturasAtrasadas, situacaoDaFatura } = require('../services/faturaAtrasada');
const { podeDesfazer, planoDeDesfazer } = require('../services/desfazerPagamentoFatura');
const { moverSaldo } = require('../services/saldoCarteira');
const { competenciaAtual, cicloPorCompetencia, competenciaVizinha, hojeSP } = require('../services/cicloFatura');
const { valorExibido } = require('../services/faturaVista');
const { marcarDaEmpresa } = require('../services/contaDaEmpresa');
const norm     = p => p?.replace(/\D/g, '');

/** Aritmética do valor exibido — fonte única em services/faturaVista.js. */
const vistaDaFatura = (cartao, competencia, st) =>
  valorExibido(cartao, competencia, st, { parcelasPrevistas: parcelasPrevistasDe });

// Parcelas a vencer projetadas pelo sync do Open Finance (migration 116).
// A leitura mora em services/parcelasPrevistas.js pra ser a MESMA da agenda.
const { lerPrevistas: parcelasPrevistasDe } = require('../services/parcelasPrevistas');
const { mapEmOrdem, memoPorRequisicao } = require('../services/emParalelo');

// Moeda da carteira (migration 144). A CONVERSÃO MORA NO BACKEND de propósito:
// o painel recebe `saldo_brl` pronto e não precisa buscar câmbio no navegador —
// senão cada uma das 5 telas que somam saldo teria a sua própria cotação, e
// elas divergiriam entre si.
const {
  normalizarMoeda, moedaBaseDoGrupo, comSaldoNaBase,
  taxasParaBase, taxaEntre, cartaoForaDaBase, motivoCartaoForaDaBase,
} = require('../services/moeda');

/**
 * Campos de moeda de uma fatura (migration 168). A fatura sai NA MOEDA DO
 * CARTÃO — é o número que o app do banco mostra — e `taxa_base` leva pra moeda
 * do grupo quem SOMA cartões. Cartão na base (hoje, toda a base) sai com taxa 1.
 * `bloqueio_pagamento` é o texto do porquê de não aceitar pagamento/antecipação
 * manual, ou null — em grupo em real é SEMPRE null.
 */
function camposMoedaFatura(cartao, base, tabela) {
  return {
    moeda: normalizarMoeda(cartao.moeda),
    moeda_base: base,
    taxa_base: taxaEntre(cartao.moeda, base, tabela),
    bloqueio_pagamento: cartaoForaDaBase(cartao, base) ? motivoCartaoForaDaBase(cartao, base) : null,
  };
}

/** Tabela de câmbio dos cartões até a base. Sem cartão fora da base: `{}`, sem rede. */
async function tabelaDosCartoes(cartoes, base) {
  try { return await taxasParaBase((cartoes || []).map((c) => c.moeda), base); } catch { return {}; }
}

// A conversão mora em `services/moeda.js` (comSaldoNaBase) — o `/api/dashboard`
// precisa da MESMA, e enquanto ela viveu aqui só esta rota convertia.

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
    // Saldos também na moeda BASE do grupo (migration 168): `saldo_base`.
    // `da_empresa`: carteira ligada a uma conta do Sora Negócios com "só da
    // empresa" — o painel a tira do saldo pessoal (services/contaDaEmpresa.js).
    res.json(await comSaldoNaBase(await marcarDaEmpresa(data), await moedaBaseDoGrupo(grupoId)));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/wallets
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { nome, tipo, saldo, limite, cheque_especial,
            dia_fechamento, dia_vencimento, bandeira, ultimos4, moeda,
            fechamento_dia_proxima } = req.body;
    const grupoId = req.grupoId; // grupo do usuário autenticado (exigirPermissao)
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    // Saldo ANTES do upsert: se a conta já existe e o saldo muda, a diferença
    // vira Ajuste (rastro). Se é CRIAÇÃO, o saldo é abertura (patrimônio) e NÃO
    // gera transação — você já tinha o dinheiro, não recebeu agora.
    const { data: antes } = await supabase.from('wallets')
      .select('id, saldo, of_conta_id').eq('grupo_id', grupoId).eq('nome', nome).maybeSingle();

    const row = { grupo_id: grupoId, nome, tipo, saldo, limite };
    // ⚠️ CONTA DO OPEN FINANCE: o saldo é o do banco (regra de ouro). Gravar o
    // que veio do painel duraria até o próximo sync — e ainda deixaria um
    // lançamento de Ajuste sem dinheiro por trás. O resto da edição vale.
    const saldoDoBanco = !!(antes && antes.of_conta_id);
    if (saldoDoBanco) delete row.saldo;
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
    // "Compra no dia do fechamento vai pra próxima fatura" (migration 200).
    // Só entra quando LIGADA, num cartão de crédito que não é do Open Finance
    // (lá a data do lançamento no banco já decide — ver services/cicloFatura).
    if (fechamento_dia_proxima === true && tipo === 'Crédito' && !(antes && antes.of_conta_id)) {
      row.fechamento_dia_proxima = true;
    }
    // Moeda da conta (migration 144). `normalizarMoeda` devolve 'BRL' pra
    // qualquer coisa fora do catálogo — é aqui que mora a validação, e NÃO num
    // CHECK do banco (três incidentes desta base foram CHECK falhando calado).
    if (moeda !== undefined) row.moeda = normalizarMoeda(moeda);
    // ⚠️ CONTA NOVA SEM MOEDA NASCE NA BASE DO GRUPO (migration 168), não em
    //    real. A coluna tem default 'BRL' até a migration 169 trocá-lo por um
    //    gatilho; sem isto, num grupo em dólar o cartão criado pelo painel
    //    (que não manda moeda) viraria conta em real. Só na CRIAÇÃO: numa
    //    edição sem moeda, o upsert não pode reescrever a moeda que já existe.
    else if (!antes) row.moeda = await moedaBaseDoGrupo(grupoId);

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
    if (antes && !saldoDoBanco && saldo !== undefined && saldo !== null) {
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
/**
 * POST /api/wallets/:id/soltar — devolve uma conta ÓRFÃ ao uso manual.
 *
 * ⚠️ O LIMBO QUE ISTO RESOLVE: terminada a conexão (a pessoa desconectou, o
 * consentimento expirou, ou nós cortamos), a carteira CONTINUA com
 * `of_conta_id` — e `services/saldoCarteira.js` pula toda carteira que o
 * tenha. O sync não roda mais, o saldo congela, e o lançamento manual não o
 * move. A única saída era criar OUTRA conta com o mesmo nome, PARTINDO o
 * histórico: já aconteceu na base ("BTG Banking" 321 transações convivendo com
 * "BTG Banking (OF)" 540).
 *
 * Medido em 07/10/2026: 16 carteiras nesse estado, R$ 18.103,97 congelados e
 * 2.370 transações presas — e o corte por excedente criaria mais 40.
 *
 * ⚠️ SÓ A ÓRFÃ. Soltar uma carteira com conexão VIVA faria o sync recriar outra
 * no passe seguinte — o mesmo estrago, pela porta oposta. E a lista de conexões
 * tem de ser LIDA COM SUCESSO: falha de leitura recusa, nunca assume órfã.
 */
router.post('/:id/soltar', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId;
    const { data: w, error: erroLer } = await supabase.from('wallets')
      .select('id, nome, tipo, of_conta_id, of_consent_id')
      .eq('id', req.params.id).eq('grupo_id', grupoId).maybeSingle();
    if (erroLer) return res.status(500).json({ erro: `Não consegui ler a conta: ${erroLer.message}` });

    // As conexões VIVAS do grupo. `null` quando a leitura falhou — e aí o
    // serviço recusa, em vez de tratar o silêncio como "não há conexão".
    let vivos = null;
    try {
      const { data: cx, error } = await supabase.from('of_conexoes')
        .select('external_id').eq('grupo_id', grupoId);
      if (!error) vivos = new Set((cx || []).map((c) => String(c.external_id)));
    } catch { vivos = null; }

    const { podeSoltar, planoDeSoltar } = require('../services/soltarCarteira');
    const veredito = podeSoltar(w, vivos);
    if (!veredito.pode) {
      const code = veredito.motivo === 'nao_encontrada' ? 404
        : veredito.motivo === 'conexoes_indisponiveis' ? 503 : 409;
      return res.status(code).json({ erro: veredito.erro, motivo: veredito.motivo });
    }

    // ⚠️ O erro do update é LIDO: descartá-lo responderia 200 e a tela diria
    // que soltou, com a conta seguindo presa (defeito das migrations 121/147).
    const { data, error } = await supabase.from('wallets')
      .update(planoDeSoltar()).eq('id', w.id).eq('grupo_id', grupoId).select().single();
    if (error) return res.status(500).json({ erro: `Não consegui soltar a conta: ${error.message}` });

    console.log(`🔓 carteira solta do banco: ${w.nome} (grupo ${grupoId})`);
    res.json({ ok: true, wallet: data });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

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
      conta_pagamento_id, fechamento_dia_proxima,
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
    // Conta do Open Finance: o saldo é o do banco (regra de ouro).
    if (saldo  !== undefined && saldo !== null && !atual.of_conta_id) patch.saldo = saldo;
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

    // De qual CONTA sai o pagamento da fatura (migration 170) — é o que põe a
    // fatura no Extrato Futuro daquela conta. Só em cartão, só apontando pra
    // uma conta de DÉBITO do MESMO grupo (senão um id qualquer ligaria o cartão
    // à conta de outra família). `null` desfaz a escolha.
    if (conta_pagamento_id !== undefined) {
      if (atual.tipo !== 'Crédito') {
        return res.status(400).json({ erro: 'Só cartão de crédito tem conta de pagamento.' });
      }
      if (conta_pagamento_id === null || conta_pagamento_id === '') {
        patch.conta_pagamento_id = null;
      } else {
        const { data: conta } = await supabase.from('wallets')
          .select('id, tipo').eq('id', conta_pagamento_id).eq('grupo_id', grupoId).maybeSingle();
        if (!conta || conta.tipo === 'Crédito') {
          return res.status(400).json({ erro: 'Escolha uma conta bancária deste grupo para pagar a fatura.' });
        }
        patch.conta_pagamento_id = conta.id;
      }
    }

    // "Compra no dia do fechamento vai pra próxima fatura" (migration 200,
    // sugestão do Arisson). Por CARTÃO e só em cartão MANUAL: medido, a regra
    // vale pra maioria dos bancos mas não pra todos, e no Open Finance a data
    // do lançamento no banco já resolve (ligar lá empurraria duas vezes).
    if (fechamento_dia_proxima !== undefined) {
      if (typeof fechamento_dia_proxima !== 'boolean') {
        return res.status(400).json({ erro: 'fechamento_dia_proxima tem de ser true ou false.' });
      }
      if (atual.tipo !== 'Crédito') {
        return res.status(400).json({ erro: 'Só cartão de crédito tem dia de fechamento.' });
      }
      if (fechamento_dia_proxima && atual.of_conta_id) {
        return res.status(400).json({ erro: 'Este cartão vem do banco pelo Open Finance: a fatura já segue a data em que o banco lança cada compra.' });
      }
      patch.fechamento_dia_proxima = fechamento_dia_proxima;
    }

    if (!Object.keys(patch).length) return res.json(atual);

    // Renomeia a WALLET primeiro: é a operação que pode falhar por constraint,
    // e falhar aqui não deixa rastro. Só depois mexemos nas 700+ transações.
    let { data, error } = await supabase.from('wallets')
      .update(patch).eq('id', atual.id).select().single();
    // Tolerante às migrations 094 (cheque_especial), 114 (datas_manuais) e
    // 123 (nos_previstos): tenta com tudo e refaz só com o essencial.
    // ⚠️ A conta de pagamento NÃO entra no refazer-sem-a-coluna: se ela foi
    // pedida e a 170 não rodou, o certo é dizer isso, e não fingir que salvou.
    if (error && patch.fechamento_dia_proxima !== undefined && /fechamento_dia_proxima/i.test(error.message || '')) {
      return res.status(400).json({ erro: 'Esta opção ainda está sendo liberada. Tente de novo em alguns minutos.' });
    }
    if (error && patch.conta_pagamento_id !== undefined && /conta_pagamento_id/i.test(error.message || '')) {
      return res.status(400).json({
        erro: 'Recurso ainda não liberado no banco. Rode a migration sql/170_cartao_conta_pagamento.sql.',
      });
    }
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
      .select('id, nome, dia_fechamento, dia_vencimento, fechamento_dia_proxima, moeda, of_conta_id').eq('id', cartao_id).eq('grupo_id', grupoId).maybeSingle();

    // ⚠️ CARTÃO EM OUTRA MOEDA QUE A DO GRUPO (migration 168) não aceita
    // pagamento manual — ver moeda.cartaoForaDaBase. Recusa ANTES de debitar
    // qualquer conta. Grupo em real nunca cai aqui.
    const baseGrupo = await moedaBaseDoGrupo(grupoId);
    if (cartaoForaDaBase(cartao, baseGrupo)) {
      return res.status(409).json({ erro: motivoCartaoForaDaBase(cartao, baseGrupo), codigo: 'cartao_outra_moeda' });
    }

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

// =====================================================================
// GET    /api/wallets/fatura/pagamentos/:phone?cartao_id=&competencia=
// DELETE /api/wallets/fatura/pagamento/:id
//
// Desfazer um pagamento de fatura lançado por engano. Até aqui não existia —
// nem listar, nem apagar. Ver `services/desfazerPagamentoFatura.js` para por
// que apagar só o lançamento (o caminho intuitivo) deixa a conta PIOR.
// =====================================================================
router.get('/fatura/pagamentos/:phone', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const cartaoId = req.query.cartao_id;
    if (!cartaoId) return res.status(400).json({ erro: 'cartao_id obrigatório' });

    let q = supabase.from('pagamentos_fatura')
      .select('id, competencia, valor, data, transacao_id, created_at')
      .eq('grupo_id', grupoId).eq('cartao_id', cartaoId)
      .order('created_at', { ascending: false });
    if (/^\d{4}-\d{2}$/.test(req.query.competencia || '')) {
      q = q.eq('competencia', req.query.competencia);
    }
    // ⚠️ Tolerante à migration 096: sem a tabela a tela só não mostra a lista,
    // em vez de quebrar o modal inteiro do cartão.
    const { data, error } = await q;
    if (error) return res.json({ pagamentos: [] });

    // De qual conta saiu cada um — é o que a confirmação precisa dizer.
    const txIds = (data || []).map((p) => p.transacao_id).filter(Boolean);
    const porTx = {};
    if (txIds.length) {
      const { data: txs } = await supabase.from('transacoes')
        .select('id, carteira_nome').in('id', txIds);
      for (const t of (txs || [])) porTx[t.id] = t;
    }

    res.json({
      pagamentos: (data || []).map((p) => ({
        ...p,
        // `null` quando a transação não existe mais (ou nunca existiu, no
        // pagamento externo) — a tela diz isso em vez de inventar uma conta.
        conta: p.transacao_id ? (porTx[p.transacao_id]?.carteira_nome ?? null) : null,
        transacao_existe: p.transacao_id ? !!porTx[p.transacao_id] : false,
      })),
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/fatura/pagamento/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    // ⚠️ ESCOPO PELO GRUPO NA PRÓPRIA CONSULTA, nunca só pelo id da URL —
    // senão qualquer um apaga o pagamento de qualquer conta.
    const { data: pagamento } = await supabase.from('pagamentos_fatura')
      .select('id, grupo_id, cartao_id, competencia, valor, transacao_id')
      .eq('id', req.params.id).eq('grupo_id', grupoId).maybeSingle();
    if (!pagamento) return res.status(404).json({ erro: 'Pagamento não encontrado.' });

    const { data: cartao } = await supabase.from('wallets')
      .select('id, nome, of_conta_id').eq('id', pagamento.cartao_id).maybeSingle();

    // Rollover daquela competência — se a sobra já virou lançamento na fatura
    // seguinte, desfazer aqui deixaria as duas erradas.
    let rollover = null;
    try {
      const { data } = await supabase.from('fatura_rollover')
        .select('id, status').eq('cartao_id', pagamento.cartao_id)
        .eq('competencia', pagamento.competencia).maybeSingle();
      rollover = data || null;
    } catch { /* tabela pode não existir */ }

    const veredito = podeDesfazer({ pagamento, cartao, rollover });
    if (!veredito.ok) return res.status(409).json({ erro: veredito.motivo, codigo: veredito.codigo });

    // A transação e a conta de onde saiu.
    let transacao = null;
    if (pagamento.transacao_id) {
      const { data } = await supabase.from('transacoes')
        .select('id, valor, valor_moeda, carteira_nome')
        .eq('id', pagamento.transacao_id).eq('grupo_id', grupoId).maybeSingle();
      transacao = data || null;
    }
    let carteira = null;
    if (transacao?.carteira_nome) {
      const { data } = await supabase.from('wallets')
        .select('id, nome, saldo, of_conta_id').eq('grupo_id', grupoId)
        .ilike('nome', transacao.carteira_nome).maybeSingle();
      carteira = data || null;
    }

    const plano = planoDeDesfazer({ pagamento, transacao, carteira });

    // ⚠️ A LINHA DE PAGAMENTO SAI PRIMEIRO, E É ELA QUE SEGURA A CORRIDA.
    // O delete devolve as linhas afetadas: se vier VAZIO, outro toque já
    // desfez e paramos aqui — sem isso, dois toques devolveriam o saldo DUAS
    // vezes, criando dinheiro que nunca existiu.
    const { data: apagados, error: erroDel } = await supabase
      .from('pagamentos_fatura').delete()
      .eq('id', pagamento.id).eq('grupo_id', grupoId).select('id');
    if (erroDel) return res.status(500).json({ erro: erroDel.message });
    if (!apagados || !apagados.length) return res.json({ ok: true, jaDesfeito: true });

    // Devolve o saldo ANTES de apagar a transação: se a devolução falhar, o
    // lançamento ainda está lá e o estado continua explicável.
    // ⚠️ A guarda `plano.devolverSaldo` é redundante por dois caminhos — o
    // `valorDevolvido` já vem 0 quando não se deve devolver, e `moverSaldo`
    // recusa conta de Open Finance por conta própria. Fica assim mesmo, e a
    // mutação que a remove sobrevive de propósito: é dinheiro, e prefiro a
    // decisão explícita a depender de dois acidentes felizes.
    let saldoDevolvido = false;
    if (plano.devolverSaldo && carteira) {
      saldoDevolvido = await moverSaldo(carteira, plano.valorDevolvido);
    }
    if (plano.apagarTransacao) {
      await supabase.from('transacoes').delete()
        .eq('id', transacao.id).eq('grupo_id', grupoId);
    }

    res.json({
      ok: true,
      valor: plano.valorPagamento,
      competencia: pagamento.competencia,
      saldoDevolvido,
      valorDevolvido: saldoDevolvido ? plano.valorDevolvido : 0,
      conta: carteira?.nome || null,
      contaDoBanco: plano.contaDoBanco,
    });
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
      .select('id, nome, of_conta_id, saldo, dia_fechamento, dia_vencimento, fechamento_dia_proxima, moeda, of_limite_usado')
      .eq('id', cartaoId).eq('grupo_id', grupoId).maybeSingle();
    if (!cartao) return res.status(404).json({ erro: 'Cartão não encontrado.' });
    const baseGrupo = await moedaBaseDoGrupo(grupoId);

    const competencia = /^\d{4}-\d{2}$/.test(req.query.competencia || '')
      ? req.query.competencia
      : competenciaAtual(cartao);

    const st = await statusFatura(grupoId, cartao, competencia);
    const vista = await vistaDaFatura(cartao, competencia, st);

    // Rollover aguardando confirmação (se a tabela existir) + o desta
    // competência, se ela já foi passada pra frente.
    let rollover = null;
    let rolagem = null;
    try {
      const [{ data: aguard }, { data: daComp }] = await Promise.all([
        supabase.from('fatura_rollover')
          .select('id, valor, competencia, status, confirmar_ate')
          .eq('cartao_id', cartaoId).eq('status', 'aguardando')
          .order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('fatura_rollover')
          .select('id, valor, competencia, status, rolado_em')
          .eq('cartao_id', cartaoId).eq('competencia', competencia).eq('status', 'rolado').maybeSingle(),
      ]);
      if (aguard) rollover = aguard;
      if (daComp) rolagem = daComp;
    } catch { /* tolerante à 096 */ }

    // Situação pra tela não dizer "Em aberto" numa fatura que venceu — nem
    // "Atrasada" numa que a pessoa já passou pra frente.
    const situacao = situacaoDaFatura({
      venc: st.ciclo?.venc, hoje: hojeSP(), restante: vista.restante,
      rolada: !!rolagem, ehOF: !!cartao.of_conta_id,
    });

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
      ...st, ...vista, competencia, rollover, rolagem, situacao,
      ...camposMoedaFatura(cartao, baseGrupo, await tabelaDosCartoes([cartao], baseGrupo)),
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

    // ⚠️ AS LEITURAS SAEM EM PARALELO (nov/2026) — e o resultado é o MESMO.
    //
    // Medido em produção com Server-Timing (Ohio, mesma região do banco): esta
    // rota fazia 27 idas ao Supabase, 21 EM SÉRIE, ~20–25 ms cada — 458 ms dos
    // 471 do servidor eram espera de banco; cálculo, 46 ms. O laço esperava um
    // cartão inteiro antes de começar o próximo, e dentro do cartão cada
    // leitura esperava a anterior mesmo sem depender dela.
    //
    // Agora: os cartões rodam juntos (no máximo 4 de cada vez — `mapEmOrdem`
    // devolve NA ORDEM dos cartões), e dentro de cada um o que não depende da
    // fatura atual (atrasadas, fatura publicada, parcelas previstas) sai junto
    // com ela. Nada aqui grava — é só leitura, então a ordem de espera não muda
    // o resultado. Conferido comparando a resposta antiga e a nova, byte a
    // byte, em todos os grupos com cartão (ver o commit).
    //
    // ⚠️ Erro em `statusFatura`/`vistaDaFatura` continua derrubando a rota
    // (500), como antes: `mapEmOrdem` para de começar cartões novos e repassa.

    // Moeda de cada fatura (migration 168) — ver camposMoedaFatura.
    // Rollovers dos cartões (aguardando + rolados) numa ida só: o aguardando vai
    // pro payload como sempre, e o ROLADO encerra a busca de atrasadas — a fatura
    // passada pra frente não é mais dívida dela, é da seguinte.
    const lerRollovers = async () => {
      try {
        const ids = (cartoes || []).map((c) => c.id);
        if (!ids.length) return [];
        const { data } = await supabase.from('fatura_rollover')
          .select('id, cartao_id, valor, competencia, status, confirmar_ate')
          .in('cartao_id', ids).in('status', ['aguardando', 'rolado']);
        return data || [];
      } catch { return []; /* tolerante à 096 */ }
    };
    const [{ baseGrupo, tabelaCartoes }, rollovers] = await Promise.all([
      (async () => {
        const base = await moedaBaseDoGrupo(grupoId);
        return { baseGrupo: base, tabelaCartoes: await tabelaDosCartoes(cartoes, base) };
      })(),
      lerRollovers(),
    ]);

    // As parcelas previstas do mesmo cartão e competência são lidas por
    // `vistaDaFatura` (dentro do valor) E por esta rota (pra lista): a MESMA
    // leitura, uma vez só. Ninguém altera o resultado (faturaVista só lê o total).
    const previstasDaReq = memoPorRequisicao(parcelasPrevistasDe);
    const vistaDaReq = (cartao, competencia, st) =>
      valorExibido(cartao, competencia, st, { parcelasPrevistas: previstasDaReq });

    const faturas = await mapEmOrdem(cartoes || [], 4, async (c) => {
      const compAtual = competenciaAtual(c);
      const competencia = offset === 0 ? compAtual : competenciaVizinha(c, compAtual, offset);
      const ciclo = cicloPorCompetencia(c, competencia);
      const ehOF = !!c.of_conta_id;

      // Mesma conta da rota de status — fonte única (ver `valorExibido`).
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
      const atualEProxima = async () => {
        const st = await statusFatura(grupoId, c, competencia);
        const vista = await vistaDaReq(c, competencia, st);
        let proxima = null;
        // "Já fechou" = o ÚLTIMO dia da fatura passou (com a opção "dia do
        // fechamento vai pra próxima", migration 200, é a véspera do fechamento).
        if (offset === 0 && vista.quitada && (ciclo.ultimo || ciclo.fim) < hoje) {
          try {
            const compProx = competenciaVizinha(c, competencia, 1);
            const cicloProx = cicloPorCompetencia(c, compProx);
            const stProx = await statusFatura(grupoId, c, compProx);
            const vProx = await vistaDaReq(c, compProx, stProx);
            proxima = {
              competencia: compProx, restante: vProx.restante, fatura: vProx.fatura,
              venc: cicloProx.venc, label: cicloProx.label,
            };
          } catch { /* informativo — nunca derruba a listagem */ }
        }
        return { vista, proxima };
      };

      // Faturas que JÁ VENCERAM e não foram pagas (cartão manual). Sem isto elas
      // somem da tela: a "atual" é sempre a próxima a vencer, e o cliente lia o
      // salto pra fatura seguinte como se a vencida estivesse paga (relato de
      // nov/2026). Regra única em services/faturaAtrasada.js.
      const lerAtrasadas = async () => {
        if (ehOF || offset !== 0) return [];
        try {
          const roladas = new Set(rollovers
            .filter((r) => r.cartao_id === c.id && r.status === 'rolado')
            .map((r) => r.competencia));
          const criadoEm = c.created_at
            ? new Date(c.created_at).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })
            : null;
          return await faturasAtrasadas(c, {
            hoje, roladas, criadoEm,
            status: (comp) => statusFatura(grupoId, c, comp),
          });
        } catch { return []; /* informativo — nunca derruba a listagem */ }
      };

      // Parcelas que o banco conhece e a Sora não (só em fatura FUTURA — ver
      // parcelasPrevistasDe). Entram como parcela SEPARADA do total: quem soma
      // as transações continua sendo `somarFatura`, intocado.
      // Leitura tolerante: sem a 118 devolve vazio e a tela cai no ciclo.
      const lerPublicada = async () => {
        try {
          const { data: pf } = await supabase.from('of_faturas')
            .select('of_bill_id').eq('cartao_id', c.id).eq('competencia', competencia).maybeSingle();
          return pf || null;
        } catch { return null; /* migration 118 pendente */ }
      };

      const [{ vista, proxima }, atrasadas, publicadaDaComp, prev] = await Promise.all([
        atualEProxima(), lerAtrasadas(), lerPublicada(), previstasDaReq(c.id, competencia),
      ]);
      const { fatura, pago, restante, quitada } = vista;
      // Compatibilidade: `vencida` = a mais recente.
      const vencida = atrasadas[0] || null;

      return {
        cartao_id: c.id, nome: c.nome, limite: c.limite ?? null,
        // Todos os valores desta linha estão na moeda do CARTÃO.
        ...camposMoedaFatura(c, baseGrupo, tabelaCartoes),
        competencia, ini: ciclo.ini, fim: ciclo.fim, fimExcl: ciclo.fimExcl, ultimo: ciclo.ultimo || ciclo.fim,
        venc: ciclo.venc, label: ciclo.label, porCiclo: ciclo.porCiclo,
        of: ehOF, fatura, pago, restante, vencida, atrasadas, quitada, proxima,
        // Fatura do EMISSOR nesta competência. É o que permite a tela agrupar
        // os lançamentos como o banco agrupa, em vez de só pela data da compra
        // (ver `pertenceAFatura` modo híbrido). Vem de of_faturas (118).
        of_bill_id: publicadaDaComp ? publicadaDaComp.of_bill_id : null,
        fechada: (ciclo.ultimo || ciclo.fim) < hoje,
        parcelas_previstas: prev.linhas, total_previsto: prev.total,
        // Entra no card "Previstos do mês"? (migration 123). Sem a coluna,
        // `undefined !== false` → true, que é o padrão desejado.
        nos_previstos: c.nos_previstos !== false,
      };
    });

    // Rollover aguardando (o aviso do WhatsApp já saiu e a pessoa não decidiu).
    for (const r of rollovers.filter((x) => x.status === 'aguardando')) {
      const f = faturas.find((x) => x.cartao_id === r.cartao_id);
      if (f) f.rollover = r;
    }

    res.json({ offset, faturas });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/wallets/fatura/rolar — passa o saldo de uma fatura VENCIDA pra
// próxima, por escolha da pessoa (nunca automático — ver services/faturaRollover
// `rolarFatura`). Body: { cartao_id, competencia, juros? } OU { rollover_id, juros? }.
router.post('/fatura/rolar', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId || req.authUser?.grupoAtivo;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { rollover_id, juros } = req.body || {};
    let { cartao_id, competencia } = req.body || {};

    if (rollover_id) {
      const { data } = await supabase.from('fatura_rollover')
        .select('cartao_id, competencia').eq('id', rollover_id).eq('grupo_id', grupoId).maybeSingle();
      if (!data) return res.status(404).json({ erro: 'Fatura não encontrada.' });
      cartao_id = data.cartao_id; competencia = data.competencia;
    }
    if (!cartao_id) return res.status(400).json({ erro: 'cartao_id obrigatório' });

    // ⚠️ ESCOPO PELO GRUPO na própria consulta: o id da URL sozinho deixaria
    // rolar fatura de cartão alheio.
    const { data: cartao } = await supabase.from('wallets')
      .select('id, nome, of_conta_id, dia_fechamento, dia_vencimento, fechamento_dia_proxima')
      .eq('id', cartao_id).eq('grupo_id', grupoId).maybeSingle();
    if (!cartao) return res.status(404).json({ erro: 'Cartão não encontrado.' });

    const r = await rolarFatura({ grupoId, cartao, competencia, juros, userId: req.userId || null });
    if (!r.ok) return res.status(400).json({ erro: r.erro, codigo: r.codigo });
    res.json(r);
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
      .select('id, nome, saldo, cheque_especial, moeda, of_conta_id').eq('grupo_id', grupoId).in('id', [origem_id, destino_id]);
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
      // Saldo é NATIVO: conta em coroa responde em coroa (migration 168).
      const extra = chequeOrigem > 0
        ? ` (saldo + cheque especial: ${require('../services/moeda').formatar(disponivel, origem.moeda)})` : '';
      return res.status(400).json({ erro: `Saldo insuficiente em ${origem.nome}${extra}.` });
    }

    // Conta do Open Finance não anda à mão (regra de ouro) — só a ponta manual.
    const { moverSaldo } = require('../services/saldoCarteira');
    await moverSaldo(origem, -v);
    await moverSaldo(destino, v);

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