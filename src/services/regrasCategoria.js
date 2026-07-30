// =====================================================================
// Regras de categoria por ESTABELECIMENTO (migration 104).
//
// Maquininha de barbearia/dentista costuma vir com o nome da PESSOA
// ("FernandoPeixoto", "MariaLana") — regra fixa nenhuma acerta isso, cai em
// "Outros", e o nome se repete todo mês. Aqui a correção do usuário vira regra
// do grupo e passa a valer pras próximas importações.
//
// Precedência: REGRA DO USUÁRIO > regras fixas do categorizar.js. Quem corrigiu
// à mão sabe mais que o nosso mapa de palavras.
// =====================================================================
const supabase = require('../db/supabase');

/** Mesma normalização do categorizar.js — os termos têm de casar entre si. */
function normalizar(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Termo que identifica o estabelecimento numa descrição.
 * Tira o ruído que o adquirente gruda ("PIX", "compra", códigos, datas), pra
 * "PIX FERNANDOPEIXOTO 0512" e "FernandoPeixoto" virarem o MESMO termo.
 */
const RUIDO = new Set([
  'pix', 'ted', 'doc', 'compra', 'pagamento', 'pag', 'debito', 'credito', 'cartao',
  'transferencia', 'transf', 'recebido', 'enviado', 'para', 'de', 'da', 'do', 'em',
  'parcela', 'parc', 'mensalidade', 'ltda', 'me', 'mei', 'eireli', 'sa',
]);

function termoDe(descricao) {
  const base = normalizar(descricao);
  if (!base) return '';
  const palavras = base
    .split(' ')
    .filter((p) => p && !RUIDO.has(p) && !/^\d+$/.test(p)); // números soltos = código/data
  const limpo = palavras.join(' ').trim();
  // Se sobrou nada (descrição era só ruído), usa a descrição inteira — melhor
  // uma regra específica demais que uma regra que casa com tudo.
  return (limpo || base).slice(0, 120);
}

// Cache curto por grupo: uma importação processa centenas de linhas e não faz
// sentido ir ao banco em cada uma. 60s é o bastante e mantém a regra "quase
// imediata" depois que o usuário salva.
const CACHE = new Map(); // grupoId → { em, regras: [{termo, categoria}] }
const TTL_MS = 60_000;

function invalidarCache(grupoId) {
  if (grupoId) CACHE.delete(String(grupoId));
  else CACHE.clear();
}

async function carregarRegras(grupoId) {
  if (!grupoId) return [];
  const k = String(grupoId);
  const hit = CACHE.get(k);
  if (hit && Date.now() - hit.em < TTL_MS) return hit.regras;

  let regras = [];
  try {
    const { data, error } = await supabase.from('regras_categoria')
      .select('termo, categoria').eq('grupo_id', grupoId);
    if (error) throw error;
    // Termo mais longo primeiro: "clinica sao lucas" ganha de "clinica".
    regras = (data || [])
      .map((r) => ({ termo: normalizar(r.termo), categoria: r.categoria }))
      .filter((r) => r.termo && r.categoria)
      .sort((a, b) => b.termo.length - a.termo.length);
  } catch {
    regras = []; // migration 104 pendente → segue com as regras fixas
  }
  CACHE.set(k, { em: Date.now(), regras });
  return regras;
}

/**
 * Categoria definida pelo usuário pra esta descrição, ou `null`.
 * Casa nos dois sentidos: a descrição contém o termo ("PIX FERNANDOPEIXOTO 05"
 * casa a regra "fernandopeixoto") ou o termo contém a descrição (regra criada a
 * partir de um nome mais completo).
 */
async function categoriaPorRegra(grupoId, descricao) {
  const alvo = normalizar(descricao);
  if (!alvo) return null;
  const regras = await carregarRegras(grupoId);
  for (const r of regras) {
    if (alvo === r.termo || alvo.includes(r.termo) || r.termo.includes(alvo)) return r.categoria;
  }
  return null;
}

/** Cria/atualiza a regra do estabelecimento. Devolve o termo gravado. */
async function salvarRegra({ grupoId, descricao, categoria, userId } = {}) {
  const termo = termoDe(descricao);
  if (!grupoId || !termo || !categoria) return null;
  const { error } = await supabase.from('regras_categoria').upsert({
    grupo_id: grupoId, termo, categoria, criado_por: userId || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'grupo_id,termo' });
  if (error) throw error;
  invalidarCache(grupoId);
  return termo;
}

async function removerRegra({ grupoId, termo } = {}) {
  if (!grupoId || !termo) return false;
  await supabase.from('regras_categoria').delete()
    .eq('grupo_id', grupoId).eq('termo', normalizar(termo));
  invalidarCache(grupoId);
  return true;
}

/**
 * Aplica as regras do grupo a um LOTE antes de inserir.
 *
 * Uma importação traz centenas de linhas; buscar regra por linha seria N idas ao
 * banco. Aqui carregamos uma vez e resolvemos tudo em memória.
 *
 * `linhas` são objetos com `{ observacao, categoria }` (mutados no lugar). A
 * regra do usuário SOBRESCREVE a categoria que o motor de palavras escolheu —
 * ele corrigiu à mão justamente porque o automático errou.
 */
async function aplicarRegrasEmLote(grupoId, linhas) {
  const lista = (linhas || []).filter(Boolean);
  if (!grupoId || !lista.length) return 0;
  const regras = await carregarRegras(grupoId);
  if (!regras.length) return 0;

  let aplicadas = 0;
  for (const linha of lista) {
    const alvo = normalizar(linha.observacao || linha.descricao);
    if (!alvo) continue;
    const r = regras.find((x) => alvo === x.termo || alvo.includes(x.termo) || x.termo.includes(alvo));
    if (r && linha.categoria !== r.categoria) { linha.categoria = r.categoria; aplicadas++; }
  }
  return aplicadas;
}

module.exports = {
  normalizar, termoDe, carregarRegras, categoriaPorRegra, aplicarRegrasEmLote,
  salvarRegra, removerRegra, invalidarCache,
};
