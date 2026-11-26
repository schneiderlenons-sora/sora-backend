// =============================================================================
// AS FATURAS DOS CARTÕES DE UM GRUPO — fonte única da rota
// GET /api/wallets/faturas/:phone e do widget "Livre pra gastar"/"Cartão".
//
// Saiu de routes/wallets.js (nov/2026) SEM MUDAR UMA LINHA DA LÓGICA: o widget
// precisava do mesmo número da tela de cartões, e copiar a conta seria criar a
// segunda fonte da verdade que esta rota existe pra evitar. Conferido
// comparando, byte a byte, a resposta antiga e a nova em todos os grupos com
// cartão (offsets −1, 0 e 1).
// =============================================================================

const supabase = require('../db/supabase');
const { statusFatura } = require('./faturaRollover');
const { faturasAtrasadas } = require('./faturaAtrasada');
const { competenciaAtual, cicloPorCompetencia, competenciaVizinha, hojeSP } = require('./cicloFatura');
const { valorExibido } = require('./faturaVista');
const { lerPrevistas: parcelasPrevistasDe } = require('./parcelasPrevistas');
const { mapEmOrdem, memoPorRequisicao } = require('./emParalelo');
const {
  normalizarMoeda, moedaBaseDoGrupo, taxasParaBase, taxaEntre, cartaoForaDaBase, motivoCartaoForaDaBase,
} = require('./moeda');

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

/**
 * As faturas de todos os cartões do grupo, `offset` faturas a partir da atual.
 * Devolve a lista que a rota responde em `{ offset, faturas }`.
 */
async function faturasDoGrupo(grupoId, { offset = 0 } = {}) {
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

  return faturas;
}

module.exports = { faturasDoGrupo, camposMoedaFatura, tabelaDosCartoes };
