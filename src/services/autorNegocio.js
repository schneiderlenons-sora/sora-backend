// =============================================================================
// AUTORIA nas listas do Negócios — Fase 5 do multiusuário.
//
// Com equipe (migration 173), "quem lançou isto?" passa a importar: o dono quer
// ver que foi o gerente da noite quem registrou a saída. O `user_id` já é
// gravado em lancamentos_negocio (e cada venda tem um lançamento ligado) — isto
// aqui só LÊ e anexa o nome. Zero migration, zero escrita.
//
// ⚠️ Busca os users SEPARADO, sem embedding. lancamentos_negocio tem DOIS FKs
// pra users-relacionados (user_id e funcionario_id→funcionarios) e o embed
// ambíguo faria a lista inteira falhar — a mesma pegadinha da tela de Acessos.
// =============================================================================
const supabase = require('../db/supabase');

/**
 * PURA: anexa `criado_por_nome` a cada linha, a partir de um mapa id→nome.
 * Linha sem o campo (lançamento antigo, sem autor) fica com `null` — a tela
 * simplesmente não mostra "por fulano", em vez de quebrar.
 */
function aplicarAutor(rows, mapa, campo = 'user_id') {
  const lista = Array.isArray(rows) ? rows : [];
  const m = mapa || {};
  return lista.map((r) => {
    if (!r || typeof r !== 'object') return r;
    const id = r[campo];
    return { ...r, criado_por_nome: id && m[id] ? m[id] : null };
  });
}

/** Lê os nomes de uma lista de user_ids. Tolerante: falha → mapa vazio. */
async function nomesDeUsuarios(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return {};
  try {
    const { data } = await supabase.from('users').select('id, name, email').in('id', uniq);
    return Object.fromEntries((data || []).map((u) => [u.id, u.name || u.email || null]));
  } catch { return {}; }
}

/** IO: pega as linhas (com `campo`=user_id) e devolve com `criado_por_nome`. */
async function anexarAutor(rows, { campo = 'user_id' } = {}) {
  const lista = Array.isArray(rows) ? rows : [];
  const mapa = await nomesDeUsuarios(lista.map((r) => r && r[campo]));
  return aplicarAutor(lista, mapa, campo);
}

/**
 * IO: autoria das VENDAS — vem do lançamento ligado (vendas_negocio não tem
 * user_id próprio). Resolve lancamento_id → user_id → nome em duas buscas.
 */
async function anexarAutorVendas(vendas) {
  const lista = Array.isArray(vendas) ? vendas : [];
  const lancIds = [...new Set(lista.map((v) => v && v.lancamento_id).filter(Boolean))];
  if (!lancIds.length) return aplicarAutor(lista, {}, '__nenhum__');

  let lancUser = {};
  try {
    const { data } = await supabase.from('lancamentos_negocio').select('id, user_id').in('id', lancIds);
    lancUser = Object.fromEntries((data || []).map((l) => [l.id, l.user_id]));
  } catch { /* sem autoria então */ }

  const mapa = await nomesDeUsuarios(Object.values(lancUser));
  return lista.map((v) => {
    if (!v || typeof v !== 'object') return v;
    const uid = v.lancamento_id ? lancUser[v.lancamento_id] : null;
    return { ...v, criado_por_nome: uid && mapa[uid] ? mapa[uid] : null };
  });
}

module.exports = { aplicarAutor, nomesDeUsuarios, anexarAutor, anexarAutorVendas };
