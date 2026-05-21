/**
 * Handler de Negócios — adapters de plataforma, DRE engine, conciliação.
 * Estrutura escalável: adicionar nova plataforma = novo case no normalizar*.
 */
const supabase = require('../db/supabase');

// Centavos util
const r$ = (reais) => Math.round((parseFloat(reais) || 0) * 100);

// ─────────────────────────────────────────────────────────────────
// ADAPTERS — convertem payload da plataforma → EventoFinanceiro
// ─────────────────────────────────────────────────────────────────

/**
 * HOTMART — webhook v2 (https://developers.hotmart.com/docs/pt-BR/v2/webhooks)
 * Eventos principais:
 *  - PURCHASE_APPROVED → venda
 *  - PURCHASE_REFUNDED → reembolso
 *  - PURCHASE_CHARGEBACK → chargeback
 *  - SUBSCRIPTION_CANCELLATION → assinatura_cancelamento
 *  - PURCHASE_BILLET_PRINTED / PURCHASE_PROTEST → ignorados
 */
function normalizarHotmart(payload) {
  const event = payload?.event || payload?.id || payload?.eventType;
  const data  = payload?.data || payload;
  if (!event) return null;

  // Mapeia evento → tipo
  const MAP_EVENTO = {
    PURCHASE_APPROVED:         'venda',
    PURCHASE_COMPLETE:         'venda',
    PURCHASE_REFUNDED:         'reembolso',
    PURCHASE_CHARGEBACK:       'chargeback',
    SUBSCRIPTION_CANCELLATION: 'assinatura_cancelamento',
    SUBSCRIPTION_RESTARTED:    'assinatura_renovacao',
    PURCHASE_EXPIRED:          null,
    PURCHASE_BILLET_PRINTED:   null,
    PURCHASE_PROTEST:          null,
  };
  const tipo = MAP_EVENTO[event];
  if (!tipo) return null; // evento sem impacto financeiro

  const purchase = data?.purchase || data;
  const product  = data?.product  || purchase?.product || {};
  const buyer    = data?.buyer    || purchase?.buyer   || {};
  const aff      = data?.affiliates?.[0] || data?.commissions?.find(c => c?.source === 'AFFILIATE');
  const sub      = data?.subscription;

  const refExterna = String(purchase?.transaction || purchase?.id || payload?.id || '');
  if (!refExterna) return null;

  const valorBruto      = r$(purchase?.price?.value ?? purchase?.full_price?.value ?? purchase?.original_offer_price?.value);
  const taxaPlataforma  = r$(data?.commissions?.find(c => c?.source === 'PRODUCER')?.fee ?? purchase?.commission?.value);
  const taxaGateway     = r$(purchase?.payment?.fees ?? 0);
  const comissaoAfil    = r$(aff?.value ?? aff?.commission?.value ?? 0);
  // Hotmart já retém imposto em alguns casos
  const imposto         = r$(purchase?.tax?.value ?? 0);

  const valorLiquido    = tipo === 'reembolso' || tipo === 'chargeback'
    ? -valorBruto
    : (valorBruto - taxaPlataforma - taxaGateway - imposto - comissaoAfil);

  return {
    ref_externa:        refExterna,
    tipo,
    produto_id_externo: product?.id ? String(product.id) : null,
    produto_nome:       product?.name || product?.ucode || 'Produto Hotmart',
    oferta:             purchase?.offer?.code || null,
    valor_bruto:        valorBruto,
    taxa_plataforma:    taxaPlataforma,
    taxa_gateway:       taxaGateway,
    imposto,
    valor_liquido:      valorLiquido,
    moeda:              purchase?.price?.currency_value || 'BRL',
    comprador_nome:     buyer?.name || null,
    comprador_email:    buyer?.email || null,
    comprador_doc:      buyer?.document || null,
    afiliado_nome:      aff?.name || aff?.affiliate?.name || null,
    comissao_afiliado:  comissaoAfil,
    recorrencia:        sub?.plan?.recurrency_period === 'MONTHLY' ? 'mensal'
                      : sub?.plan?.recurrency_period === 'YEARLY'  ? 'anual'
                      : sub ? 'mensal' : 'avulsa',
    assinatura_id:      sub?.subscriber?.code || sub?.subscription_id || null,
    status:             tipo === 'reembolso' ? 'estornado'
                      : tipo === 'chargeback' ? 'estornado'
                      : tipo === 'assinatura_cancelamento' ? 'cancelado'
                      : 'aprovado',
    data_evento:        new Date(purchase?.approved_date || purchase?.order_date || purchase?.creation_date || Date.now()).toISOString(),
    metadata:           { event, raw_status: purchase?.status, payment_type: purchase?.payment?.type },
  };
}

