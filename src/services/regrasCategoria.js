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
const CACHE = new Map(); // grupoId → { em, regras: [...] }
const TTL_MS = 60_000;

// ── Vocabulário da regra (migration 146) ───────────────────────────────────
const TIPOS   = ['categorizar', 'ignorar'];
const MATCHES = ['exato', 'contem'];
const ESCOPOS = ['tudo', 'fluxo'];

const umDe = (v, lista, padrao) => (lista.includes(String(v || '')) ? String(v) : padrao);

/**
 * A descrição casa com a regra?
 *
 * ⚠️ 'exato'  → a descrição INTEIRA é igual ao termo (ignorando acento e caixa,
 *               que é o que o print promete: "Casa quando a descrição é
 *               idêntica (ignora acento e maiúscula)").
 * ⚠️ 'contem' → a descrição contém o termo. Continua casando nos DOIS sentidos
 *               (o termo também pode conter a descrição), porque é a semântica
 *               que as regras nascidas de correção sempre tiveram: o termo é
 *               extraído sem ruído e às vezes fica MAIOR que a descrição curta
 *               de outro lançamento do mesmo lugar. Mudar isso estreitaria
 *               regras existentes sem ninguém pedir.
 */
function casaRegra(alvoNormalizado, regra) {
  const alvo = alvoNormalizado;
  const termo = regra.termo;
  if (!alvo || !termo) return false;
  if (regra.modo_match === 'exato') return alvo === termo;
  return alvo === termo || alvo.includes(termo) || termo.includes(alvo);
}

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
    // ⚠️ `select('*')` e NÃO a lista de colunas da 146: pedir `tipo`,
    // `modo_match` etc. pelo nome faria ESTA query falhar enquanto a migration
    // não roda — e ela está no caminho de TODA importação. Com `*` os campos
    // vêm se existirem e somem se não existirem, e os defaults abaixo mantêm o
    // comportamento antigo (categorizar + contém).
    const { data, error } = await supabase.from('regras_categoria')
      .select('*').eq('grupo_id', grupoId);
    if (error) throw error;
    regras = (data || [])
      .map((r) => ({
        id:             r.id,
        termo:          normalizar(r.termo),
        tipo:           umDe(r.tipo, TIPOS, 'categorizar'),
        modo_match:     umDe(r.modo_match, MATCHES, 'contem'),
        categoria:      r.categoria || null,
        renomear_para:  r.renomear_para || null,
        recorrente:     r.recorrente === true,
        ignorar_escopo: umDe(r.ignorar_escopo, ESCOPOS, 'tudo'),
      }))
      // Regra de ignorar não precisa de categoria; a de categorizar precisa de
      // categoria OU de um novo nome (dá pra criar regra só pra renomear).
      .filter((r) => r.termo && (
        r.tipo === 'ignorar' || r.categoria || r.renomear_para))
      // ⚠️ ORDEM IMPORTA e é dupla:
      //  1. 'exato' antes de 'contem' — quem escreveu a descrição inteira quis
      //     aquele lançamento específico, e não pode perder pra um "contém"
      //     genérico criado antes.
      //  2. termo mais longo primeiro — "clinica sao lucas" ganha de "clinica".
      .sort((a, b) => {
        if (a.modo_match !== b.modo_match) return a.modo_match === 'exato' ? -1 : 1;
        return b.termo.length - a.termo.length;
      });
  } catch {
    regras = []; // migration 104/146 pendente → segue com as regras fixas
  }
  CACHE.set(k, { em: Date.now(), regras });
  return regras;
}

/** A primeira regra do grupo que casa com a descrição, ou `null`. */
async function regraPara(grupoId, descricao) {
  const alvo = normalizar(descricao);
  if (!alvo) return null;
  const regras = await carregarRegras(grupoId);
  return regras.find((r) => casaRegra(alvo, r)) || null;
}

/**
 * Categoria definida pelo usuário pra esta descrição, ou `null`.
 * Casa nos dois sentidos: a descrição contém o termo ("PIX FERNANDOPEIXOTO 05"
 * casa a regra "fernandopeixoto") ou o termo contém a descrição (regra criada a
 * partir de um nome mais completo).
 */
