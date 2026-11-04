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
    // `reservas_no_pessoal` é da migration 193: sem ela, refaz sem a coluna e
    // as reservas da empresa ficam só no Negócios (o padrão).
    const BASE = 'id, wallet_id, empresa_id, ativa, fora_do_pessoal';
    let { data, error } = await supabase.from('contas_negocio')
      .select(BASE + ', reservas_no_pessoal').in('wallet_id', ids);
    if (error && /reservas_no_pessoal/i.test(error.message || '')) {
      ({ data, error } = await supabase.from('contas_negocio').select(BASE).in('wallet_id', ids));
    }
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
        reservas_no_pessoal: c.reservas_no_pessoal === true,
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

// ─────────────────────────────────────────────────────────────────────────────
// RESERVAS (caixinhas do Open Finance) SEGUEM A CONTA — nov/2026, relato do Robert
//
// A caixinha da conta PJ aparecia na aba Investimentos PESSOAL: a regra "só da
// empresa" cobria a carteira e as transações, mas a caixinha mora em outra
// tabela (`of_caixinhas`). Ela vem presa à conta do banco pelo `of_conta_id` —
// o mesmo da carteira —, então dá pra saber de quem é sem adivinhar.
//
// ⚠️ Casamento SÓ por `of_conta_id` dentro do MESMO grupo. Caixinha sem
// `of_conta_id` (trilho antigo) ou de conta pessoal segue pessoal — o lado
// seguro é mostrar o dinheiro onde sempre esteve.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pura: separa as caixinhas entre pessoais e da empresa.
 * @param caixinhas linhas de `of_caixinhas` (com `of_conta_id`)
 * @param carteiras carteiras do grupo JÁ marcadas por `marcarDaEmpresa`
 * @returns {{ pessoais: object[], daEmpresa: object[] }} — cada uma da empresa
 *   ganha `da_empresa` ({conta_id, empresa_id, empresa_nome, reservas_no_pessoal}).
 */
function separarCaixinhas(caixinhas, carteiras) {
  const porConta = new Map();
  for (const w of carteiras || []) {
    if (w && w.of_conta_id && w.da_empresa) porConta.set(String(w.of_conta_id), w.da_empresa);
  }
  const pessoais = [], daEmpresa = [];
  for (const c of caixinhas || []) {
    const emp = c && c.of_conta_id ? porConta.get(String(c.of_conta_id)) : null;
    if (emp) daEmpresa.push({ ...c, da_empresa: emp }); else pessoais.push(c);
  }
  return { pessoais, daEmpresa };
}

/**
 * Separa as caixinhas de um grupo lendo as carteiras dele. Falha de leitura →
 * todas pessoais (como antes da regra).
 */
async function separarCaixinhasDoGrupo(caixinhas, grupoId, { supabase = require('../db/supabase') } = {}) {
  const lista = caixinhas || [];
  if (!lista.some((c) => c && c.of_conta_id)) return { pessoais: lista, daEmpresa: [] };
  try {
    const { data: ws, error } = await supabase.from('wallets')
      .select('id, of_conta_id').eq('grupo_id', grupoId).not('of_conta_id', 'is', null);
    if (error || !ws) return { pessoais: lista, daEmpresa: [] };
    return separarCaixinhas(lista, await marcarDaEmpresa(ws, { supabase }));
  } catch { return { pessoais: lista, daEmpresa: [] }; }
}

/**
 * Reservas (caixinhas) de cada carteira, pro Sora Negócios. Valores em
 * CENTAVOS, como o resto do Negócios.
 * @param wallets [{ id, grupo_id, of_conta_id }]
 * @returns {Promise<Map<string, {total:number, itens:object[]}>>} por wallet id
 */
async function reservasDasCarteiras(wallets, { supabase = require('../db/supabase') } = {}) {
  const mapa = new Map();
  const comConta = (wallets || []).filter((w) => w && w.id && w.of_conta_id && w.grupo_id);
  if (!comConta.length) return mapa;
  try {
    const contas = [...new Set(comConta.map((w) => String(w.of_conta_id)))];
    const COMPLETO = 'id, grupo_id, of_conta_id, nome, saldo, indexador, indexador_pct, taxa_pre, periodicidade, atualizado_em';
    let { data, error } = await supabase.from('of_caixinhas').select(COMPLETO).in('of_conta_id', contas);
    if (error) {
      // Sem as colunas de remuneração (120): o básico ainda diz quanto tem.
      ({ data, error } = await supabase.from('of_caixinhas')
        .select('id, grupo_id, of_conta_id, nome, saldo, atualizado_em').in('of_conta_id', contas));
    }
    if (error || !data) return mapa;
    for (const w of comConta) {
      const itens = data
        .filter((c) => String(c.of_conta_id) === String(w.of_conta_id) && String(c.grupo_id) === String(w.grupo_id))
        .map((c) => ({ ...c, saldo: Math.round((Number(c.saldo) || 0) * 100) }));
      if (itens.length) mapa.set(String(w.id), { total: itens.reduce((s, c) => s + c.saldo, 0), itens });
    }
  } catch { /* sem reservas na tela; o saldo da conta segue certo */ }
  return mapa;
}

module.exports = {
  carteirasDaEmpresa, marcarDaEmpresa, ehDaEmpresa, doPessoal,
  separarCaixinhas, separarCaixinhasDoGrupo, reservasDasCarteiras,
};