const ADAPTERS = {
  hotmart: normalizarHotmart,
  // futuro: stripe, kiwify, mercadopago...
};

// ─────────────────────────────────────────────────────────────────
// INGESTÃO — salva evento normalizado em eventos_financeiros
// ─────────────────────────────────────────────────────────────────

/**
 * Recebe um payload bruto + integracao já carregada e persiste o evento.
 * Idempotente via unique(integracao_id, ref_externa).
 */
async function ingerirEvento(integracao, payload) {
  const adapter = ADAPTERS[integracao.plataforma];
  if (!adapter) throw new Error(`Sem adapter para plataforma: ${integracao.plataforma}`);

  const normalizado = adapter(payload);
  if (!normalizado) return { ignorado: true, motivo: 'evento sem impacto financeiro' };

  const row = {
    user_id:       integracao.user_id,
    grupo_id:      integracao.grupo_id,
    integracao_id: integracao.id,
    plataforma:    integracao.plataforma,
    ...normalizado,
  };

  const { data, error } = await supabase
    .from('eventos_financeiros')
    .upsert(row, { onConflict: 'integracao_id,ref_externa', ignoreDuplicates: false })
    .select()
    .maybeSingle();

  if (error) throw error;

  // Atualiza contadores na integração
  await supabase.from('integracoes')
    .update({ ultimo_sync: new Date().toISOString(), total_eventos: (integracao.total_eventos || 0) + 1 })
    .eq('id', integracao.id);

  // Invalida snapshot do mês
  const mes = data.data_evento.slice(0, 7) + '-01';
  await supabase.from('dre_snapshots').delete().eq('user_id', integracao.user_id).eq('periodo', mes);

  return { ok: true, evento_id: data.id, tipo: data.tipo };
}

// ─────────────────────────────────────────────────────────────────
// DRE ENGINE — gera/recalcula snapshot de um mês
// ─────────────────────────────────────────────────────────────────

/**
 * Calcula o DRE de um período (mês) para o user e cacheia em dre_snapshots.
 * periodo: 'YYYY-MM-01'
 */
