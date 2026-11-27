// =============================================================================
// Compra do cartão DIVIDIDA com outra pessoa (pedido do Arisson, nov/2026).
//
// "Comprei uma geladeira de R$ 3.000 em 10x de R$ 300 e minha esposa paga
// metade." Cada parcela guarda com quem foi dividida (`dividida_com`) e quanto
// dela é da outra pessoa (`parte_outro`), migration 206.
//
// ⚠️ A COMPRA CONTINUA INTEIRA. A fatura tem de bater com a do banco, e quem
// passou o cartão foi o cliente. Nenhum total do painel muda nesta etapa: a
// parte da outra pessoa é o que ela DEVE, e o acerto dela (`divisoes_acertos`)
// é registrado à parte. Contar só a parte do cliente nos relatórios é a etapa 2
// (decisão do dono, ainda não feita) — mexe em todas as somas do app.
//
// ⚠️ SÓ COMPRA NO CARTÃO, na moeda do grupo. Pagamento de fatura,
// transferência e estorno não são compra; cartão em outra moeda guarda dois
// valores (base e nativo) e dividir exigiria regra própria.
//
// Regras puras aqui (travadas em `eval:divisao-compra`); as rotas ficam em
// routes/divisoes.js.
// =============================================================================

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

const MAX_NOME = 60;

/** O nome como a pessoa escreveu, sem espaço sobrando. '' → null. */
function normalizarPessoa(nome) {
  const s = String(nome ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, MAX_NOME).trim();
}

