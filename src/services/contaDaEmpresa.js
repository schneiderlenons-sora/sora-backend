// ─────────────────────────────────────────────────────────────────────────────
// CARTEIRA "SÓ DA EMPRESA" — fonte única (nov/2026, relato do Robert)
//
// Uma carteira do banco ligada a uma conta do Sora Negócios com "esta conta é
// só da empresa" ligado (`contas_negocio.fora_do_pessoal`, migration 192) NÃO
// é dinheiro da pessoa. O passo B já tirava as RECEITAS/DESPESAS dela das
// finanças pessoais (marca `ignorar_em = 'empresa'` nas transações); faltava o
// SALDO — que seguia somando no "Saldo em contas" do painel, no "ver saldos" e
// no resumo do WhatsApp e no caixa do Oráculo. O cliente via "um dinheiro que
// não é meu".
//
// ⚠️ É DERIVADO do vínculo, sem coluna nova em `wallets`: o vínculo já existe
// e é ele que liga/desliga. Uma segunda coluna seria uma segunda verdade que
// podia divergir da primeira.
//
// ⚠️ DEGRADA PRO LADO DE MOSTRAR: leitura que falha (ou a 189/192 pendentes)
// devolve conjunto vazio — a conta volta a somar como antes. Esconder dinheiro
// da pessoa por falta de dado é o erro que não se perdoa.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Carteiras (por id) que são "só da empresa".
 * @param {Array<string|number>} walletIds
 * @returns {Promise<Map<string, {conta_id:string, empresa_id:string, empresa_nome:string|null}>>}
 */
async function carteirasDaEmpresa(walletIds, { supabase = require('../db/supabase') } = {}) {
  const ids = [...new Set((walletIds || []).filter(Boolean).map(String))];
  const mapa = new Map();
  if (!ids.length) return mapa;
  try {
    const { data, error } = await supabase.from('contas_negocio')
      .select('id, wallet_id, empresa_id, ativa, fora_do_pessoal')
      .in('wallet_id', ids);
    if (error || !data) return mapa;
    const daEmpresa = data.filter((c) => c.wallet_id && c.ativa !== false && c.fora_do_pessoal !== false);
    if (!daEmpresa.length) return mapa;
    let nomes = new Map();
    try {
      const { data: emps } = await supabase.from('empresas')
        .select('id, nome').in('id', [...new Set(daEmpresa.map((c) => c.empresa_id))]);
      nomes = new Map((emps || []).map((e) => [String(e.id), e.nome]));
    } catch { /* nome é enfeite: sem ele a carteira continua marcada */ }
    for (const c of daEmpresa) {
      mapa.set(String(c.wallet_id), {
        conta_id: c.id, empresa_id: c.empresa_id, empresa_nome: nomes.get(String(c.empresa_id)) || null,
      });
    }
  } catch { /* degrada pro lado de mostrar */ }
  return mapa;
}

/** Devolve as carteiras com `da_empresa` (objeto ou null) preenchido. */
async function marcarDaEmpresa(wallets, opts = {}) {
  const lista = wallets || [];
  const mapa = await carteirasDaEmpresa(lista.map((w) => w && w.id), opts);
  return lista.map((w) => (w ? { ...w, da_empresa: mapa.get(String(w.id)) || null } : w));
}

/** Pura: a carteira é "só da empresa"? (lê o campo posto por `marcarDaEmpresa`) */
const ehDaEmpresa = (w) => !!(w && w.da_empresa);

/** Pura: só as carteiras que são da PESSOA. */
const doPessoal = (wallets) => (wallets || []).filter((w) => !ehDaEmpresa(w));

module.exports = { carteirasDaEmpresa, marcarDaEmpresa, ehDaEmpresa, doPessoal };
