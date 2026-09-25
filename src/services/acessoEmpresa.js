// =============================================================================
// QUEM ALCANÇA QUAL EMPRESA — fonte única do acesso à aba Negócios.
//
// Relato de cliente Platinum com 6 lojas (24/09/2026): "diferentes membros do
// financeiro, cada um pelo seu próprio WhatsApp, acessando a mesma empresa".
// Hoje a aba inteira é por USUÁRIO — medido: 28 filtros `user_id` em
// routes/negocios.js, mais 2 nos handlers do WhatsApp.
//
// Plano completo: docs/PLANO-NEGOCIOS-MULTIUSUARIO.md. Migration 173.
//
// ⚠️ A LEITURA É UNIÃO, NUNCA SUBSTITUIÇÃO:
//
//     alcanço = sou membro em empresa_membros  OU  sou o user_id da empresa
//
// O segundo ramo não é redundância. Medido em 24/09/2026: 9 das 32 empresas
// ativas têm `grupo_id` diferente do `grupo_ativo` atual do dono (5 são do
// próprio cliente do relato, que criou as empresas e depois trocou de grupo).
// Qualquer desenho que SUBSTITUA o dono pelo vínculo faz essas 9 sumirem para
// quem as criou. O ramo do dono é a rede de segurança: mesmo que o backfill da
// 173 falhe, ou que uma linha nasça sem membro, ninguém perde a própria
// empresa.
//
// ⚠️ A DEGRADAÇÃO É ASSIMÉTRICA, E ISSO É DE PROPÓSITO:
//   · `empresasDoUsuario` falhou a leitura → devolve as PRÓPRIAS empresas.
//     É exatamente o comportamento de hoje; esconder tudo tiraria a aba de
//     quem já a usa por causa de um soluço de rede.
//   · `papelNaEmpresa` falhou a leitura → só responde 'admin' se a pessoa for
//     o dono; para qualquer outro devolve `null` (NEGA). Degradar para o lado
//     de PERMITIR seria transformar falha de rede em brecha de acesso.
// =============================================================================
const supabase = require('../db/supabase');

/** Ordem de poder — usada para "este papel basta?". */
const PAPEIS = ['leitura', 'operador', 'admin'];

/**
 * `true` se o papel que a pessoa tem cobre o mínimo exigido.
 * Puro de propósito: é a regra que o middleware e os handlers compartilham.
 */
function papelPermite(papel, minimo = 'operador') {
  const i = PAPEIS.indexOf(String(papel || ''));
  const j = PAPEIS.indexOf(String(minimo || 'operador'));
  if (i < 0 || j < 0) return false;
  return i >= j;
}

/** A migration 173 ainda não rodou? (tabela inexistente) */
const semTabela = (erro) =>
  !!erro && /empresa_membros|does not exist|schema cache/i.test(erro.message || '');

/**
 * Todas as empresas que o usuário alcança, com o papel dele em cada uma.
 *
 * @returns {Promise<Array<{id, nome, tipo, ativa, papel, dono, padrao}>>}
 */
async function empresasDoUsuario(userId) {
  if (!userId) return [];

  // 1. As que são DELE (o ramo que nunca pode falhar).
  const { data: proprias } = await supabase.from('empresas')
    .select('id, nome, tipo, ativa, user_id')
    .eq('user_id', userId).eq('ativa', true)
    .order('created_at', { ascending: true });

  const mapa = new Map();
  for (const e of proprias || []) {
    mapa.set(e.id, { ...e, papel: 'admin', dono: true, padrao: false });
  }

  // 2. As que ele alcança por VÍNCULO. Tolerante: sem a 173 o resultado é só o
  //    ramo 1, que é o comportamento de hoje.
  const { data: vinculos, error } = await supabase.from('empresa_membros')
    .select('empresa_id, papel, padrao, empresas(id, nome, tipo, ativa, user_id)')
    .eq('user_id', userId);

  if (error) {
    if (!semTabela(error)) console.warn('[acessoEmpresa] vínculos:', error.message);
    return [...mapa.values()];
  }

  for (const v of vinculos || []) {
    const e = v.empresas;
    if (!e || e.ativa === false) continue;
    const jaTem = mapa.get(e.id);
    if (jaTem) {
      // ⚠️ DONO NUNCA É REBAIXADO pelo próprio vínculo. Uma linha gravada como
      // 'leitura' por engano no backfill trancaria o dono fora da empresa dele.
      jaTem.padrao = jaTem.padrao || !!v.padrao;
      continue;
    }
    mapa.set(e.id, {
      id: e.id, nome: e.nome, tipo: e.tipo, ativa: e.ativa, user_id: e.user_id,
      papel: v.papel || 'operador', dono: false, padrao: !!v.padrao,
    });
  }

  return [...mapa.values()];
}

/**
 * O papel da pessoa numa empresa, ou `null` se ela não a alcança.
 *
 * ⚠️ NEGA no escuro: qualquer caminho que não PROVE o acesso devolve null.
 */
async function papelNaEmpresa(userId, empresaId) {
  if (!userId || !empresaId) return null;

  // Dono primeiro — é a resposta que não depende da 173.
  const { data: emp } = await supabase.from('empresas')
    .select('id, user_id, ativa').eq('id', empresaId).maybeSingle();
  if (!emp || emp.ativa === false) return null;
  if (emp.user_id === userId) return 'admin';

  const { data: v, error } = await supabase.from('empresa_membros')
    .select('papel').eq('empresa_id', empresaId).eq('user_id', userId).maybeSingle();

  // ⚠️ Falha de leitura NÃO vira permissão. Quem não é dono e não teve o
  // vínculo confirmado fica de fora — inclusive quando o banco é que falhou.
  if (error) {
    if (!semTabela(error)) console.warn('[acessoEmpresa] papel:', error.message);
    return null;
  }
  return v ? (v.papel || 'operador') : null;
}

/** Atalho: a pessoa alcança a empresa com pelo menos este poder? */
async function podeNaEmpresa(userId, empresaId, minimo = 'operador') {
  return papelPermite(await papelNaEmpresa(userId, empresaId), minimo);
}

/**
 * A empresa que a Sora assume quando a pessoa não diz qual.
 *
 * ⚠️ DEVOLVE `null` COM 2+ EMPRESAS E NENHUMA MARCADA COMO PADRÃO — quem chama
 * tem de PERGUNTAR. Hoje o WhatsApp faz `.order('created_at').limit(1)`: numa
 * rede de 6 lojas isso lança a venda na loja errada EM SILÊNCIO, que é pior do
 * que não lançar. Ver a Fase 4 do plano.
 */
function empresaAssumida(empresas) {
  const lista = (empresas || []).filter((e) => e && e.ativa !== false);
  if (!lista.length) return null;
  if (lista.length === 1) return lista[0];
  return lista.find((e) => e.padrao) || null;
}

module.exports = {
  PAPEIS, papelPermite, empresasDoUsuario, papelNaEmpresa, podeNaEmpresa, empresaAssumida,
};
