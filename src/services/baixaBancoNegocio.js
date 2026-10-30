// =============================================================================
// "CHEGOU R$ X DO BANCO, PARECIDO COM ESTA CONTA — DAR BAIXA?" (Sora Negócios)
//
// O espelho da conta do banco (espelhoContaEmpresa.js) já dá baixa SOZINHO
// quando o valor bate no centavo, até 6 dias do vencimento. Quando não bate —
// o cliente pagou com desconto, com juros, ou atrasou mais de uma semana —, o
// Pix entra como lançamento novo do banco e a conta continua em aberto: a
// projeção fica DOBRADA (a conta prevista + o que chegou).
//
// Esta régua acha esses pares e SUGERE. Nunca automático: sem valor exato não
// há prova (mesma lição do casarPrevisao das finanças pessoais e da baixa de
// parcela de dívida). A pessoa confirma; o servidor reconfere.
//
// A régua:
//   · mesmo sentido (recebimento × conta a receber; pagamento × conta a pagar);
//   · o lançamento do banco caiu de 6 dias ANTES a 20 dias DEPOIS do vencimento
//     (atraso com juros é o caso comum);
//   · valor até 10% de diferença (nunca menos de R$ 1);
//   · um pra um, do par mais parecido; débito disputado por duas contas
//     quase empatadas não é sugerido a nenhuma.
//
// Eval: npm run eval:baixa-banco-negocio
// =============================================================================

const TOL_PCT = 0.10;
const TOL_MIN = 100;        // centavos
const DIAS_ANTES = 6;
const DIAS_DEPOIS = 20;
const EMPATE = 0.005;

const dia = (v) => String(v || '').slice(0, 10);
const diffDias = (de, ate) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 864e5);

/** A conta em aberto que pode receber baixa do banco. */
const ehAberta = (l) => l && l.status === 'pendente' && !l.transacao_id && l.origem !== 'banco' && Number(l.valor) > 0;
/** O lançamento que veio do banco e ainda está solto (não juntado a nada). */
const ehDoBanco = (l) => l && l.origem === 'banco' && !!l.transacao_id && l.status !== 'pendente'
  && l.categoria !== 'movimentacao' && Number(l.valor) > 0;

/**
 * @param {object} p
 * @param {object[]} p.lancamentos  lançamentos da empresa (abertos e do banco)
 * @returns {{ aberto: object, banco: object, diferenca: number }[]}
 */
function sugestoesBaixaBanco({ lancamentos }) {
  const abertos = (lancamentos || []).filter(ehAberta);
  const banco = (lancamentos || []).filter(ehDoBanco);

  const cands = [];
  for (const a of abertos) {
    const venc = dia(a.vencimento || a.data);
    const valor = Number(a.valor);
    const tol = Math.max(Math.round(valor * TOL_PCT), TOL_MIN);
    for (const b of banco) {
      if (b.tipo !== a.tipo) continue;
      const atraso = diffDias(venc, dia(b.data));
      if (atraso < -DIAS_ANTES || atraso > DIAS_DEPOIS) continue;
      const diferenca = Number(b.valor) - valor;
      if (Math.abs(diferenca) > tol) continue;
      cands.push({ a, b, diferenca, score: Math.abs(diferenca) / valor, dist: Math.abs(atraso) });
    }
  }

  // Débito disputado por duas contas que empatam no valor E na distância até
  // o vencimento: escolher seria chute. ⚠️ Só o valor não basta pra declarar
  // empate — o contrato SEMANAL de mesmo valor (o caso de origem) teria todas
  // as semanas empatadas, e quem desempata é a data.
  const porBanco = new Map();
  for (const c of cands) {
    if (!porBanco.has(c.b.id)) porBanco.set(c.b.id, []);
    porBanco.get(c.b.id).push(c);
  }
  const disputados = new Set();
  for (const [id, cs] of porBanco) {
    const o = [...cs].sort((x, y) => x.score - y.score || x.dist - y.dist);
    if (o.length > 1 && o[1].score - o[0].score < EMPATE && o[1].dist === o[0].dist) disputados.add(id);
  }

  cands.sort((x, y) => x.score - y.score || x.dist - y.dist || String(x.a.id).localeCompare(String(y.a.id)));
  const usadoA = new Set(), usadoB = new Set(), out = [];
  for (const c of cands) {
    if (disputados.has(c.b.id) || usadoA.has(c.a.id) || usadoB.has(c.b.id)) continue;
    usadoA.add(c.a.id); usadoB.add(c.b.id);
    out.push({ aberto: c.a, banco: c.b, diferenca: c.diferenca });
  }
  return out;
}

/**
 * O que a baixa grava na conta em aberto (puro). O banco é a verdade do valor e
 * da data do pagamento; a conta mantém o que é DELA — descrição, cliente e a
 * data de competência (o mês da mensalidade, no DRE).
 */
function patchDaBaixa(aberto, banco) {
  const patch = {
    transacao_id: banco.transacao_id,
    status: 'pago',
    pago_em: dia(banco.data),
    valor: Number(banco.valor),
    conta_id: banco.conta_id || aberto.conta_id || null,
  };
  // Categoria: a da conta; sem ela, a que a pessoa já deu ao lançamento do banco.
  if (!aberto.categoria && banco.categoria && banco.categoria !== 'a_classificar') patch.categoria = banco.categoria;
  if (Number(banco.valor) !== Number(aberto.valor)) {
    const fmt = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const nota = `Valor previsto ${fmt(Number(aberto.valor))}; ${aberto.tipo === 'entrada' ? 'recebido' : 'pago'} ${fmt(Number(banco.valor))}.`;
    patch.observacao = aberto.observacao ? `${aberto.observacao} · ${nota}` : nota;
  }
  return patch;
}

module.exports = { sugestoesBaixaBanco, patchDaBaixa, ehAberta, ehDoBanco, TOL_PCT, DIAS_ANTES, DIAS_DEPOIS };
