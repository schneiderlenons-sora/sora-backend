// =============================================================================
// Árvore de categorias — emoji e família (pai → subcategorias).
//
// POR QUE ESTE ARQUIVO EXISTE:
//
// O WhatsApp tinha um mapa de emojis CRAVADO NO CÓDIGO (`EMOJIS_MAP` em
// handlers/transacoes.js), escrito antes da taxonomia v3/v4. Quando as
// categorias foram refeitas nas migrations 084→087, o mapa não acompanhou:
// Dentista, Fatura, Lanches, Financeiro e Barbeiro passaram a cair no fallback
// 📌 — mesmo tendo 🦷 💳 🌮 💰 💈 gravados na tabela `categorias`.
//
// A fonte da verdade é o BANCO. O mapa velho vira só rede de segurança pra
// categoria livre que o usuário digitou e não existe cadastrada.
//
// A árvore também resolve o segundo problema: "quanto gastei com alimentação"
// não achava nada, porque iFood e Lanches são FILHAS de Alimentação e o nome
// delas não contém a palavra. Perguntar pelo pai tem de somar os filhos.
// =============================================================================
const supabase = require('../db/supabase');

/** Sem emoji, sem acento, minúsculo — pra casar "🦷 Dentista" com "dentista". */
function limpar(nome) {
  return String(nome || '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Categorias que usam o emoji do PAI no WhatsApp.
 *
 * São as plataformas de anúncio: no painel elas aparecem com o logo oficial, e
 * o emoji do banco (📣) é o MESMO de "Marketing e Publicidade" — três linhas
 * iguais no resumo, sem dizer de onde veio o gasto. 💼 (Empreendimento) diz.
 *
 * ⚠️ A lista é curta DE PROPÓSITO. Testei estender pra todas as marcas com logo
 * e o resultado piorou: Adidas e Mercado Livre viravam 🚚 (o pai, Encomendas) e
 * ficavam indistinguíveis entre si. Quando a subcategoria tem emoji PRÓPRIO e
 * específico (👟 Adidas, 🛵 iFood, 🎵 Spotify), ele ganha do pai.
 */
const MARCAS_COM_LOGO = new Set(['facebook ads', 'google ads']);

/**
 * Monta a árvore do grupo.
 * @returns {{porNome: Map, filhos: Map}} chaveadas pelo nome LIMPO.
 */
function montarArvore(linhas) {
  const porId = new Map((linhas || []).map(c => [c.id, c]));
  const porNome = new Map();
  const filhos  = new Map();

  for (const c of linhas || []) {
    const pai = c.parent_id ? porId.get(c.parent_id) : null;
    const chave = limpar(c.nome);
    porNome.set(chave, {
      nome: c.nome,
      icone: c.icone || null,
      paiNome: pai?.nome || null,
      paiIcone: pai?.icone || null,
    });
    if (pai) {
      const k = limpar(pai.nome);
      if (!filhos.has(k)) filhos.set(k, []);
      filhos.get(k).push(c.nome);
    }
  }
  return { porNome, filhos };
}

/**
 * Emoji de uma categoria: o dela → o do pai (marca com logo, ou sem emoji
 * próprio) → o que vier de `fallback` → 📌.
 */
function emojiPara(nome, arvore, fallback) {
  const chave = limpar(nome);
  if (!chave) return '📌';

  const cat = arvore?.porNome?.get(chave);
  if (cat) {
    if (MARCAS_COM_LOGO.has(chave) && cat.paiIcone) return cat.paiIcone;
    if (cat.icone) return cat.icone;
    if (cat.paiIcone) return cat.paiIcone;
  }

  // O nome pode vir com o emoji colado ("🦷 Dentista") de um lançamento antigo.
  const jaTem = String(nome || '').match(/^\s*(\p{Extended_Pictographic}\p{Emoji_Modifier}?)/u);
  if (jaTem) return jaTem[1];

  const alt = typeof fallback === 'function' ? fallback(nome) : null;
  return alt && alt !== '📌' ? alt : '📌';
}

/**
 * Categorias-PAI que o usuário pensa como uma coisa só, mas a taxonomia separa.
 *
 * Na v4, `Delivery` e `Mercado` são categorias de topo IRMÃS de `Alimentação` —
 * não filhas. Então "quanto gastei com alimentação" não trazia o iFood, que é
 * exatamente o que o usuário esperava ver. Isto vale só na BUSCA: a estrutura
 * das categorias (painel, relatórios, categorizador) não muda.
 *
 * Só entra aqui o que é a mesma coisa no mundo real, não o que é "parecido".
 */
const AFINS = {
  'alimentacao': ['Delivery', 'Mercado'],
  'comida':      ['Alimentação', 'Delivery', 'Mercado'],
};

/**
 * Nomes que respondem por um termo de busca.
 *
 * Se o termo é uma categoria PAI, devolve ela + todas as filhas ("alimentação"
 * → Supermercado, Padaria, iFood, Lanches…). Se é uma subcategoria, devolve só
 * ela — quem perguntou por "ifood" não quer o supermercado junto.
 *
 * @returns {string[]|null} null quando o termo não casa com categoria nenhuma
 *          (aí o chamador mantém a busca por texto livre).
 */
function familiaDe(termo, arvore) {
  const chave = limpar(termo);
  if (!chave || !arvore?.porNome) return null;

  // Assuntos afins: puxa as irmãs de topo + as filhas delas.
  const extras = [];
  for (const nome of AFINS[chave] || []) {
    const k = limpar(nome);
    if (!arvore.porNome.has(k)) continue;
    extras.push(arvore.porNome.get(k).nome, ...(arvore.filhos.get(k) || []));
  }

  // Casamento exato primeiro; depois "começa com"/"contém", pra aceitar
  // "alimentacao" ↔ "Alimentação" e "mercado" ↔ "Supermercado".
  let alvo = arvore.porNome.has(chave) ? chave : null;
  if (!alvo) {
    const candidatos = [...arvore.porNome.keys()]
      .filter(k => k.includes(chave) || chave.includes(k))
      // O mais curto é o mais próximo do termo ("mercado" → "supermercado",
      // não "mercado livre" se ambos casarem por igual.
      .sort((a, b) => Math.abs(a.length - chave.length) - Math.abs(b.length - chave.length));
    alvo = candidatos[0] || null;
  }
  if (!alvo) return extras.length ? [...new Set(extras)] : null;

  const cat = arvore.porNome.get(alvo);
  const nomes = [cat.nome, ...(arvore.filhos.get(alvo) || []), ...extras];
  return [...new Set(nomes)];
}

// Categoria muda pouco e o resumo lê a cada mensagem — 60s de cache evita uma
// query por interação sem segurar mudança do usuário.
const cache = new Map(); // grupoId → { em, arvore }
const TTL = 60_000;

async function arvoreDoGrupo(grupoId) {
  if (!grupoId) return { porNome: new Map(), filhos: new Map() };
  const hit = cache.get(grupoId);
  if (hit && Date.now() - hit.em < TTL) return hit.arvore;

  let linhas = [];
  try {
    const { data } = await supabase.from('categorias')
      .select('id, nome, icone, parent_id').eq('grupo_id', grupoId);
    linhas = data || [];
  } catch { /* sem categorias → cai no fallback do chamador */ }

  const arvore = montarArvore(linhas);
  cache.set(grupoId, { em: Date.now(), arvore });
  return arvore;
}

module.exports = {
  arvoreDoGrupo, montarArvore, emojiPara, familiaDe, limpar, MARCAS_COM_LOGO,
};
