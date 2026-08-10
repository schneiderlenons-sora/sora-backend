// =============================================================================
// Alerta de limite de gasto — geral (users.meta_mensal) e por categoria
// (category_limits).
//
// POR QUE VIROU SERVIÇO: a verificação morava dentro do handler do WhatsApp, e
// por isso só disparava pra gasto lançado PELO ZAP. Quem lança pelo painel ou
// importa pelo Open Finance — hoje a maioria — nunca recebia aviso nenhum. O
// limite existia e ficava mudo justamente pra quem mais gasta.
//
// Chamadores: handlers/transacoes (zap), routes/transacoes (painel) e o sync do
// Open Finance. Uma implementação só: se a regra mudar, muda pra todos.
//
// DEDUP: `category_limits.alerta_enviado` e `users.meta_mensal_alerta_enviado`
// garantem UM aviso por limite por mês. É o que segura o sync do Open Finance,
// que importa dezenas de transações de uma vez — sem isso o usuário levaria uma
// enxurrada de alertas do mesmo limite.
// =============================================================================
const supabase = require('../db/supabase');
const { enviarProativo } = require('../services/proativo');

// Nome de categoria pra comparação: sem emoji, sem acento, minúsculo.
function limpaCat(s) {
  return (s || '').replace(/\p{Extended_Pictographic}/gu, '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// ── Template `limite_atingido` ───────────────────────────────────────────────
//
// APROVADO na Meta em 31/07/2026 · categoria UTILIDADE · pt_BR.
// A saudação aprovada é "Eaí, {{1}}!" (não "Oi") — o corpo é do template, o
// código só manda os 5 parâmetros:
//   {{1}} primeiro nome · {{2}} alvo do limite · {{3}} percentual
//   {{4}} gasto · {{5}} teto
//
// Categoria UTILIDADE porque é aviso sobre a conta do próprio usuário, com os
// números dele, disparado por um gasto que ele registrou — não vende nada.
//
// ⚠️ Mexeu no modelo lá? Confira a QUANTIDADE de variáveis. Mandar 5 num corpo
// com 4 dá erro 132000 e o alerta some sem log de negócio.
// ⚠️ Nenhum parâmetro pode ter \n, tab ou 4+ espaços seguidos: a Cloud API
// recusa. As quebras estão no corpo FIXO do modelo.
const TPL_LIMITE_NOME = process.env.WHATSAPP_TPL_LIMITE || 'limite_atingido';

// O rótulo do limite geral precisa ler bem depois de "seu limite de ___":
// "de gasto geral" soa certo, "de geral" não.
const ALVO_GERAL = 'gasto geral';

// Com separador de milhar: "R$ 1.234,50". Sem ele, um teto de R$ 1234,50 lia
// como valor menor de relance — e o alerta existe pra dar o susto certo.
//
// ⚠️ O "R$ " é concatenado À MÃO de propósito. Com `style: 'currency'` o Intl
// insere um espaço NÃO SEPARÁVEL (U+00A0) entre símbolo e número, e caractere
// invisível dentro de parâmetro de template é risco que só aparece em produção.
const brl = (v) => 'R$ ' + new Intl.NumberFormat('pt-BR',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v) || 0);

function templateLimite(nome, alvo, pct, gasto, teto) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || 'tudo bem';
  return {
    name: TPL_LIMITE_NOME,
    params: [
      primeiro.slice(0, 60),
      String(alvo || ALVO_GERAL).slice(0, 60),
      // `Math.round(NaN)` é NaN e sairia "NaN%" na cara do cliente — um teto
      // zerado ou um valor sujo bastam pra chegar aqui.
      `${Number.isFinite(Number(pct)) ? Math.round(Number(pct)) : 0}%`,
      brl(gasto),
      brl(teto),
    ],
    // Sem cabeçalho de imagem: é aviso rápido, não peça de marketing — header
    // de mídia atrasa o envio e exigiria a capa em toda chamada.
    opts: {},
  };
}

/**
 * Avisa TODOS os membros do grupo. Em gestão compartilhada o alerta não pode ir
 * só pra quem lançou — e quem NÃO lançou está fora da janela de 24h, onde texto
 * livre falha calado. Por isso vai template, com fallback de texto.
 */
async function avisarGrupo(grupoId, fallbackPhone, msg, template) {
  let membros = [];
  try {
    // Só membros com avisos ligados (kill-switch users.avisos_ativos).
    const { data } = await supabase.from('grupo_membros')
      .select('users(phone, name, avisos_ativos)').eq('grupo_id', grupoId);
    membros = (data || [])
      .filter((m) => m.users?.phone && m.users.avisos_ativos !== false)
      .map((m) => ({ phone: m.users.phone, nome: m.users.name }));
  } catch {
    // Pré-migration 055 (sem a coluna) → cai pro comportamento antigo.
    try {
      const { data } = await supabase.from('grupo_membros').select('users(phone, name)').eq('grupo_id', grupoId);
      membros = (data || []).filter((m) => m.users?.phone).map((m) => ({ phone: m.users.phone, nome: m.users.name }));
    } catch { /* tolerante */ }
  }

  const vistos = new Set();
  const destinos = membros.filter((m) => !vistos.has(m.phone) && vistos.add(m.phone));
  if (!destinos.length && fallbackPhone) destinos.push({ phone: fallbackPhone, nome: null });

  // Estourar o teto é o aviso mais característico do Don Baleone — o
  // "mafioso" que puxa a orelha. Com AGENTES_VOZ desligado, `falar` devolve o
  // texto original intacto (ver src/agentes).
  const { falar } = require('../agentes');

  for (const d of destinos) {
    try {
      const vestida = falar('don-baleone', 'limite', { texto: msg, seed: d.phone });
      await enviarProativo(d.phone, {
        texto: vestida.texto,
        template: typeof template === 'function' ? template(d.nome) : template,
      });
    } catch { /* um destino que falha não pode parar os outros */ }
  }
}

