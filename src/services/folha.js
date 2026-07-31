// =============================================================================
// Folha: comissão e custo real do funcionário.
//
// Pura, com eval (evals/folha.eval.js). O erro aqui não estoura: paga-se a
// comissão errada e ninguém percebe até o vendedor conferir.
//
// SOBRE OS ENCARGOS — a parte que exige honestidade:
// Este cálculo é uma ESTIMATIVA gerencial, não a folha oficial. Ele serve pra
// responder "quanto essa pessoa custa de verdade por mês", que é uma decisão de
// preço e de contratação. Não substitui contador, não gera guia e não sabe do
// sindicato, do adicional de insalubridade nem do vale-transporte descontado.
// Por isso vem DESLIGADO por padrão e a tela mostra o aviso.
// =============================================================================

const cent = (n) => Math.round(Number(n) || 0);

/**
 * Percentuais de provisão mensal sobre o salário.
 *
 * FGTS: 8% do salário, todo mês.
 * 13º:  um salário a mais por ano → 1/12 = 8,33% provisionado por mês.
 * Férias + 1/3: 1,3333 salário por ano → 11,11% por mês.
 * FGTS sobre 13º e férias: 8% das duas provisões acima.
 * INSS patronal (20%): fora por padrão — no Simples (anexos I–III) já está
 *   dentro do DAS. Só entra se o usuário disser que o regime dele cobra.
 */
const TAXAS = {
  fgts:            0.08,
  decimo_terceiro: 1 / 12,
  ferias:          (1 + 1 / 3) / 12,
  inss_patronal:   0.20,
};

/**
 * Custo mensal estimado de um funcionário.
 * @param {number} salario centavos
 * @param {object} opts { encargos, inssPatronal }
 */
function custoFuncionario(salario, { encargos = false, inssPatronal = false } = {}) {
  const base = Math.max(0, cent(salario));
  if (!encargos) {
    return { salario: base, encargos: 0, total: base, detalhe: [] };
  }

  const fgts   = Math.round(base * TAXAS.fgts);
  const dec13  = Math.round(base * TAXAS.decimo_terceiro);
  const ferias = Math.round(base * TAXAS.ferias);
  // O FGTS incide também sobre 13º e férias — esquecer isso subestima o custo
  // em ~1,5% e é o erro mais comum de planilha caseira.
  const fgtsProvisoes = Math.round((dec13 + ferias) * TAXAS.fgts);
  const inss = inssPatronal ? Math.round(base * TAXAS.inss_patronal) : 0;

  const detalhe = [
    { chave: 'fgts',            label: 'FGTS (8%)',                  valor: fgts },
    { chave: 'decimo_terceiro', label: '13º (provisão)',             valor: dec13 },
    { chave: 'ferias',          label: 'Férias + 1/3 (provisão)',    valor: ferias },
    { chave: 'fgts_provisoes',  label: 'FGTS sobre 13º e férias',    valor: fgtsProvisoes },
  ];
  if (inss) detalhe.push({ chave: 'inss_patronal', label: 'INSS patronal (20%)', valor: inss });

  const total_encargos = detalhe.reduce((s, d) => s + d.valor, 0);
  return { salario: base, encargos: total_encargos, total: base + total_encargos, detalhe };
}

/** Comissão de uma venda. Base = total já com desconto (o vendedor não ganha
 *  sobre o que a loja abriu mão). */
function comissaoDe(totalVenda, pct) {
  const p = Number(pct) || 0;
  if (p <= 0) return 0;
  return Math.max(0, Math.round(cent(totalVenda) * (p / 100)));
}

/**
 * Consolida o mês de uma pessoa: salário + comissão devida + encargos.
 * @param {object} f    funcionário
 * @param {number} comissaoAberta centavos já apurados nas vendas
 * @param {boolean} inssPatronal  regime cobra INSS patronal por fora
 */
function resumoMensal(f, comissaoAberta = 0, inssPatronal = false) {
  const custo = custoFuncionario(f?.salario, { encargos: !!f?.encargos, inssPatronal });
  const comissao = Math.max(0, cent(comissaoAberta));
  return {
    ...custo,
    comissao,
    // O que sai do caixa se pagar tudo hoje (provisão não sai — é reserva).
    a_pagar: custo.salario + comissao,
    custo_total: custo.total + comissao,
  };
}

module.exports = { custoFuncionario, comissaoDe, resumoMensal, TAXAS };
