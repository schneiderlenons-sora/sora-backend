// =============================================================================
// MEDIÇÃO da fatura em aberto (migration 207) — SÓ MEDE, nada na tela lê isto.
//
// Relato do Breno (27/11/2026): a marcação de fatura que o EMISSOR põe em cada
// transação (`bill_forecast_date`, gravada em `transacoes.of_bill_forecast`)
// acertou ao centavo a fatura em aberto dos três cartões dele (Nubank 586,80 ·
// Mercado Pago 1.531,01 · PicPay 695,12), onde a Sora errava. Na base inteira
// ela NÃO serve pra todo banco (discorda da tela em 84 de 109 cartões; C6,
// Bradesco, Santander e BB não marcam a fatura aberta assim).
//
// Antes de usá-la POR BANCO, medimos contra a verdade: o total que o banco
// PUBLICA quando a fatura fecha.
//   · JOB 1V (23h30 SP) → `fotografar`: por cartão do Open Finance, o valor que
//     a tela mostra (o mesmo `faturasDoGrupo` da rota) e o que a marcação daria.
//   · `relatorio` → pra cada fatura publicada, o último retrato ANTES do
//     fechamento × o total publicado, por banco.
//
// Regra da marcação (`somaPelaMarcaDoBanco`): linhas SEM `bill_id` (ainda não
// faturadas) cuja marca é a competência; compra soma, crédito abate, e o
// PAGAMENTO fica fora (ele quita a fatura anterior — doc da Celcoin).
// =============================================================================
// A regra da marcação mora em ./marcaDoBanco (a mesma que o sync usa na fatura
// conferida) — a medição não tem cópia própria.
const { ehPagamentoDeFatura, somaPelaMarcaDoBanco } = require('./marcaDoBanco');

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Compara os retratos com as faturas publicadas.
 *   · por fatura publicada, o retrato MAIS RECENTE da mesma competência tirado
 *     até o dia do fechamento (depois dele a fatura já não está "em aberto");
 *   · sem retrato nessa janela, a fatura fica de fora (`semRetrato`).
 * @param {Array<{cartao_id, instituicao, competencia, dia, sora_fatura, marca_banco}>} retratos
 * @param {Array<{cartao_id, competencia, total, fechamento}>} publicadas
 */
function compararRetratos(retratos, publicadas) {
  const porChave = new Map();
  for (const r of retratos || []) {
    const k = `${r.cartao_id}|${r.competencia}`;
    (porChave.get(k) || porChave.set(k, []).get(k)).push(r);
  }
  const porBanco = {};
  const faturas = [];
  let semRetrato = 0;
  for (const p of publicadas || []) {
    if (!p || p.total == null || !p.fechamento) continue;
    const fech = String(p.fechamento).slice(0, 10);
    const lista = (porChave.get(`${p.cartao_id}|${p.competencia}`) || [])
      .filter((r) => String(r.dia).slice(0, 10) <= fech)
      .sort((a, b) => String(b.dia).localeCompare(String(a.dia)));
    if (!lista.length) { semRetrato++; continue; }
    const r = lista[0];
    const total = cent(p.total);
    const sora = r.sora_fatura == null ? null : cent(r.sora_fatura);
    const marca = r.marca_banco == null ? null : cent(r.marca_banco);
    const erroSora = sora == null ? null : cent(Math.abs(sora - total));
    const erroMarca = marca == null ? null : cent(Math.abs(marca - total));
    const banco = r.instituicao || '?';
    const b = porBanco[banco] || (porBanco[banco] = {
      faturas: 0, soraExata: 0, marcaExata: 0, marcaMaisPerto: 0, soraMaisPerto: 0, empate: 0, erroSora: 0, erroMarca: 0,
    });
    b.faturas++;
    if (erroSora != null && erroSora <= 1) b.soraExata++;
    if (erroMarca != null && erroMarca <= 1) b.marcaExata++;
    if (erroSora != null && erroMarca != null) {
      if (Math.abs(erroMarca - erroSora) <= 0.01) b.empate++;
      else if (erroMarca < erroSora) b.marcaMaisPerto++;
      else b.soraMaisPerto++;
      b.erroSora = cent(b.erroSora + erroSora);
      b.erroMarca = cent(b.erroMarca + erroMarca);
    }
    faturas.push({ cartao_id: p.cartao_id, banco, competencia: p.competencia, fechamento: fech,
      retrato_de: String(r.dia).slice(0, 10), publicado: total, sora, marca, erroSora, erroMarca });
  }
  return { porBanco, faturas, semRetrato };
}