async function gerarDre(userId, grupoId, periodo) {
  const inicio = periodo; // 'YYYY-MM-01'
  const fimDate = new Date(inicio);
  fimDate.setMonth(fimDate.getMonth() + 1);
  const fim = fimDate.toISOString().slice(0, 10);

  // 1. Carrega eventos do período
  const { data: eventos, error: errEv } = await supabase
    .from('eventos_financeiros')
    .select('*')
    .eq('user_id', userId)
    .gte('data_evento', inicio)
    .lt('data_evento', fim);
  if (errEv) throw errEv;

  // 2. Carrega custos do período
  const { data: custos, error: errC } = await supabase
    .from('custos_negocio')
    .select('*')
    .eq('user_id', userId)
    .gte('data', inicio)
    .lt('data', fim);
  if (errC) throw errC;

  // 3. Config tributária
  const { data: cfg } = await supabase
    .from('config_negocio').select('*').eq('user_id', userId).maybeSingle();
  const aliquota = cfg?.aliquota_simples ?? 6.0;
  const reservarImposto = cfg?.reservar_imposto ?? true;

  // 4. Agrega
  let receita_bruta = 0, taxas_plataforma = 0, taxas_gateway = 0,
      reembolsos = 0, chargebacks = 0, comissoes_afiliado = 0, imposto_ja_retido = 0;
  let total_vendas = 0;

  const porPlat = {}; // { plataforma: { valor, vendas } }
  const porProd = {};

  for (const e of eventos || []) {
    if (e.tipo === 'venda' || e.tipo === 'assinatura_renovacao') {
      receita_bruta     += e.valor_bruto;
      taxas_plataforma  += e.taxa_plataforma;
      taxas_gateway     += e.taxa_gateway;
      imposto_ja_retido += e.imposto;
      comissoes_afiliado+= e.comissao_afiliado || 0;
      total_vendas += 1;
      porPlat[e.plataforma] = porPlat[e.plataforma] || { valor: 0, vendas: 0 };
      porPlat[e.plataforma].valor  += e.valor_liquido;
      porPlat[e.plataforma].vendas += 1;
      const k = e.produto_nome || 'Sem nome';
      porProd[k] = porProd[k] || { valor: 0, vendas: 0 };
      porProd[k].valor  += e.valor_liquido;
      porProd[k].vendas += 1;
    } else if (e.tipo === 'reembolso') {
      reembolsos += e.valor_bruto;
    } else if (e.tipo === 'chargeback') {
      chargebacks += e.valor_bruto;
    }
  }

  // Imposto: o que já foi retido + reserva manual sobre receita líquida
  const receita_apos_taxas = receita_bruta - taxas_plataforma - taxas_gateway - reembolsos - chargebacks - comissoes_afiliado;
  const imposto_reserva    = reservarImposto ? Math.round(receita_apos_taxas * (aliquota / 100)) : 0;
  const impostos_total     = imposto_ja_retido + imposto_reserva;
  const receita_liquida    = receita_apos_taxas - imposto_reserva;

  // Custos
  const custos_total = (custos || []).reduce((s, c) => s + c.valor, 0);
  const custos_por_categoria = {};
  for (const c of custos || []) {
    custos_por_categoria[c.categoria] = (custos_por_categoria[c.categoria] || 0) + c.valor;
  }

  const lucro_liquido = receita_liquida - custos_total;
  const margem_pct = receita_bruta > 0 ? (lucro_liquido / receita_bruta) * 100 : 0;
  const ticket_medio = total_vendas > 0 ? Math.round(receita_bruta / total_vendas) : 0;

  // MRR — soma de vendas recorrentes mensais
  const mrr = (eventos || [])
    .filter(e => (e.tipo === 'venda' || e.tipo === 'assinatura_renovacao') && e.recorrencia === 'mensal')
    .reduce((s, e) => s + e.valor_liquido, 0);

  const snapshot = {
    user_id: userId,
    grupo_id: grupoId,
    periodo: inicio,
    receita_bruta,
    taxas_plataforma,
    taxas_gateway,
    impostos: impostos_total,
    reembolsos,
    chargebacks,
    comissoes_afiliado,
    receita_liquida,
    custos_total,
    custos_por_categoria,
    lucro_liquido,
    margem_pct: Number(margem_pct.toFixed(2)),
    total_vendas,
    ticket_medio,
    mrr,
    arr: mrr * 12,
    churn_pct: 0, // Fase futura
    por_plataforma: Object.entries(porPlat)
      .map(([plataforma, v]) => ({ plataforma, ...v }))
      .sort((a, b) => b.valor - a.valor),
    por_produto: Object.entries(porProd)
      .map(([nome, v]) => ({ nome, ...v }))
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 10),
    gerado_em: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('dre_snapshots')
    .upsert(snapshot, { onConflict: 'user_id,periodo' })
    .select()
    .maybeSingle();
  if (error) throw error;

  return data;
}

// ─────────────────────────────────────────────────────────────────
// CONCILIAÇÃO — tenta linkar evento Hotmart à transação Sora Finance
// ─────────────────────────────────────────────────────────────────

/**
 * Sugere matches automáticos baseado em valor + data próxima (± 3 dias).
 * Retorna lista de pares { evento_id, transacao_id, confianca }.
 */
async function sugerirConciliacao(userId, grupoId) {
  const { data: eventos } = await supabase
    .from('eventos_financeiros')
    .select('id, valor_liquido, data_evento')
    .eq('user_id', userId)
    .eq('conciliado', false)
    .eq('status', 'aprovado')
    .gte('data_evento', new Date(Date.now() - 90 * 86400000).toISOString());

  const { data: transacoes } = await supabase
    .from('transacoes')
    .select('id, valor, data')
    .eq('grupo_id', grupoId)
    .eq('tipo', 'receita')
    .gte('data', new Date(Date.now() - 90 * 86400000).toISOString());

  const sugestoes = [];
  for (const ev of eventos || []) {
    const evValor = Math.round(ev.valor_liquido / 100); // reais
    const evData  = new Date(ev.data_evento);
    const candidato = (transacoes || []).find(t => {
      const tValor = Math.round(parseFloat(t.valor));
      const tData  = new Date(t.data);
      const diasDif = Math.abs((tData - evData) / 86400000);
      return tValor === evValor && diasDif <= 3;
    });
    if (candidato) {
      sugestoes.push({ evento_id: ev.id, transacao_id: candidato.id, confianca: 0.85 });
    }
  }
  return sugestoes;
}

module.exports = {
  ADAPTERS,
  ingerirEvento,
  gerarDre,
  sugerirConciliacao,
  normalizarHotmart,
};
