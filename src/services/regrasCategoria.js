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

/**
 * Cria/atualiza a regra do estabelecimento. Devolve o termo gravado.
 *
 * ⚠️⚠️ ISTO NUNCA FUNCIONOU ATÉ SET/2026, E FALHAVA CALADO.
 *
 * A versão anterior fazia `upsert(..., { onConflict: 'grupo_id,termo' })`, mas o
 * índice único da migration 104 é sobre uma EXPRESSÃO —
 * `(grupo_id, lower(btrim(termo)))`. O Postgres não casa `ON CONFLICT (colunas)`
 * com índice de expressão e devolve 42P10 ("there is no unique or exclusion
 * constraint matching the ON CONFLICT specification"). Toda tentativa de criar
 * regra morria aí.
 *
 * E morria em SILÊNCIO: o `PUT /api/transacoes/:id` chama isto dentro de um
 * try/catch best-effort (pra falha aqui não desfazer a edição já salva), então
 * o erro virava um `console.warn`. O usuário marcava "aplicar a todas", via a
 * transação salvar e ia embora achando que tinha criado a regra. Medido: ZERO
 * regras na base inteira, com 69 descrições repetindo em "Outros".
 *
 * A gravação agora é UPDATE-e-senão-INSERT, que independe do formato do índice
 * — funciona com o índice de expressão que está no banco hoje E com o índice
 * simples da migration 145. `termo` já vem normalizado por `termoDe`, então
 * `lower(btrim(termo)) === termo` e as duas formas concordam.
 */
async function salvarRegra({ grupoId, descricao, categoria, userId } = {}) {
  const termo = termoDe(descricao);
  if (!grupoId || !termo || !categoria) return null;
  const agora = new Date().toISOString();

  // 1) Já existe? Só troca a categoria.
  const { data: atual, error: eSel } = await supabase.from('regras_categoria')
    .select('id').eq('grupo_id', grupoId).eq('termo', termo).maybeSingle();
  if (eSel) throw eSel;

  if (atual?.id) {
    const { error } = await supabase.from('regras_categoria')
      .update({ categoria, updated_at: agora }).eq('id', atual.id);
    if (error) throw error;
    invalidarCache(grupoId);
    return termo;
  }

  // 2) Não existe: insere.
  const { error } = await supabase.from('regras_categoria').insert({
    grupo_id: grupoId, termo, categoria, criado_por: userId || null, updated_at: agora,
  });
  if (error) {
    // ⚠️ CORRIDA: duas correções do mesmo estabelecimento ao mesmo tempo. O
    // índice único barra a segunda — e aí o certo é atualizar, não estourar.
    // (23505 = unique_violation)
    if (error.code === '23505') {
      const { error: e2 } = await supabase.from('regras_categoria')
        .update({ categoria, updated_at: agora })
        .eq('grupo_id', grupoId).eq('termo', termo);
      if (e2) throw e2;
    } else {
      throw error;
    }
  }
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

/**
 * Regras do grupo pra TELA de gerenciamento — com id, autor e datas.
 *
 * ⚠️ Diferente de `carregarRegras`, que é o caminho quente do import: aquela
 * devolve só `{termo, categoria}` normalizado e vive num cache de 5 min. Aqui a
 * leitura é DIRETA e sem cache — quem abriu a tela acabou de mexer nas regras e
 * não pode ver a versão de cinco minutos atrás.
 *
 * ⚠️ Tolerante à migration 104: sem ela devolve lista vazia e a tela mostra
 * "nenhuma regra ainda" em vez de estourar.
 */
async function listarRegras(grupoId) {
  if (!grupoId) return [];
  try {
    const { data, error } = await supabase.from('regras_categoria')
      .select('id, termo, categoria, criado_por, created_at, updated_at')
      .eq('grupo_id', grupoId)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch {
    return [];
  }
}

/**
 * Troca a categoria de uma regra existente, pelo id.
 *
 * ⚠️ O `.eq('grupo_id')` não é decoração: sem ele um id vindo do cliente
 * editaria a regra de OUTRO grupo.
 */
async function atualizarRegra({ grupoId, id, categoria } = {}) {
  if (!grupoId || !id || !categoria) return null;
  const { data, error } = await supabase.from('regras_categoria')
    .update({ categoria, updated_at: new Date().toISOString() })
    .eq('id', id).eq('grupo_id', grupoId)
    .select().maybeSingle();
  if (error) throw error;
  invalidarCache(grupoId);
  return data || null;
}

/** Apaga pelo id (a tela lista por id; `removerRegra` apaga por termo). */
async function removerRegraPorId({ grupoId, id } = {}) {
  if (!grupoId || !id) return false;
  const { error } = await supabase.from('regras_categoria')
    .delete().eq('id', id).eq('grupo_id', grupoId);
  if (error) throw error;
  invalidarCache(grupoId);
  return true;
}

module.exports = {
  normalizar, termoDe, carregarRegras, categoriaPorRegra, aplicarRegrasEmLote,
  salvarRegra, removerRegra, invalidarCache,
  listarRegras, atualizarRegra, removerRegraPorId,
};
