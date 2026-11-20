// =============================================================================
// Categoria da dívida (migration 198, nov/2026).
//
// Pedido de cliente: "meu Seguro Residencial é parcelado e no extrato aparece
// como Dívida — queria pôr a categoria Seguro". A dívida passa a ter uma
// categoria OPCIONAL, e o pagamento de cada parcela (painel e WhatsApp) é
// lançado nela. Sem categoria, tudo segue como antes: "Dívidas".
//
// ⚠️ Guarda o NOME, não o id — é como transacoes.categoria e
// recorrencias.categoria funcionam (o sistema inteiro casa categoria por nome).
// O nome gravado é o OFICIAL da lista do grupo, nunca o texto que chegou: assim
// "seguros" ou "🛡️ Seguros" viram a mesma "Seguros" que os relatórios agrupam.
//
// ⚠️ O reconhecimento do pagamento de parcela NÃO depende da categoria: a regra
// que impede contar a dívida duas vezes (`custoMensalDividas`) usa a descrição
// exata "Pagamento: <título>", que o próprio sistema escreve. Trocar a
// categoria do lançamento não afeta essa regra.
// =============================================================================

const CATEGORIA_PADRAO = 'Dívidas';

/** Chave de comparação: sem acento, sem emoji/símbolo, sem caixa, espaços únicos. */
const chave = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N} ]/gu, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/** Em que categoria o pagamento da parcela entra. */
function categoriaDoPagamento(divida) {
  const c = divida && typeof divida.categoria === 'string' ? divida.categoria.trim() : '';
  return c || CATEGORIA_PADRAO;
}

/**
 * Confere a categoria escolhida contra as categorias de DESPESA do grupo.
 *   vazio/null → { ok, categoria: null }      (volta ao padrão "Dívidas")
 *   existe     → { ok, categoria: <nome oficial> }
 *   não existe → { ok: false, status: 400 }    (nunca cria categoria-fantasma)
 *   leitura falhou → { ok: false, status: 500 } (não diz "inválida" por soluço)
 */
async function resolverCategoriaDivida(db, grupoId, valor) {
  if (valor === null || valor === undefined || (typeof valor === 'string' && !valor.trim())) {
    return { ok: true, categoria: null };
  }
  if (typeof valor !== 'string' || valor.length > 80) {
    return { ok: false, status: 400, erro: 'Categoria inválida.', motivo: 'categoria_invalida' };
  }
  const alvo = chave(valor);
  if (!alvo) return { ok: true, categoria: null };
  const { data, error } = await db.from('categorias').select('nome, tipo, ativa').eq('grupo_id', grupoId);
  if (error) return { ok: false, status: 500, erro: `Não consegui conferir a categoria: ${error.message}` };
  const achada = (data || []).find((c) => c.ativa !== false && c.tipo !== 'receita' && chave(c.nome) === alvo);
  if (!achada) {
    return { ok: false, status: 400, erro: 'Escolha uma categoria de despesa da sua lista.', motivo: 'categoria_inexistente' };
  }
  return { ok: true, categoria: achada.nome };
}

/**
 * Lê só a categoria de uma dívida, de forma TOLERANTE. Usado onde a dívida vem
 * de um `select` com colunas fixas (WhatsApp): pôr `categoria` lá quebraria a
 * consulta inteira enquanto a migration 198 não roda. Falhou → null ("Dívidas").
 */
async function lerCategoriaDivida(db, dividaId) {
  if (!dividaId) return null;
  try {
    const { data, error } = await db.from('dividas').select('categoria').eq('id', dividaId).maybeSingle();
    if (error || !data) return null;
    return typeof data.categoria === 'string' && data.categoria.trim() ? data.categoria.trim() : null;
  } catch { return null; }
}

/** O erro do banco é "a coluna categoria ainda não existe" (198 pendente)? */
const faltaColunaCategoria = (erro) => {
  const m = String((erro && erro.message) || '');
  return /categoria/i.test(m) && /column|schema/i.test(m);
};

module.exports = { CATEGORIA_PADRAO, chave, categoriaDoPagamento, resolverCategoriaDivida, lerCategoriaDivida, faltaColunaCategoria };
