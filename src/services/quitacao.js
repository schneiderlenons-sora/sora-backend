// =============================================================================
// "PAGUEI" — dar baixa numa ocorrência de conta fixa (Previstos → Extrato).
//
// ⚠️ A BAIXA NÃO DEBITAVA O SALDO. A rota gravava a transação como paga direto
// na tabela, sem o ajuste de saldo que o `POST /api/transacoes` faz. E o
// "Ainda não paguei" usa o `PUT`, que DEVOLVE o valor ao saldo — então a
// sequência "Paguei" → "Ainda não paguei" criava dinheiro que nunca existiu.
// O Extrato ainda tratava a linha paga como "já no saldo" e deixava de
// descontá-la: a projeção ficava alta pelo valor de cada baixa.
// Caso real: plano de saúde de R$ 1.700 numa conta manual (set/2026).
//
// ⚠️ E UMA OCORRÊNCIA PENDENTE NUNCA MAIS VOLTAVA A SER PAGA. Depois do "Ainda
// não paguei" a linha volta como prevista e mostra o botão "Paguei" — mas a
// rota achava a transação (pendente), respondia "já quitada" e não fazia nada.
//
// ⚠️ E ACEITAVA "PAGO" COM DATA NO FUTURO (06/11 marcado como pago em setembro).
// Pagamento que ainda não aconteceu não pode tirar dinheiro do saldo hoje —
// é a mesma regra do lançamento pelo painel.
//
// A aritmética de saldo é a do `PUT /api/transacoes/:id` (efeito = pago ?
// ±valor : 0), pra que "Paguei" e "Ainda não paguei" sejam exatamente inversos.
// =============================================================================
const supabase = require('../db/supabase');
const { ehPagamentoFatura } = require('./categorizar');
const { hojeSP } = require('./cicloFatura');
const { moedaBaseDoGrupo, normalizarMoeda } = require('./moeda');

// Mesma comparação do `ilike('nome', …)` do PUT (sem curinga): só caixa. Casar
// por acento aqui e não lá faria a baixa debitar uma conta que o "Ainda não
// paguei" não acha pra devolver.
const mesmoNome = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** A linha mexe no saldo? Mesmo `especial` do PUT (transferência e fatura não). */
function mexeNoSaldo(t) {
  return !(t.transferencia === true || ehPagamentoFatura(t.categoria) || t.categoria === 'Transferências');
}

/**
 * A carteira que esta baixa debita — ou null quando não debita.
 *
 * ⚠️ OPEN FINANCE NUNCA: o saldo dessas contas é o do banco (regra de ouro).
 * ⚠️ MOEDA ESTRANGEIRA FICA DE FORA, conscientemente: o PUT devolve em reais e
 *    o saldo dessas contas é na moeda delas. Debitar aqui e devolver lá em
 *    unidades diferentes criaria a divergência que isto existe pra eliminar.
 *    Medido: 3 carteiras manuais estrangeiras, 2 contas fixas ativas nelas,
 *    nenhuma baixa pelo painel.
 */
function carteiraQueDebita(wallets, nome, base = 'BRL') {
  if (!nome) return null;
  const w = (wallets || []).find((x) => mesmoNome(x.nome, nome));
  if (!w || w.of_conta_id) return null;
  // ⚠️ "Estrangeira" é relativo à moeda BASE do grupo (migration 168): num grupo
  //    em dólar a conta em dólar debita, e a em real fica de fora.
  const b = normalizarMoeda(base);
  if (String(w.moeda || b).toUpperCase() !== b) return null;
  return w;
}

