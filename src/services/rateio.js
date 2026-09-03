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

  // ⚠️ O QUE ESTA DIVISÃO SUBSTITUIU (migration 152). O rateio APAGA a linha
  // original, então sem isto a categoria dela se perde e o "voltar ao normal"
  // não teria como devolver o lançamento como era.
  //
  // ⚠️ Vai IGUAL em TODAS as partes, não só na primeira: se ficasse só numa,
  // apagar aquela parte levaria junto a única cópia da origem e o desfazer
  // deixaria de funcionar pro resto do grupo.
  const origem = {
    categoria: tx.categoria || null,
    id_curto:  tx.id_curto || null,
    valor:     cent(tx.valor),
  };

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
      rateio_origem: origem,
    };
    // ⚠️ Só a PRIMEIRA herda as chaves de dedup — ver o cabeçalho.
    if (i === 0) for (const c of CHAVES_DE_ORIGEM) if (tx[c] != null) linha[c] = tx[c];
    return linha;
  });

  return { linhas, grupo };
}

// =============================================================================
// DESFAZER O RATEIO — "voltar ao normal"
//
// Junta as partes de um `rateio_grupo` de volta numa transação só. Igual ao
// rateio, é SUBSTITUIÇÃO: entra a linha unificada, saem as partes.
//
// ⚠️ O VALOR É A SOMA DO QUE EXISTE HOJE, não o valor guardado em
// `rateio_origem`. Se o usuário editou uma parte de 100 pra 150 depois de
// dividir, esses 150 são reais — o saldo da carteira já foi ajustado por aquela
// edição. Restaurar o valor antigo desfaria uma edição que ele fez de propósito
// e deixaria o saldo errado. `rateio_origem.valor` serve só pra a tela avisar
// quando a soma mudou.
//
// ⚠️ E POR ISSO O DESFAZER É NEUTRO NO SALDO, igual ao rateio: mesma carteira,
// mesmo total. Quem chama NÃO deve mexer em `wallets.saldo` — passar pelos
// POST/DELETE normais ajustaria o saldo duas vezes.
// =============================================================================

/**
 * Campos que precisam ser IDÊNTICOS entre as partes pra elas ainda formarem um
 * lançamento só.
 *
 * ⚠️ São exatamente os que definem o EFEITO NO SALDO. Se o usuário editou uma
 * parte pra outra carteira, juntar tudo numa linha só moveria dinheiro entre
 * contas sem ninguém pedir — o saldo das duas ficaria errado, e em silêncio.
 * Melhor recusar e explicar do que "consertar" por conta própria.
 *
 * `data`, `categoria` e `observacao` ficam de FORA: divergir neles não mexe em
 * saldo nenhum, e recusar por causa de uma data editada seria rigor sem motivo.
 */
const DEVEM_BATER = ['carteira_nome', 'tipo', 'pago', 'transferencia'];

const ROTULO_CAMPO = {
  carteira_nome: 'a conta',
  tipo: 'o tipo (gasto/recebimento)',
  pago: 'a situação de pagamento',
  transferencia: 'a marcação de transferência',
};

/**
 * Monta a linha que SUBSTITUI as partes. Não escreve nada — quem persiste é a
 * rota, e é por isso que isto dá pra travar em eval.
 *
 * @param {Array} partes linhas do mesmo `rateio_grupo`, como estão no banco
 * @returns {{erro:string}|{linha:object, ids:string[], aviso:string|null}}
 */
function montarDesfazer(partes) {
  if (!Array.isArray(partes) || partes.length === 0) {
    return { erro: 'Não encontrei as partes desse lançamento dividido.' };
  }

  // ⚠️ UMA PARTE SÓ AINDA É DESFAZÍVEL: o usuário pode ter apagado as outras à
  // mão. Aí "voltar ao normal" é devolver a categoria original àquela linha —
  // continua sendo exatamente o que ele pediu.
  for (const c of DEVEM_BATER) {
    const vistos = new Set(partes.map((p) => JSON.stringify(p[c] ?? null)));
    if (vistos.size > 1) {
      return {
        erro: `As partes foram editadas e ${ROTULO_CAMPO[c]} não é mais a mesma em todas — ` +
              `juntar num lançamento só mudaria seu saldo. Deixe ${ROTULO_CAMPO[c]} igual nas partes e tente de novo.`,
      };
    }
  }

  // A parte "principal" é a que carrega as chaves de origem (a 1ª do rateio).
  // Se ela foi apagada, cai na mais antiga — o que importa é ser determinístico.
  const ordenadas = [...partes].sort((a, b) => {
    const ka = CHAVES_DE_ORIGEM.some((c) => a[c] != null) ? 0 : 1;
    const kb = CHAVES_DE_ORIGEM.some((c) => b[c] != null) ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });
  const principal = ordenadas[0];

  const origem = principal.rateio_origem
    || ordenadas.find((p) => p.rateio_origem)?.rateio_origem
    || null;

  // Fallback sem a migration 152: a categoria da MAIOR parte é o palpite menos
  // ruim — é a que mais pesa no lançamento. A tela avisa que foi palpite.
  const maior = [...partes].sort((a, b) => (Number(b.valor) || 0) - (Number(a.valor) || 0))[0];
  const categoria = (origem && origem.categoria) || maior.categoria;

  const total = cent(partes.reduce((s, p) => s + (Number(p.valor) || 0), 0));

  const linha = {};
  for (const c of HERDADOS) if (principal[c] !== undefined) linha[c] = principal[c];
  linha.categoria  = categoria;
  linha.valor      = total;
  // Descrição da principal: juntar três descrições diferentes numa só viraria
  // lixo, e como o rateio repete a do original quando a parte não personaliza,
  // na prática ela já é a descrição certa.
  linha.observacao = principal.observacao || '';
  // ⚠️ O `id_curto` original volta: é o código que o usuário vê e usa no
  // WhatsApp ("apaga a A1B2C3"). Devolver com código novo quebra a referência.
  linha.id_curto      = (origem && origem.id_curto) || principal.id_curto || idCurto();
  linha.rateio_grupo  = null;
  linha.rateio_origem = null;

  // ⚠️ AS CHAVES DE DEDUP VOLTAM pra linha unificada. Sem isso o sync do Open
  // Finance deixaria de reconhecer a transação e a REIMPORTARIA — duplicando
  // justamente o lançamento que o usuário acabou de juntar.
  for (const c of CHAVES_DE_ORIGEM) {
    const dono = ordenadas.find((p) => p[c] != null);
    if (dono) linha[c] = dono[c];
  }

  // Aviso, não erro: o total mudou porque ele editou ou apagou parte depois de
  // dividir. Ele precisa SABER, mas o desfazer segue com o valor de hoje.
  let aviso = null;
  if (origem && centavos(origem.valor) !== centavos(total)) {
    aviso = `O valor mudou desde a divisão: era R$ ${Number(origem.valor).toFixed(2)} e as partes somam R$ ${total.toFixed(2)}. Vou juntar com o valor de hoje.`;
  } else if (!origem) {
    aviso = `Esta divisão foi feita antes de a Sora guardar a categoria original, então usei a da maior parte (${categoria}).`;
  }

  return { linha, ids: partes.map((p) => p.id), aviso };
}

module.exports = {
  montarRateio, montarDesfazer, motivoRecusa, validarPartes,
  CHAVES_DE_ORIGEM, HERDADOS, DEVEM_BATER, cent, centavos,
};