/** "Mesma pessoa" = mesma chave: sem acento, caixa nem pontuação. */
function chavePessoa(nome) {
  return String(nome ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Valida o pedido de divisão vindo da tela.
 *   null / undefined / { remover: true } → tirar a divisão
 *   { com, modo: 'metade' }               → metade de cada linha
 *   { com, modo: 'valor', valor }         → esse valor em cada linha
 */
function validarDivisao(d) {
  if (d == null || d.remover === true) return { ok: true, divisao: null };
  if (typeof d !== 'object') return { ok: false, erro: 'Divisão inválida.' };
  const com = normalizarPessoa(d.com);
  if (!com) return { ok: false, erro: 'Diga com quem a compra foi dividida.' };
  if (String(d.com).trim().length > MAX_NOME) return { ok: false, erro: `O nome pode ter até ${MAX_NOME} letras.` };
  if (d.modo === 'metade') return { ok: true, divisao: { com, modo: 'metade' } };
  if (d.modo === 'valor') {
    const valor = cent(d.valor);
    if (!(valor > 0)) return { ok: false, erro: 'Informe quanto é da outra pessoa.' };
    return { ok: true, divisao: { com, modo: 'valor', valor } };
  }
  return { ok: false, erro: 'Escolha metade ou um valor.' };
}

/**
 * Quanto desta linha é da outra pessoa. null = não dá (valor zerado, parte
 * maior que a linha). Na metade, o centavo ímpar fica com quem passou o
 * cartão: R$ 300,01 → R$ 150,00 da outra pessoa.
 */
function parteDoOutro(valorLinha, divisao) {
  const v = cent(valorLinha);
  if (!divisao || !(v > 0)) return null;
  if (divisao.modo === 'metade') {
    const p = Math.floor(Math.round(v * 100) / 2) / 100;
    return p > 0 ? p : null;
  }
  const p = cent(divisao.valor);
  if (!(p > 0) || p > v) return null;
  return p;
}

const norm = (s) => chavePessoa(s);

/** Por que esta linha NÃO pode ser dividida — ou null quando pode. */
function motivoNaoDivide(tx, carteira) {
  if (!tx) return 'Lançamento não encontrado.';
  if (tx.tipo !== 'Gasto') return 'Só dá pra dividir uma compra.';
  const cat = norm(tx.categoria);
  if (tx.transferencia === true || cat === 'fatura' || cat === 'fatura anterior' || cat === 'ajuste'
      || cat === 'transferencias') {
    return 'Pagamento de fatura, ajuste e transferência não se dividem.';
  }
  if (!carteira || carteira.tipo !== 'Crédito') return 'Por enquanto, só compra no cartão de crédito pode ser dividida.';
  if (tx.moeda) return 'Compra em outra moeda ainda não pode ser dividida.';
  return null;
}

/**
 * O que gravar em cada linha. Com `divisao` null, tira a divisão de todas.
 * ⚠️ Tudo ou nada: se a parte não cabe em ALGUMA parcela (valor fixo maior que
 * a parcela), nada é gravado — metade da compra dividida e metade não seria
 * pior que o erro.
 * @returns {{ ok: true, patches: Array<{ id, patch }> } | { ok: false, erro }}
 */
function planoDaDivisao(linhas, divisao) {
  const patches = [];
  for (const l of linhas || []) {
    if (!divisao) {
      if (l.dividida_com != null || l.parte_outro != null) patches.push({ id: l.id, patch: { dividida_com: null, parte_outro: null } });
      continue;
    }
    const parte = parteDoOutro(l.valor, divisao);
    if (parte == null) {
      return { ok: false, erro: divisao.modo === 'valor'
        ? 'A parte da outra pessoa não pode ser maior que a parcela.'
        : 'Esta compra tem valor zerado.' };
    }
    if (l.dividida_com !== divisao.com || cent(l.parte_outro) !== parte) {
      patches.push({ id: l.id, patch: { dividida_com: divisao.com, parte_outro: parte } });
    }
  }
  return { ok: true, patches };
}

/** Erro de coluna/tabela que só existe depois da migration 206. */
function faltaMigracao(error) {
  const m = String(error?.message || error || '');
  return /dividida_com|parte_outro|divisoes_acertos/i.test(m)
    && /(column|schema cache|does not exist|relation|Could not find)/i.test(m);
}

/**
 * Grava a divisão na linha e — com `aplicarParcelas` — nas outras parcelas da
 * mesma compra (mesmo `parcela_grupo`, total e cartão: a regra de irmãs do
 * "aplicar nas outras parcelas"). Mesma mudança em várias linhas vai num
 * update só (o custo do Supabase é o número de idas).
 */
async function aplicarDivisao({ grupoId, tx, divisao, aplicarParcelas }, { supabase = require('../db/supabase') } = {}) {
  let linhas = [tx];
  if (aplicarParcelas && tx.parcela_grupo && Number(tx.parcela_total) > 1) {
    let q = supabase.from('transacoes')
      .select('id, valor, tipo, dividida_com, parte_outro')
      .eq('grupo_id', grupoId)
      .eq('parcela_grupo', tx.parcela_grupo)
      .eq('parcela_total', tx.parcela_total)
      .eq('tipo', 'Gasto');
    if (tx.carteira_nome) q = q.eq('carteira_nome', tx.carteira_nome);
    const { data, error } = await q;
    if (error) {
      if (faltaMigracao(error)) return { ok: false, codigo: 'sem_migracao' };
      return { ok: false, status: 500, erro: 'Não consegui ler as outras parcelas agora. Tente de novo.' };
    }
    linhas = [tx, ...(data || []).filter((l) => l.id !== tx.id)];
  }
  const plano = planoDaDivisao(linhas, divisao);
  if (!plano.ok) return { ...plano, status: 400 };

  const porPatch = new Map();
  for (const { id, patch } of plano.patches) {
    const k = JSON.stringify(patch);
    (porPatch.get(k) || porPatch.set(k, { patch, ids: [] }).get(k)).ids.push(id);
  }
  let atualizadas = 0;
  for (const { patch, ids } of porPatch.values()) {
    const { error } = await supabase.from('transacoes').update(patch).in('id', ids).eq('grupo_id', grupoId);
    if (error) {
      if (faltaMigracao(error)) return { ok: false, codigo: 'sem_migracao' };
      return { ok: false, status: 500, erro: 'Não consegui salvar a divisão agora. Tente de novo.', atualizadas };
    }
    atualizadas += ids.length;
  }
  return { ok: true, atualizadas, linhas: linhas.length };
}

/**
 * Divisão pedida junto com a CRIAÇÃO da compra (Nova transação). A compra já
 * foi gravada: falhar aqui não a desfaz — a tela avisa e a pessoa divide depois.
 * @returns {Promise<null | { ok: boolean, erro?: string, codigo?: string }>}
 */
async function dividirAoCriar({ grupoId, tx, divisaoBruta }, deps = {}) {
  if (divisaoBruta == null || !tx) return null;
  const v = validarDivisao(divisaoBruta);
  if (!v.ok) return { ok: false, erro: v.erro };
  if (!v.divisao) return null;
  const supabase = deps.supabase || require('../db/supabase');
  const { data: ws } = await supabase.from('wallets').select('id, nome, tipo').eq('grupo_id', grupoId);
  const carteira = (ws || []).find((w) => chavePessoa(w.nome) === chavePessoa(tx.carteira_nome));
  const motivo = motivoNaoDivide(tx, carteira);
  if (motivo) return { ok: false, erro: motivo };
  const r = await aplicarDivisao({ grupoId, tx, divisao: v.divisao, aplicarParcelas: true }, { supabase });
  return r.ok ? { ok: true, atualizadas: r.atualizadas } : { ok: false, erro: r.erro, codigo: r.codigo };
}

// ── Acertos (o que a outra pessoa já pagou de uma fatura) ────────────────────

const FORMAS = ['conta', 'vincular', 'fatura', 'registro'];

/** Valida o acerto vindo da tela. 'fatura' só nasce pelo Pagar fatura. */
function validarAcerto(b) {
  if (!b || typeof b !== 'object') return { ok: false, erro: 'Acerto inválido.' };
  const pessoa = normalizarPessoa(b.pessoa);
  if (!pessoa) return { ok: false, erro: 'Diga quem pagou.' };
  if (!b.cartao_id) return { ok: false, erro: 'Cartão não informado.' };
  if (!/^\d{4}-\d{2}$/.test(String(b.competencia || ''))) return { ok: false, erro: 'Fatura não informada.' };
  const valor = cent(b.valor);
  if (!(valor > 0)) return { ok: false, erro: 'Informe o valor que a pessoa pagou.' };
  const forma = String(b.forma || '');
  if (!FORMAS.includes(forma) || forma === 'fatura') return { ok: false, erro: 'Forma de pagamento inválida.' };
  if (forma === 'conta' && !b.wallet_id) return { ok: false, erro: 'Escolha a conta em que o dinheiro entrou.' };
  if (forma === 'vincular' && !b.transacao_id) return { ok: false, erro: 'Escolha o lançamento do dinheiro que chegou.' };
  return {
    ok: true,
    acerto: {
      cartao_id: b.cartao_id, competencia: b.competencia, pessoa, pessoa_chave: chavePessoa(pessoa),
      valor, forma, wallet_id: b.wallet_id || null, transacao_id: forma === 'vincular' ? b.transacao_id : null,
    },
  };
}

/** Texto da entrada lançada quando a pessoa manda o dinheiro (forma 'conta'). */
function descricaoDoReembolso(pessoa, cartaoNome) {
  return `Parte de ${pessoa} · fatura ${cartaoNome || 'do cartão'}`.slice(0, 200);
}

/**
 * Entrada que pode ser o dinheiro da outra pessoa: Recebimento comum (não
 * transferência, não "não considerar"), na conta escolhida, ainda não ligado a
 * outro acerto. Ordem: valor mais próximo do esperado, depois o mais recente.
 */
function candidatosDeRecebimento(txs, { esperado, jaUsados = new Set() } = {}) {
  const alvo = cent(esperado);
  return (txs || [])
    .filter((t) => t && t.tipo === 'Recebimento' && t.transferencia !== true && !t.ignorar_em && !jaUsados.has(t.id))
    .map((t) => ({ id: t.id, data: String(t.data || '').slice(0, 10), valor: cent(t.valor), observacao: t.observacao || '' }))
    .sort((a, b) => (alvo > 0 ? Math.abs(a.valor - alvo) - Math.abs(b.valor - alvo) : 0) || b.data.localeCompare(a.data));
}

module.exports = {
  normalizarPessoa, chavePessoa, validarDivisao, parteDoOutro, motivoNaoDivide, planoDaDivisao,
  aplicarDivisao, dividirAoCriar, faltaMigracao, validarAcerto, descricaoDoReembolso, candidatosDeRecebimento, FORMAS,
};