async function debitar(wallets, t, base) {
  if (!mexeNoSaldo(t)) return false;
  const w = carteiraQueDebita(wallets, t.carteira_nome, base);
  if (!w) return false;
  // Relê o saldo na hora: a lista de carteiras pode ter vindo antes de outra
  // escrita, e somar em cima de um número velho apagaria essa escrita.
  const { data: atual } = await supabase.from('wallets').select('id, saldo').eq('id', w.id).maybeSingle();
  if (!atual) return false;
  const mult = t.tipo === 'Gasto' ? -1 : 1;
  const { error } = await supabase.from('wallets')
    .update({ saldo: (Number(atual.saldo) || 0) + mult * (Number(t.valor) || 0) }).eq('id', w.id);
  return !error;
}

// Um ajuste (pular/adiar) daquela competência perde o sentido depois de
// quitada; deixá-lo lá faria a previsão reaparecer deslocada se a transação
// fosse apagada.
async function limparAjuste(recorrenciaId, competencia) {
  await supabase.from('previsao_ajustes')
    .delete().eq('recorrencia_id', recorrenciaId).eq('competencia', competencia)
    .then(() => {}, () => {});
}

/**
 * "O banco confirmou esta cobrança" → AMARRA a transação do extrato à
 * ocorrência. Mesma operação da baixa automática (`baixaPrevisao.js`).
 *
 * ⚠️ NÃO CRIA LINHA E NÃO MEXE EM SALDO. A cobrança do banco já é o pagamento
 * e já está no saldo (é do banco). O botão "Dar baixa" da sugestão chamava o
 * caminho de criar — gerava a duplicata que este fluxo existe pra eliminar, e
 * com o débito novo ainda tiraria o valor de uma conta manual por um pagamento
 * que saiu de outra.
 */
async function vincularTransacao(p) {
  const { grupoId, rec, competencia, transacao_id } = p;
  const { data: tx } = await supabase.from('transacoes')
    .select('id, recorrencia_id, competencia').eq('id', transacao_id).eq('grupo_id', grupoId).maybeSingle();
  if (!tx) return { status: 404, body: { erro: 'transacao nao encontrada' } };
  if (tx.recorrencia_id === rec.id && tx.competencia === competencia) {
    return { status: 200, body: { ok: true, id: tx.id, jaQuitada: true } };
  }
  if (tx.recorrencia_id) return { status: 409, body: { erro: 'transacao_ja_vinculada' } };

  // A ocorrência já foi resolvida por outra linha (outro toque, a baixa
  // automática): amarrar mais uma faria as duas contarem como o mesmo pagamento.
  const { data: outra } = await supabase.from('transacoes')
    .select('id').eq('grupo_id', grupoId).eq('recorrencia_id', rec.id).eq('competencia', competencia).limit(1);
  if (outra && outra.length) return { status: 200, body: { ok: true, id: outra[0].id, jaQuitada: true } };

  // `is('recorrencia_id', null)` é a trava de corrida, igual à da baixa automática.
  const { data: amarradas, error } = await supabase.from('transacoes')
    .update({ recorrencia_id: rec.id, competencia })
    .eq('id', tx.id).eq('grupo_id', grupoId).is('recorrencia_id', null)
    .select('id');
  if (error) return { status: 500, body: { erro: error.message } };
  if (!amarradas || !amarradas.length) return { status: 409, body: { erro: 'transacao_ja_vinculada' } };
  await limparAjuste(rec.id, competencia);
  return { status: 200, body: { ok: true, id: tx.id, vinculada: true } };
}

/**
 * Dá baixa numa ocorrência. Devolve `{ status, body }` pra rota responder.
 * @param {{ grupoId, userId, rec, competencia, data?, valor?, carteira_nome?, transacao_id?, hoje? }} p
 */
