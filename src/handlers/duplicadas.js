// =============================================================================
// Detetive Watson no WhatsApp — pedir a investigação e apagar a cópia.
//
// LOCAL-FIRST: detecta o pedido por regex, sem passar pela IA (regra da casa).
//
// Fluxo em 2 passos, de propósito:
//   1. "tem duplicada?"  → lista numerada + pendente `escolher_duplicada`
//   2. "apaga a 2"       → mostra QUAL cópia vai sumir + pendente de confirmação
//   3. "sim"             → exclui
//
// ⚠️ Exclusão NUNCA acontece em um passo só. No painel o erro é barato (tem
// "Desfazer" por 10s); aqui não existe desfazer, então a confirmação nomeando
// valor e data é a única proteção contra apagar o lançamento errado.
//
// ⚠️ Só as duplicatas CONFIRMADAS entram aqui. As "suspeitas" (mesmo valor e
// descrição, sem prova) ficam só no painel: no zap não dá pra mostrar as duas
// lado a lado, e sugerir exclusão do que é provavelmente legítimo é o jeito
// mais rápido de destruir a confiança no agente.
// =============================================================================

const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/mensageiro');
const { criarPendente, removerPendente } = require('../services/pendentes');
const { buscarAnalise, explicar } = require('../services/duplicadas');
const { falar } = require('../agentes');

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dia = (d) => { const p = String(d || '').slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}` : ''; };
const norm = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

/**
 * É um pedido de investigação de duplicadas?
 *
 * Gatilhos ESTREITOS: precisa da ideia de "repetido/duplicado" junto de
 * lançamento/compra/cobrança, ou o nome do agente. "Paguei duas vezes o
 * aluguel" NÃO pode virar investigação — é um relato, não um pedido.
 */
function ehPedidoDuplicadas(msg) {
  const t = norm(msg);
  if (!t || t.length > 120) return false;
  if (/\bwatson\b/.test(t)) return true;
  const tema = /(duplicad|repetid|em dobro|duas vezes|2 vezes|dobrad)/.test(t);
  if (!tema) return false;
  const objeto = /(lancament|transac|compra|cobranc|gasto|fatura|conta|nada|algo|alguma|tem)/.test(t);
  const pergunta = /\?|^(tem|ha|existe|acha|procura|confere|verifica|checa|olha)/.test(t);
  return objeto || pergunta;
}

/** Fatura atual quando a pessoa disse "fatura"; senão, geral. */
function pediuFatura(msg) { return /fatura|cartao|cartão/i.test(String(msg || '')); }

async function cartaoPrincipal(grupoId) {
  const { data } = await supabase.from('wallets')
    .select('id, nome').eq('grupo_id', grupoId).eq('tipo', 'Crédito')
    .order('created_at', { ascending: true }).limit(1);
  return (data && data[0]) || null;
}

/** Passo 1 — lista o que achou e abre a pendente. */
async function responderDuplicadas(phone, user, msg) {
  const grupoId = user && user.grupo_ativo;
  if (!grupoId) return false;

  let cartaoId = null;
  if (pediuFatura(msg)) {
    const c = await cartaoPrincipal(grupoId);
    cartaoId = c && c.id;
  }

  const { confirmadas, suspeitas, escopo } = await buscarAnalise(grupoId, { dias: 90, cartaoId });
  const onde = escopo && escopo.tipo === 'fatura'
    ? `na fatura atual do ${escopo.cartao}` : 'nos últimos 90 dias';

  if (!confirmadas.length) {
    // Suspeita não vira acusação — só um convite pro painel, onde dá pra ver
    // as duas lado a lado.
    const extra = suspeitas.length
      ? `\n\nHá ${suspeitas.length === 1 ? '1 caso' : `${suspeitas.length} casos`} de mesmo valor e descrição `
        + `em dias seguidos — pode ser compra repetida de verdade. Se quiser conferir, estão no meu card no painel.`
      : '';
    const texto = `🔍 Examinei tudo ${onde}: *nenhuma compra entrou duas vezes*.${extra}`;
    await enviarTexto(phone, falar('detetive-watson', 'duplicadas', { texto, core: texto, seed: grupoId }).texto);
    return true;
  }

  const lista = confirmadas.slice(0, 5).map((g, i) => {
    const t = g.transacoes[0];
    return `${NUM[i]} *${brl(t.valor)}* · ${String(t.observacao || t.categoria || 'Lançamento').slice(0, 38)}\n`
      + `   _${explicar(g)}_`;
  }).join('\n\n');
  const sobra = confirmadas.length > 5 ? `\n\n…e mais ${confirmadas.length - 5} no painel.` : '';

  const texto = `🔍 *Achei ${confirmadas.length === 1 ? 'um lançamento repetido' : `${confirmadas.length} lançamentos repetidos`}* ${onde}:\n\n`
    + `${lista}${sobra}\n\nResponda o *número* pra eu apagar a cópia (ex.: *1*).`;

  await enviarTexto(phone, falar('detetive-watson', 'duplicadas', { texto, core: texto, seed: grupoId }).texto);

  await criarPendente({
    userId: user.id,
    tipoPergunta: 'escolher_duplicada',
    // Guarda só o necessário: ids e rótulo. Contexto gordo em JSONB envelhece
    // mal (a transação pode mudar antes da resposta) — relemos na hora de agir.
    contexto: {
      grupos: confirmadas.slice(0, 5).map((g) => ({
        ids: g.transacoes.map((t) => t.id),
        rotulo: `${brl(g.transacoes[0].valor)} · ${String(g.transacoes[0].observacao || '').slice(0, 38)}`,
      })),
    },
  });
  return true;
}

/** Passo 2 e 3 — resolve a escolha e a confirmação. */
async function resolverDuplicada(pendente, texto, phone) {
  const t = norm(texto);

  // ── Passo 2: escolheu o número ──────────────────────────────────────
  if (pendente.tipo_pergunta === 'escolher_duplicada') {
    const grupos = (pendente.contexto && pendente.contexto.grupos) || [];
    const m = t.match(/(\d+)/);
    if (!m) return false;                       // não é resposta pra isto
    const idx = parseInt(m[1], 10) - 1;
    if (idx < 0 || idx >= grupos.length) {
      await enviarTexto(phone, `Não achei esse número. Responda de *1* a *${grupos.length}*.`);
      return true;
    }

    const ids = grupos[idx].ids || [];
    if (ids.length < 2) { await removerPendente(pendente.id); return false; }

    // Relê do banco: entre a listagem e a resposta o usuário pode ter apagado
    // pelo painel. Agir sobre contexto velho apagaria a transação errada.
    const { data: txs } = await supabase.from('transacoes')
      .select('id, valor, observacao, data, carteira_nome, created_at').in('id', ids);
    if (!txs || txs.length < 2) {
      await removerPendente(pendente.id);
      await enviarTexto(phone, '🔍 Esses lançamentos já não estão mais repetidos — alguém resolveu antes de mim.');
      return true;
    }

    // Mantém o MAIS ANTIGO (foi o primeiro a entrar) e propõe apagar o resto.
    txs.sort((a, b) => String(a.created_at || a.data).localeCompare(String(b.created_at || b.data)));
    const manter = txs[0];
    const apagar = txs.slice(1);

    await criarPendente({
      userId: pendente.user_id,
      tipoPergunta: 'confirmar_exclusao_dup',
      contexto: { apagar: apagar.map((x) => x.id), manter: manter.id, rotulo: grupos[idx].rotulo },
    });

    const desc = apagar.map((x) => `• ${brl(x.valor)} de ${dia(x.data)} (${x.carteira_nome})`).join('\n');
    await enviarTexto(phone,
      `Vou apagar ${apagar.length === 1 ? 'esta cópia' : 'estas cópias'}:\n\n${desc}\n\n`
      + `E *mantenho* a de ${dia(manter.data)}, que entrou primeiro.\n\n`
      + `Confirma? Responda *sim* — ou *trocar* se preferir manter a outra.`);
    return true;
  }

  // ── Passo 3: confirmou ──────────────────────────────────────────────
  if (pendente.tipo_pergunta === 'confirmar_exclusao_dup') {
    const ctx = pendente.contexto || {};

    if (/^(nao|n|cancela|deixa|para)/.test(t)) {
      await removerPendente(pendente.id);
      await enviarTexto(phone, 'Beleza, não apaguei nada. 🕵️');
      return true;
    }

    // "trocar" = manter a nova e apagar a antiga (a escolha é do usuário).
    let alvos = ctx.apagar || [];
    if (/^(troca|inverte|a outra|a mais nova|a nova)/.test(t)) {
      alvos = [ctx.manter];
    } else if (!/^(sim|s|isso|pode|confirma|ok|apaga|manda)/.test(t)) {
      return false;                             // resposta não relacionada
    }

    let apagadas = 0;
    for (const id of alvos) {
      const { error } = await supabase.from('transacoes').delete().eq('id', id);
      if (!error) apagadas++;
    }
    await removerPendente(pendente.id);

    await enviarTexto(phone, apagadas
      ? `✅ Pronto — ${apagadas === 1 ? 'a cópia foi removida' : `${apagadas} cópias removidas`}. `
        + `Caso encerrado. 🕵️`
      : 'Não consegui apagar agora. Tente pelo painel, no meu card.');
    return true;
  }

  return false;
}

module.exports = { ehPedidoDuplicadas, responderDuplicadas, resolverDuplicada, pediuFatura };