async function categoriaPorRegra(grupoId, descricao) {
  const r = await regraPara(grupoId, descricao);
  // ⚠️ Regra de IGNORAR não devolve categoria — quem chama isto (o lançamento
  // pelo WhatsApp) só quer saber em que categoria pôr. Devolver algo aqui faria
  // uma regra de "não considerar" virar categorização.
  return r && r.tipo === 'categorizar' ? (r.categoria || null) : null;
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
async function salvarRegra({
  grupoId, descricao, categoria, userId,
  // ── Campos da regra completa (migration 146) ──────────────────────────────
  // Omitidos = comportamento antigo: categorizar, "contém", sem renome.
  tipo, modoMatch, renomearPara, recorrente, ignorarEscopo,
  /** `true` quando o TEXTO veio do usuário, digitado como o banco escreve.
   *  ⚠️ Aí NÃO se passa por `termoDe`: ele existe pra tirar ruído de descrição
   *  de maquininha ("PIX", "compra", "pagamento", "debito"…) e destruiria
   *  justamente as frases que o usuário precisa cadastrar — "PAGAMENTO DEBITO
   *  AUTOMATICO" viraria "automatico". Texto do usuário é normalizado (caixa e
   *  acento) e mais nada. */
  bruto = false,
} = {}) {
  const termo = bruto ? normalizar(descricao) : termoDe(descricao);
  const tipoFinal = umDe(tipo, TIPOS, 'categorizar');
  if (!grupoId || !termo) return null;
  // Categorizar precisa de destino: categoria OU um novo nome.
  if (tipoFinal === 'categorizar' && !categoria && !renomearPara) return null;
  const agora = new Date().toISOString();

  const campos = {
    categoria: tipoFinal === 'ignorar' ? null : (categoria || null),
    tipo:           tipoFinal,
    modo_match:     umDe(modoMatch, MATCHES, 'contem'),
    renomear_para:  tipoFinal === 'ignorar' ? null : (renomearPara || null),
    recorrente:     tipoFinal === 'ignorar' ? false : recorrente === true,
    ignorar_escopo: tipoFinal === 'ignorar' ? umDe(ignorarEscopo, ESCOPOS, 'tudo') : null,
    updated_at:     agora,
  };

  // ⚠️ Tolerante à migration 146: se as colunas novas ainda não existem, a
  // gravação cai pro conjunto antigo (termo + categoria) em vez de falhar. Sem
  // isto, subir o código antes de rodar a migration quebraria até a regra
  // simples que já funcionava.
  const semNovas = (obj) => ({ categoria: obj.categoria, updated_at: obj.updated_at });
  const ehColunaNova = (e) => /tipo|modo_match|renomear_para|recorrente|ignorar_escopo/i.test(e?.message || '');

  // ⚠️ ERRO CLARO EM VEZ DE 23502. Antes da migration 146, `categoria` ainda é
  // NOT NULL — então uma regra de "não considerar" (que não tem categoria) e
  // uma regra só de renomear estouram com "null value in column categoria",
  // que não diz nada a quem está na tela. Aqui a falha vira uma frase que o
  // painel mostra e que diz exatamente o que fazer.
  const precisa146 = tipoFinal === 'ignorar' || !campos.categoria;
  const erroMigration = () => Object.assign(
    new Error('Esse tipo de regra precisa da migration 146 (sql/146_regras_completas.sql). Rode-a no Supabase e tente de novo.'),
    { code: 'MIGRATION_146' });

  // 1) Já existe? Atualiza a regra inteira.
  const { data: atual, error: eSel } = await supabase.from('regras_categoria')
    .select('id').eq('grupo_id', grupoId).eq('termo', termo).maybeSingle();
  if (eSel) throw eSel;

  if (atual?.id) {
    let { error } = await supabase.from('regras_categoria')
      .update(campos).eq('id', atual.id);
    if (error && ehColunaNova(error)) {
      if (precisa146) throw erroMigration();
      ({ error } = await supabase.from('regras_categoria')
        .update(semNovas(campos)).eq('id', atual.id));
    }
    if (error) throw error;
    invalidarCache(grupoId);
    return termo;
  }

  // 2) Não existe: insere.
  const base = { grupo_id: grupoId, termo, criado_por: userId || null };
  let { error } = await supabase.from('regras_categoria').insert({ ...base, ...campos });
  if (error && ehColunaNova(error)) {
    if (precisa146) throw erroMigration();
    ({ error } = await supabase.from('regras_categoria').insert({ ...base, ...semNovas(campos) }));
  }
  if (error) {
    // 23502 = not-null: só acontece antes da 146, com regra sem categoria.
    if (error.code === '23502') throw erroMigration();
    // ⚠️ CORRIDA: duas correções do mesmo estabelecimento ao mesmo tempo. O
    // índice único barra a segunda — e aí o certo é atualizar, não estourar.
    // (23505 = unique_violation)
    if (error.code === '23505') {
      let { error: e2 } = await supabase.from('regras_categoria')
        .update(campos).eq('grupo_id', grupoId).eq('termo', termo);
      if (e2 && ehColunaNova(e2)) {
        ({ error: e2 } = await supabase.from('regras_categoria')
          .update(semNovas(campos)).eq('grupo_id', grupoId).eq('termo', termo));
      }
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
    // ⚠️ Casa contra a descrição ORIGINAL do banco. Se uma regra já renomeou a
    // linha neste mesmo lote, casar pelo nome novo faria a segunda regra ver um
    // texto que o banco nunca mandou.
    const alvo = normalizar(linha.observacao || linha.descricao);
    if (!alvo) continue;
    const r = regras.find((x) => casaRegra(alvo, x));
    if (!r) continue;
    if (aplicarNaLinha(linha, r)) aplicadas++;
  }
  return aplicadas;
}

/**
 * Aplica uma regra a uma linha que ainda vai ser inserida. Devolve `true` se
 * mudou alguma coisa.
 *
 * ⚠️ ESTA É A FONTE ÚNICA do efeito de uma regra. O import (OFX), os três syncs
 * de Open Finance e a criação manual passam todos por aqui — se cada um
 * aplicasse à sua maneira, "não considerar" valeria no extrato e não no sync,
 * que é o tipo de divergência que este projeto já pagou caro pra resolver.
 */
function aplicarNaLinha(linha, regra) {
  let mudou = false;

  if (regra.tipo === 'ignorar') {
    const escopo = regra.ignorar_escopo || 'tudo';
    if (linha.ignorar_em !== escopo) { linha.ignorar_em = escopo; mudou = true; }
    // ⚠️ Ignorar NÃO mexe em categoria nem em nome. A linha continua sendo o
    // que é — ela só para de contar. O print diz "a linha fica esmaecida nas
    // listas", não "a linha vira outra coisa".
    return mudou;
  }

  if (regra.categoria && linha.categoria !== regra.categoria) {
    linha.categoria = regra.categoria; mudou = true;
  }
  if (regra.renomear_para && linha.observacao !== regra.renomear_para) {
    linha.observacao = regra.renomear_para; mudou = true;
  }
  if (regra.recorrente === true && linha.recorrente !== true) {
    linha.recorrente = true; mudou = true;
  }
  return mudou;
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
async function atualizarRegra({
  grupoId, id, categoria, tipo, modoMatch, renomearPara, recorrente, ignorarEscopo,
} = {}) {
  if (!grupoId || !id) return null;

  // Só os campos ENVIADOS entram no patch — a tela de lista manda só a
  // categoria, e sobrescrever o resto com default apagaria o renome e o
  // "recorrente" que a pessoa configurou no formulário completo.
  const patch = { updated_at: new Date().toISOString() };
  if (categoria !== undefined)     patch.categoria      = categoria || null;
  if (tipo !== undefined)          patch.tipo           = umDe(tipo, TIPOS, 'categorizar');
  if (modoMatch !== undefined)     patch.modo_match     = umDe(modoMatch, MATCHES, 'contem');
  if (renomearPara !== undefined)  patch.renomear_para  = renomearPara || null;
  if (recorrente !== undefined)    patch.recorrente     = recorrente === true;
  if (ignorarEscopo !== undefined) patch.ignorar_escopo = umDe(ignorarEscopo, ESCOPOS, 'tudo');

  // Virou "ignorar"? Os campos de categorizar deixam de fazer sentido.
  if (patch.tipo === 'ignorar') {
    patch.categoria = null; patch.renomear_para = null; patch.recorrente = false;
    if (patch.ignorar_escopo === undefined) patch.ignorar_escopo = 'tudo';
  }

  const tentar = async (p) => supabase.from('regras_categoria')
    .update(p).eq('id', id).eq('grupo_id', grupoId).select().maybeSingle();

  let { data, error } = await tentar(patch);
  // Tolerante à migration 146, como no `salvarRegra`.
  if (error && /tipo|modo_match|renomear_para|recorrente|ignorar_escopo/i.test(error.message || '')) {
    ({ data, error } = await tentar({ categoria: patch.categoria, updated_at: patch.updated_at }));
  }
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
  // Regra completa (146) — expostos pro eval e pra quem aplica fora do lote.
  casaRegra, regraPara, aplicarNaLinha, TIPOS, MATCHES, ESCOPOS,
};