async function quitarOcorrencia(p) {
  if (p.transacao_id) return vincularTransacao(p);
  const hoje = p.hoje || hojeSP();
  if (p.data && String(p.data).slice(0, 10) > hoje) {
    return { status: 400, body: { erro: 'data_futura', mensagem: 'A data do pagamento não pode ser no futuro.' } };
  }
  const { grupoId, userId, rec, competencia } = p;
  const dataFinal = p.data || hoje;
  const valorFinal = Number(p.valor) > 0 ? Number(p.valor) : Number(rec.valor);

  const { data: wallets } = await supabase.from('wallets').select('*').eq('grupo_id', grupoId);
  const base = await moedaBaseDoGrupo(grupoId);

  // ⚠️ IDEMPOTENTE. Dois toques no botão (ou o retry de uma rede ruim) não
  // podem gerar dois pagamentos nem dois débitos.
  const { data: existentes } = await supabase.from('transacoes')
    .select('id, pago, tipo, valor, categoria, transferencia, carteira_nome, created_at')
    .eq('grupo_id', grupoId).eq('recorrencia_id', rec.id).eq('competencia', competencia)
    .order('created_at', { ascending: true }).order('id', { ascending: true })
    .limit(1);

  if (existentes && existentes.length) {
    const t = existentes[0];
    if (t.pago) return { status: 200, body: { ok: true, id: t.id, jaQuitada: true } };

    // Pendente (ex.: "Ainda não paguei") → volta a ser paga. `.eq('pago', false)`
    // no update é a trava: só UM toque consegue virar a linha, e só ele debita.
    // Sem valor na chamada vale o da PRÓPRIA linha, não o da conta fixa: o
    // pendente de uma conta variável pode ter sido confirmado com outro valor.
    const valorReaberta = Number(p.valor) > 0 ? Number(p.valor) : Number(t.valor);
    const { data: viradas, error } = await supabase.from('transacoes')
      .update({ pago: true, data: dataFinal, valor: valorReaberta })
      .eq('id', t.id).eq('pago', false)
      .select('id, tipo, valor, categoria, transferencia, carteira_nome');
    if (error) return { status: 500, body: { erro: error.message } };
    if (!viradas || !viradas.length) return { status: 200, body: { ok: true, id: t.id, jaQuitada: true } };
    await debitar(wallets, viradas[0], base);
    await limparAjuste(rec.id, competencia);
    return { status: 200, body: { ok: true, id: t.id, reaberta: true } };
  }

  const linha = {
    grupo_id:       grupoId,
    criado_por:     userId,
    tipo:           rec.tipo,
    valor:          valorFinal,
    categoria:      rec.categoria || null,
    observacao:     rec.descricao || 'Conta fixa',
    carteira_nome:  p.carteira_nome || rec.carteira || null,
    // hojeSP(), nunca toISOString(): o segundo é UTC, e depois das 21h no Brasil
    // devolve o dia SEGUINTE — a quitação cairia na competência errada.
    data:           dataFinal,
    pago:           true,
    recorrencia_id: rec.id,
    competencia,
  };
  const { data: nova, error } = await supabase.from('transacoes').insert(linha).select('id').single();
  // ⚠️ LER O `error`: insert sem conferir responde 200 com null e a tela fecha
  // achando que salvou (bug das migrations 121 e 147).
  if (error) return { status: 500, body: { erro: error.message } };

  // ⚠️ CORRIDA DE DOIS TOQUES. A consulta acima não é atômica e não há índice
  // único na tabela: dois toques simultâneos passariam os dois e debitariam em
  // dobro. Quem não for a PRIMEIRA linha da ocorrência se desfaz, sem debitar.
  const { data: todas } = await supabase.from('transacoes')
    .select('id').eq('grupo_id', grupoId).eq('recorrencia_id', rec.id).eq('competencia', competencia)
    .order('created_at', { ascending: true }).order('id', { ascending: true });
  if (todas && todas.length > 1 && todas[0].id !== nova.id) {
    await supabase.from('transacoes').delete().eq('id', nova.id);
    return { status: 200, body: { ok: true, id: todas[0].id, jaQuitada: true } };
  }

  await debitar(wallets, linha, base);
  await limparAjuste(rec.id, competencia);
  return { status: 200, body: { ok: true, id: nova.id } };
}

module.exports = { quitarOcorrencia, carteiraQueDebita, mexeNoSaldo };
