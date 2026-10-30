// =============================================================================
// O "APRENDE" DO CAIXA DA EMPRESA (Sora Negócios, migration 192).
//
// O que vem da conta do banco entra "a classificar" (decisão do dono: neutra +
// aprende). Classificar um lançamento com "classificar assim os próximos
// parecidos" grava uma regra da EMPRESA; os próximos que chegarem do banco já
// entram com a categoria, e os que ainda estão "a classificar" são acertados na
// hora.
//
// ⚠️ O CASAMENTO É O MESMO DAS FINANÇAS PESSOAIS (`regrasCategoria.casaRegra`
// e `termoDe`) — fonte única. Uma segunda regra de "descrição parecida" seria a
// terceira cópia de uma pergunta que este projeto já pagou caro pra unificar.
//
// ⚠️ DESCRIÇÃO GENÉRICA NÃO VIRA REGRA. "PIX RECEBIDO" sem nome casaria com
// TODO Pix da conta e classificaria o mês inteiro errado. Só aprende quando
// sobra nome de verdade (4+ letras fora do ruído do banco).
// ⚠️ NUNCA SOBRESCREVE ESCOLHA DA PESSOA: aplicar no que já existe só mexe no
// que ainda está "a classificar".
// =============================================================================

const CAT_A_CLASSIFICAR = 'a_classificar';

// Lazy: este módulo é exigido pelo espelho, e o eval do espelho não deve
// precisar do cliente do Supabase só pra carregar.
const regras = () => require('./regrasCategoria');

/** Termo que a regra guarda, ou null quando a descrição é genérica demais. */
function termoAprendivel(descricao) {
  const { normalizar, termoDe } = regras();
  // O que sobra da descrição tirando o ruído do banco e os números (códigos,
  // datas). Sem 4+ letras de nome de verdade, não há o que aprender.
  const nome = normalizar(descricao).split(' ')
    .filter((p) => p && !RUIDO_GENERICO.test(p) && !/^\d+$/.test(p)).join('');
  if (nome.replace(/[^a-z]/g, '').length < 4) return null;
  // O termo é o do `termoDe` (fonte única) sem o ruído de banco que ele não
  // conhece ("enviada", "tarifa"…): "TED ENVIADA ACME" e "PIX ENVIADO ACME"
  // têm de virar o MESMO termo, senão a regra de um não casa com o outro.
  const termo = termoDe(descricao).split(' ').filter((p) => p && !RUIDO_GENERICO.test(p)).join(' ');
  return termo || null;
}
// Palavras que, sozinhas, não identificam ninguém (o ruído do termoDe + o que os
// bancos põem na descrição de Pix/TED).
const RUIDO_GENERICO = /^(pix|ted|doc|tef|compra|pagamento|pag|pgto|debito|credito|cartao|transferencia|transf|recebido|recebida|enviado|enviada|para|de|da|do|em|parcela|parc|mensalidade|ltda|me|mei|eireli|sa|tarifa|boleto|deposito|saque|rendimento|aplicacao|resgate)$/;

/**
 * A categoria que as regras da empresa dão a este lançamento (ou null).
 * Entre várias que casam, vence a de termo MAIS LONGO (a mais específica);
 * regra com sentido (entrada/saída) só vale pra ele.
 */
function categoriaPorRegra(lista, lanc) {
  if (!lista || !lista.length || !lanc) return null;
  const { normalizar, casaRegra } = regras();
  const alvo = normalizar(lanc.descricao);
  if (!alvo) return null;
  const casam = lista
    .filter((r) => r && r.termo && r.categoria && (!r.tipo || r.tipo === lanc.tipo))
    .filter((r) => casaRegra(alvo, { termo: r.termo, modo_match: 'contem' }))
    .sort((a, b) => b.termo.length - a.termo.length);
  return casam.length ? casam[0].categoria : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUÇÃO
// ─────────────────────────────────────────────────────────────────────────────

/** Regras da empresa. Tolerante: sem a migration 192, lista vazia. */
async function carregarRegras(empresaId, { supabase = require('../db/supabase') } = {}) {
  if (!empresaId) return [];
  try {
    const { data, error } = await supabase.from('regras_negocio')
      .select('termo, tipo, categoria').eq('empresa_id', empresaId);
    return error ? [] : (data || []);
  } catch { return []; }
}

/**
 * Grava (ou atualiza) a regra e acerta o que ainda está "a classificar".
 * @returns {{ termo:string|null, aplicadas:number, motivo?:string }}
 */
async function aprender({ empresaId, userId, descricao, tipo, categoria }, { supabase = require('../db/supabase') } = {}) {
  if (!categoria || categoria === CAT_A_CLASSIFICAR) return { termo: null, aplicadas: 0, motivo: 'sem_categoria' };
  const termo = termoAprendivel(descricao);
  if (!termo) return { termo: null, aplicadas: 0, motivo: 'generica' };
  const sentido = tipo === 'entrada' || tipo === 'saida' ? tipo : null;

  // Upsert à mão: o índice único é por expressão (coalesce do tipo), que o
  // `onConflict` do PostgREST não alcança.
  const q = supabase.from('regras_negocio').select('id').eq('empresa_id', empresaId).eq('termo', termo);
  const { data: ja, error: eLer } = await (sentido ? q.eq('tipo', sentido) : q.is('tipo', null)).maybeSingle();
  if (eLer) return { termo: null, aplicadas: 0, motivo: 'sem_migration' };
  const agora = new Date().toISOString();
  const { error: eGrava } = ja
    ? await supabase.from('regras_negocio').update({ categoria, updated_at: agora }).eq('id', ja.id)
    : await supabase.from('regras_negocio').insert({ empresa_id: empresaId, user_id: userId || null, termo, tipo: sentido, categoria });
  if (eGrava) return { termo: null, aplicadas: 0, motivo: 'sem_migration' };

  // Os que ainda estão "a classificar" e casam — nunca a escolha da pessoa.
  const { data: pendentes } = await supabase.from('lancamentos_negocio')
    .select('id, descricao, tipo').eq('empresa_id', empresaId).eq('categoria', CAT_A_CLASSIFICAR);
  const regra = [{ termo, tipo: sentido, categoria }];
  const ids = (pendentes || []).filter((l) => categoriaPorRegra(regra, l)).map((l) => l.id);
  if (ids.length) {
    const { error } = await supabase.from('lancamentos_negocio').update({ categoria })
      .in('id', ids).eq('categoria', CAT_A_CLASSIFICAR);
    if (error) return { termo, aplicadas: 0 };
  }
  return { termo, aplicadas: ids.length };
}

module.exports = { termoAprendivel, categoriaPorRegra, carregarRegras, aprender, CAT_A_CLASSIFICAR };
