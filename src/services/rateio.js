// =============================================================================
// RATEIO — dividir um lançamento em várias categorias.
//
// Pedido de cliente: "compra de supermercado de 300 reais dividida entre
// produtos de limpeza e alimentação".
//
// ⚠️ O RATEIO SUBSTITUI A TRANSAÇÃO. Não existe linha-pai.
//
// É a decisão central deste arquivo e a única que evita o bug clássico deste
// sistema: TODA soma do painel lê `transacoes` direto — dashboard, categorias,
// limites, relatórios, reserva de emergência, fatura, Wrapped, Previstos. Se o
// rateio criasse filhas mantendo a linha original, os R$ 300 do supermercado
// virariam R$ 600 em todos esses lugares, e cada soma teria de aprender a
// ignorar o pai. Substituindo, NENHUMA delas precisa saber que rateio existe.
//
// `rateio_grupo` (migration 151) liga as partes entre si. É só um rótulo — não
// entra em cálculo nenhum. Serve pra tela mostrar "parte 2 de 3" e pra um
// futuro desfazer.
//
// ── O que NÃO pode ser rateado, e por quê ───────────────────────────────────
//
// ⚠️ PARCELADA (`parcela_total > 1`). `parcelasPrevistas.jaEhTransacao` casa a
// parcela projetada com a transação real por **parcela (n de N) + valor com
// folga de R$ 1**. Dividir uma parcela de R$ 300 em 200 + 100 faz nenhuma das
// duas casar — e a projeção entraria POR CIMA, inflando a fatura. É exatamente
// a contagem em dobro que o rateio existe pra não causar.
//
// ⚠️ MOEDA ESTRANGEIRA. A linha guarda `valor` (BRL congelado) e
// `valor_moeda`/`taxa_brl` (nativo). Ratear exigiria dividir os dois e manter a
// taxa coerente; sem isso o saldo em dólar da carteira sairia errado. Fica de
// fora até existir uma regra medida pra isso.
//
// ⚠️ TRANSFERÊNCIA / pagamento de fatura (`transferencia = true`). Essas linhas
// não são despesa nem receita: são movimentação entre contas, e `valorFatura` e
// `resumoTransacoes` as tratam à parte. Dividir "por categoria" algo que não
// entra em categoria nenhuma não tem significado.
//
// ── Campos que só UMA parte pode herdar ─────────────────────────────────────
//
// ⚠️ `of_tx_id`, `fitid` e `pluggy_tx_id` são CHAVES DE DEDUP. Se as N partes
// carregassem o mesmo `of_tx_id`, o `reconciliarParcelas` do sync — que faz
// `.eq('of_tx_id', …).maybeSingle()` — passaria a receber duas linhas e falharia
// naquela transação. Só a PRIMEIRA parte herda; as outras vão com null. Assim a
// dedup do sync continua encontrando exatamente uma linha e não reimporta.
// =============================================================================

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;
const centavos = (v) => Math.round((Number(v) || 0) * 100);

/** Campos que identificam a linha na origem — só a 1ª parte os herda. */
const CHAVES_DE_ORIGEM = ['of_tx_id', 'fitid', 'pluggy_tx_id', 'pluggy_card', 'of_card'];

/** Campos copiados IGUAIS em todas as partes (o que define "a mesma compra"). */
const HERDADOS = [
  'grupo_id', 'criado_por', 'tipo', 'carteira_nome', 'data', 'pago',
  'transferencia', 'recorrente', 'vencimento',
  'of_bill_id', 'of_bill_post_date', 'ignorar_em',
  'arquivada_por', 'arquivada_em',
];

const idCurto = () => Math.random().toString(36).substring(2, 8).toUpperCase();

/**
 * Por que esta transação não pode ser rateada (ou null se pode).
 * Mensagem em português, pronta pra tela — quem chama não reescreve.
 */
function motivoRecusa(tx) {
  if (!tx) return 'Transação não encontrada.';
  if (Number(tx.parcela_total) > 1) {
    return 'Compra parcelada não pode ser dividida por categoria — a parcela precisa manter o valor cheio para casar com a fatura do banco.';
  }
  if (tx.moeda && String(tx.moeda).toUpperCase() !== 'BRL') {
    return 'Lançamento em moeda estrangeira ainda não pode ser dividido.';
  }
  if (tx.transferencia === true) {
    return 'Transferência e pagamento de fatura não entram em categoria, então não há o que dividir.';
  }
  if (!(Number(tx.valor) > 0)) return 'Lançamento sem valor não pode ser dividido.';
  return null;
}

/**
 * Valida as partes contra a transação original.
 *
 * ⚠️ A SOMA É CONFERIDA EM CENTAVOS INTEIROS, não em float. `0.1 + 0.2` dá
 * 0.30000000000000004 e uma comparação ingênua recusaria uma divisão correta.
 */
function validarPartes(tx, partes) {
  if (!Array.isArray(partes) || partes.length < 2) {
    return 'Informe pelo menos duas partes.';
  }
  if (partes.length > 20) {
    return 'No máximo 20 partes por lançamento.';
  }
  for (const p of partes) {
    if (!p || !p.categoria || !String(p.categoria).trim()) return 'Cada parte precisa de uma categoria.';
    if (!(Number(p.valor) > 0)) return 'Cada parte precisa de um valor maior que zero.';
  }
  const soma = partes.reduce((s, p) => s + centavos(p.valor), 0);
  const total = centavos(tx.valor);
  if (soma !== total) {
    const dif = (soma - total) / 100;
    return `A soma das partes (${(soma / 100).toFixed(2)}) não fecha com o valor do lançamento (${(total / 100).toFixed(2)}). ` +
      `${dif > 0 ? 'Sobra' : 'Falta'} ${Math.abs(dif).toFixed(2)}.`;
  }
  return null;
}

/**
 * Monta as linhas que SUBSTITUEM a transação. Não escreve nada — quem persiste
 * é a rota, e é por isso que isto dá pra travar em eval.
 *
 * Devolve `{ erro }` ou `{ linhas, grupo }`.
 */
function montarRateio(tx, partes, grupoId) {
  const recusa = motivoRecusa(tx);
  if (recusa) return { erro: recusa };
  const invalido = validarPartes(tx, partes);
  if (invalido) return { erro: invalido };

  const grupo = grupoId || null;
  const base = {};
  for (const c of HERDADOS) if (tx[c] !== undefined) base[c] = tx[c];

  const linhas = partes.map((p, i) => {
    const linha = {
      ...base,
      id_curto: idCurto(),
      categoria: String(p.categoria).trim(),
      valor: cent(p.valor),
      // Sem descrição própria, repete a do original: na lista, três linhas
      // "Supermercado" com categorias diferentes se explicam sozinhas.
      observacao: (p.observacao && String(p.observacao).trim()) || tx.observacao || '',
      rateio_grupo: grupo,
    };
    // ⚠️ Só a PRIMEIRA herda as chaves de dedup — ver o cabeçalho.
    if (i === 0) for (const c of CHAVES_DE_ORIGEM) if (tx[c] != null) linha[c] = tx[c];
    return linha;
  });

  return { linhas, grupo };
}

module.exports = { montarRateio, motivoRecusa, validarPartes, CHAVES_DE_ORIGEM, HERDADOS, cent, centavos };
