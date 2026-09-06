// =============================================================================
// aPagarCartoes — QUANTO FALTA PAGAR NOS CARTÕES, pro WhatsApp.
//
// FONTE ÚNICA das mensagens que somam cartão (`resumo` e `saldos`). Existe
// porque as duas somavam `−wallets.saldo` por conta própria, e isso é a
// SEGUNDA fonte da verdade que o `faturaVista.js` foi escrito pra eliminar.
//
// ── O QUE ISSO CONSERTA (medido numa conta real, 06/09/2026) ───────────────
//
//   cartão                  −saldo (zap)   restante (painel)
//   Mercado Pago (OF)          3.496,13           1.041,05
//   Itaú Crédito (manual)        167,29              20,40
//   ────────────────────────────────────────────────────────
//   a pagar                    3.663,42           1.061,45
//   saldo real              −R$ 2.286,49        +R$ 315,48
//
// O usuário via "saldo real −R$ 2.286,49" no zap e R$ 1.041,05 de fatura no
// painel, no mesmo minuto. Dois defeitos somados, e cada um sozinho já erra:
//
// ⚠️ 1. `−saldo` É A FATURA BRUTA — não desconta `pagamentos_fatura`. Nesta
//    conta havia R$ 2.854,70 JÁ PAGOS da fatura do Mercado Pago, e eles
//    continuavam pesando como dívida. Quem paga a fatura vê o número não se
//    mexer, que é o pior momento possível pra desconfiar do app.
//
// ⚠️ 2. NO CARTÃO MANUAL, `saldo` É ACUMULADO, não a fatura do ciclo. O Itaú
//    fecha dia 21: o ciclo em curso (22/08→21/09) tem R$ 20,40, mas o saldo
//    carregava R$ 167,29 de compras de ciclos anteriores. Somar isso responde
//    "quanto devo no cartão desde sempre", não "quanto vou pagar agora" — que
//    é a pergunta que a linha faz.
//
// `valorExibido` já resolve os dois: ele lê a fatura PUBLICADA pelo banco
// quando existe, cai na simulada, depois na soma do ciclo + parcelas
// previstas, e só então no cartão manual — sempre menos `pagamentos_fatura`.
//
// ⚠️ FALHA NÃO VIRA ZERO. Se a fatura de um cartão não puder ser calculada, ele
// entra em `semFatura` e o TOTAL SE DECLARA PARCIAL, do mesmo jeito que o
// câmbio faz com `semCambio`. Engolir o erro e somar 0 esconde dívida, que é
// exatamente o tipo de silêncio que este arquivo existe pra acabar.
// =============================================================================
const { competenciaAtual } = require('./cicloFatura');
const { statusFatura } = require('./faturaRollover');
const { valorExibido } = require('./faturaVista');
const { lerPrevistas } = require('./parcelasPrevistas');
const { paraBRL } = require('./moeda');

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Quanto falta pagar HOJE num cartão, pela fonte única do painel.
 *
 * ⚠️ A injeção de `parcelasPrevistas` é a MESMA da rota `/wallets/faturas` e
 * do Oráculo. Sem ela, cartão de Open Finance cujo emissor manda parcela sem
 * o marcador "N/M" (Mercado Pago) sai com a fatura MENOR que a do banco — o
 * zap voltaria a divergir do painel, por outro caminho.
 */
async function vistaReal(grupoId, cartao) {
  const comp = competenciaAtual(cartao);
  const st = await statusFatura(grupoId, cartao, comp);
  const vista = await valorExibido(cartao, comp, st, { parcelasPrevistas: lerPrevistas });
  return vista.restante;
}

/**
 * Quanto falta pagar hoje, somando os cartões do grupo.
 *
 * @param {string} grupoId
 * @param {Array}  wallets  carteiras do grupo (a função filtra os de Crédito)
 * @param {object} tabela   cotações (services/moeda.taxas) — só usada quando há
 *                          cartão em moeda estrangeira; hoje não há nenhum na
 *                          base, mas a migration 144 permite e o caminho fica.
 * @returns {{ total:number, semCambio:number, semFatura:number,
 *             porCartao: Array<{nome:string, restante:number}> }}
 */
async function aPagarCartoes(grupoId, wallets, tabela, deps = {}) {
  // ⚠️ A injeção existe pro EVAL. A regra de qual número a tela mostra vive
  //    em `faturaVista`, que fala com o banco — sem esta porta, o único jeito
  //    de testar esta função seria contra a base de produção, e aí ela ficaria
  //    sem teste (foi o que deixou o defeito de pé por tanto tempo).
  const vistaDoCartao = deps.vistaDoCartao || vistaReal;
  const cartoes = (wallets || []).filter((w) => w.tipo === 'Crédito');
  let total = 0;
  let semCambio = 0;
  let semFatura = 0;
  const porCartao = [];

  for (const c of cartoes) {
    let restante = null;
    try {
      restante = cent(await vistaDoCartao(grupoId, c));
    } catch {
      semFatura += 1;
      continue;
    }
    // Cartão em moeda estrangeira: `restante` está na moeda do cartão.
    const emBRL = paraBRL(restante, c.moeda, tabela);
    if (emBRL === null) { semCambio += 1; continue; }
    total += emBRL;
    // `restante` fica NA MOEDA DO CARTÃO (pra a linha da lista mostrar o
    // número que o cliente vê no app do banco) e `restanteBRL` convertido
    // (pra somar). Em BRL — hoje, toda a base — os dois são iguais.
    porCartao.push({ id: c.id, nome: c.nome, restante: cent(restante), restanteBRL: cent(emBRL) });
  }

  return { total: cent(total), semCambio, semFatura, porCartao };
}

/** Frase de aviso quando o total ficou incompleto. Vazia quando está fechado. */
function avisoParcial({ semCambio, semFatura }) {
  const partes = [];
  if (semFatura > 0) partes.push(`${semFatura} cartão(ões) sem fatura calculada`);
  if (semCambio > 0) partes.push(`${semCambio} conta(s) sem câmbio`);
  return partes.length ? `\n⚠️ Total parcial: ${partes.join(' e ')}.` : '';
}

module.exports = { aPagarCartoes, avisoParcial, cent };