const faltaTabela = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205'
  || /does not exist|schema cache|medicao_fatura_aberta/i.test(String(e.message || '')));

/**
 * Retrato do dia. Nunca lança; devolve o resumo.
 * @param {{ supabase, hoje: string, faturasDoGrupo: Function }} deps
 */
async function fotografar({ supabase, hoje, faturasDoGrupo }) {
  const sonda = await supabase.from('medicao_fatura_aberta').select('id').limit(1);
  if (sonda.error) {
    return faltaTabela(sonda.error) ? { erro: 'sem_tabela' } : { erro: sonda.error.message };
  }
  const { data: conexoes } = await supabase.from('of_conexoes').select('external_id, instituicao');
  const instituicao = new Map((conexoes || []).map((c) => [String(c.external_id), c.instituicao || null]));
  const { data: cartoes, error } = await supabase.from('wallets')
    .select('id, grupo_id, nome, of_consent_id, of_provider, of_conta_id')
    .eq('tipo', 'Crédito').eq('of_provider', 'polp-celcoin');
  if (error) return { erro: error.message };
  // Só cartão com conexão VIVA: o de conexão encerrada não recebe dado novo.
  const vivos = (cartoes || []).filter((w) => w.of_conta_id && instituicao.has(String(w.of_consent_id)));

  const porGrupo = new Map();
  for (const w of vivos) (porGrupo.get(w.grupo_id) || porGrupo.set(w.grupo_id, []).get(w.grupo_id)).push(w);

  const linhas = [];
  let falhas = 0;
  for (const [grupoId, doGrupo] of porGrupo) {
    let faturas;
    try { faturas = await faturasDoGrupo(grupoId, { offset: 0 }); } catch { falhas++; continue; }
    for (const w of doGrupo) {
      const f = (faturas || []).find((x) => x && x.cartao_id === w.id);
      if (!f || !f.competencia) continue;
      const { data: txs, error: e2 } = await supabase.from('transacoes')
        .select('tipo, valor, valor_moeda, categoria, observacao, of_bill_id, of_bill_forecast')
        .eq('grupo_id', grupoId).ilike('carteira_nome', w.nome).eq('of_bill_forecast', f.competencia);
      if (e2) { falhas++; continue; }
      const marca = somaPelaMarcaDoBanco(txs || [], f.competencia);
      linhas.push({
        cartao_id: w.id, grupo_id: grupoId, instituicao: instituicao.get(String(w.of_consent_id)),
        competencia: f.competencia, dia: hoje,
        sora_fatura: f.fatura == null ? null : cent(f.fatura),
        sora_restante: f.restante == null ? null : cent(f.restante),
        marca_banco: marca.valor, marca_linhas: marca.linhas,
      });
    }
  }
  if (!linhas.length) return { cartoes: vivos.length, gravados: 0, falhas };
  const { error: e3 } = await supabase.from('medicao_fatura_aberta')
    .upsert(linhas, { onConflict: 'cartao_id,competencia,dia' });
  if (e3) return { erro: e3.message, cartoes: vivos.length, falhas };
  return { cartoes: vivos.length, gravados: linhas.length, falhas };
}

/** Lê tudo e compara (só leitura). */
async function relatorio({ supabase }) {
  const retratos = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await supabase.from('medicao_fatura_aberta')
      .select('cartao_id, instituicao, competencia, dia, sora_fatura, marca_banco').range(de, de + 999);
    if (error) return faltaTabela(error) ? { erro: 'sem_tabela' } : { erro: error.message };
    retratos.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const ids = [...new Set(retratos.map((r) => r.cartao_id))];
  const comps = [...new Set(retratos.map((r) => r.competencia))];
  let publicadas = [];
  if (ids.length) {
    const { data, error } = await supabase.from('of_faturas')
      .select('cartao_id, competencia, total, fechamento').in('cartao_id', ids).in('competencia', comps);
    if (error) return { erro: error.message };
    publicadas = data || [];
  }
  const dias = [...new Set(retratos.map((r) => String(r.dia).slice(0, 10)))].sort();
  return { retratos: retratos.length, dias: dias.length ? `${dias[0]} a ${dias[dias.length - 1]}` : null,
    ...compararRetratos(retratos, publicadas) };
}

module.exports = { somaPelaMarcaDoBanco, ehPagamentoDeFatura, compararRetratos, fotografar, relatorio, faltaTabela };