/**
 * Verifica os limites do grupo e dispara os alertas pendentes.
 *
 * @param {string} grupoId
 * @param {string} [phone]  fallback de destino (quando o grupo não tem membros)
 * @param {object} [user]   linha de users já carregada (evita uma query)
 */
async function verificarLimite(grupoId, phone, user) {
  if (!grupoId) return;

  const mesRef = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
  // Primeiro dia do mês seguinte (limite exclusivo) — evita `${mes}-31`
  // inválido em meses de 30/28 dias.
  const [ano, mes] = mesRef.split('-').map(Number);
  const prox = new Date(ano, mes, 1);
  const fimMes = `${prox.getFullYear()}-${String(prox.getMonth() + 1).padStart(2, '0')}-01`;

  // Gastos do mês do grupo — usado pelos dois tipos de limite.
  const { data: gastos } = await supabase
    .from('transacoes').select('valor, categoria')
    .eq('grupo_id', grupoId).eq('tipo', 'Gasto')
    .gte('data', `${mesRef}-01`).lt('data', fimMes);

  // ── Limites POR CATEGORIA (subcategoria conta pro pai) ─────────────────────
  const { data: limites } = await supabase
    .from('category_limits').select('*')
    .eq('grupo_id', grupoId).eq('mes_referencia', mesRef);

  if (limites?.length) {
    const { data: cats } = await supabase
      .from('categorias').select('id, nome, parent_id').eq('grupo_id', grupoId);

    for (const limite of limites) {
      if (limite.ativo === false || !limite.limite_mensal || limite.alerta_enviado) continue;

      const chave = limpaCat(limite.categoria);
      const nomes = new Set([chave]);
      const cat = (cats || []).find((c) => limpaCat(c.nome) === chave);
      if (cat) (cats || []).filter((c) => c.parent_id === cat.id).forEach((c) => nomes.add(limpaCat(c.nome)));

      const total = (gastos || [])
        .filter((g) => nomes.has(limpaCat(g.categoria)))
        .reduce((s, g) => s + (g.valor || 0), 0);

      const pct = (total / limite.limite_mensal) * 100;
      if (pct >= (limite.percentual_alerta || 80)) {
        const alvo = String(limite.categoria || '').replace(/\p{Extended_Pictographic}/gu, '').trim();
        await avisarGrupo(grupoId, phone,
          `⚠️ *Limite de ${limite.categoria}*: os gastos chegaram a *${pct.toFixed(0)}%* do teto do mês.\n` +
          `Teto: ${brl(limite.limite_mensal)} | Gasto atual: ${brl(total)}`,
          (nome) => templateLimite(nome, alvo, pct, total, limite.limite_mensal));

        await supabase.from('category_limits')
          .update({ alerta_enviado: true }).eq('id', limite.id);
      }
    }
  }

  await verificarLimiteGeral(grupoId, phone, user, mesRef, gastos || []);
}

/** Alerta quando o gasto TOTAL do mês atinge o % da meta mensal. */
async function verificarLimiteGeral(grupoId, phone, user, mesRef, gastos) {
  let u = user;
  if (!u || u.meta_mensal === undefined) {
    const { data } = await supabase.from('users')
      .select('meta_mensal, meta_mensal_ativo, meta_mensal_alerta_ativo, meta_mensal_alerta_pct, meta_mensal_alerta_enviado, phone')
      .eq('grupo_ativo', grupoId).limit(1).maybeSingle();
    u = data;
  }
  if (!u) return;

  const meta = u.meta_mensal || 0;
  const ativo = u.meta_mensal_ativo ?? true;
  const alertaAtivo = u.meta_mensal_alerta_ativo ?? true;
  const pctAlerta = u.meta_mensal_alerta_pct ?? 80;
  if (!meta || !ativo || !alertaAtivo) return;
  if (u.meta_mensal_alerta_enviado === mesRef) return; // já avisou este mês

  const total = (gastos || []).reduce((s, g) => s + (g.valor || 0), 0);
  const pct = (total / meta) * 100;
  if (pct < pctAlerta) return;

  await avisarGrupo(grupoId, phone,
    `🚨 *Limite geral do mês*: os gastos chegaram a *${pct.toFixed(0)}%* da meta.\n` +
    `Meta: ${brl(meta)} | Gasto total: ${brl(total)}`,
    (nome) => templateLimite(nome, ALVO_GERAL, pct, total, meta));

  // Marca como avisado neste mês (defensivo: coluna pode não existir ainda).
  try {
    await supabase.from('users')
      .update({ meta_mensal_alerta_enviado: mesRef })
      .eq('phone', u.phone || String(phone || '').replace(/\D/g, ''));
  } catch (e) { console.warn('[limite geral] flag alerta:', e.message); }
}

/**
 * Versão à prova de erro pros caminhos de ESCRITA (painel e sync do Open
 * Finance): o alerta é um efeito colateral e nunca pode derrubar o lançamento
 * nem atrasar a resposta da API.
 */
function verificarLimiteEmBackground(grupoId, phone, user) {
  setImmediate(() => {
    verificarLimite(grupoId, phone, user)
      .catch((e) => console.error('[limites] alerta falhou:', e && e.message));
  });
}

module.exports = {
  verificarLimite, verificarLimiteEmBackground, avisarGrupo,
  templateLimite, ALVO_GERAL, limpaCat,
};
