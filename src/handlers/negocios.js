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

/**
 * KIWIFY — webhook v1 (https://docs.kiwify.com.br/webhooks)
 * Eventos: order_approved, order_refunded, order_chargeback, subscription_canceled
 */
function normalizarKiwify(payload) {
  const event = payload?.webhook_event_type || payload?.order_status;
  if (!event) return null;

  const MAP = {
    order_approved:        'venda',
    order_refunded:        'reembolso',
    order_chargedback:     'chargeback',
    order_chargeback:      'chargeback',
    subscription_canceled: 'assinatura_cancelamento',
    subscription_renewed:  'assinatura_renovacao',
  };
  const tipo = MAP[event];
  if (!tipo) return null;

  const order   = payload?.order || payload;
  const product = payload?.product || order?.product || {};
  const customer = payload?.customer || order?.customer || {};
  const sub     = payload?.subscription;

  const refExterna = String(order?.order_id || order?.id || payload?.id || '');
  if (!refExterna) return null;

  const valorBruto      = r$(order?.total_price || order?.price || 0);
  const taxaPlataforma  = r$(order?.commissions?.kiwify_fee || order?.kiwify_commission || 0);
  const comissaoAfil    = r$(order?.commissions?.affiliate_fee || 0);

  const valorLiquido = (tipo === 'reembolso' || tipo === 'chargeback')
    ? -valorBruto
    : (valorBruto - taxaPlataforma - comissaoAfil);

  return {
    ref_externa:        refExterna,
    tipo,
    produto_id_externo: product?.product_id ? String(product.product_id) : null,
    produto_nome:       product?.product_name || product?.name || 'Produto Kiwify',
    oferta:             order?.offer_code || null,
    valor_bruto:        valorBruto,
    taxa_plataforma:    taxaPlataforma,
    taxa_gateway:       0,
    imposto:            0,
    valor_liquido:      valorLiquido,
    moeda:              order?.currency || 'BRL',
    comprador_nome:     customer?.full_name || customer?.first_name || null,
    comprador_email:    customer?.email || null,
    comprador_doc:      customer?.CPF || customer?.CNPJ || null,
    afiliado_nome:      order?.affiliate_name || null,
    comissao_afiliado:  comissaoAfil,
    recorrencia:        sub ? 'mensal' : 'avulsa',
    assinatura_id:      sub?.id || null,
    status:             tipo === 'reembolso' || tipo === 'chargeback' ? 'estornado'
                      : tipo === 'assinatura_cancelamento' ? 'cancelado'
                      : 'aprovado',
    data_evento:        new Date(order?.approved_date || order?.created_at || Date.now()).toISOString(),
    metadata:           { event, payment_method: order?.payment_method },
  };
}

/**
 * EDUZZ — webhook v2 (https://api.eduzz.com/documentacao/api-eduzz/notificacoes-webhook)
 * Status: 3=aprovado, 9=cancelado, 10=reembolso, 11=chargeback
 */
function normalizarEduzz(payload) {
  const status = payload?.trans_status || payload?.status;
  const MAP = { 3: 'venda', 9: 'assinatura_cancelamento', 10: 'reembolso', 11: 'chargeback' };
  const tipo = MAP[status];
  if (!tipo) return null;

  const refExterna = String(payload?.trans_cod || payload?.id || '');
  if (!refExterna) return null;

  const valorBruto = r$(payload?.trans_value || payload?.value || 0);
  const taxaPlat   = r$(payload?.trans_eduzz_amount || 0);
  const comissao   = r$(payload?.trans_affiliate_amount || 0);
  const valorLiq   = (tipo === 'reembolso' || tipo === 'chargeback')
    ? -valorBruto
    : (valorBruto - taxaPlat - comissao);

  return {
    ref_externa:        refExterna,
    tipo,
    produto_id_externo: payload?.product_cod ? String(payload.product_cod) : null,
    produto_nome:       payload?.product_name || 'Produto Eduzz',
    valor_bruto:        valorBruto,
    taxa_plataforma:    taxaPlat,
    taxa_gateway:       0,
    imposto:            0,
    valor_liquido:      valorLiq,
    moeda:              'BRL',
    comprador_nome:     payload?.cli_name || null,
    comprador_email:    payload?.cli_email || null,
    comprador_doc:      payload?.cli_document || null,
    afiliado_nome:      payload?.affiliate_name || null,
    comissao_afiliado:  comissao,
    recorrencia:        payload?.recurrence ? 'mensal' : 'avulsa',
    assinatura_id:      payload?.subscription_id || null,
    status:             tipo === 'reembolso' || tipo === 'chargeback' ? 'estornado'
                      : tipo === 'assinatura_cancelamento' ? 'cancelado'
                      : 'aprovado',
    data_evento:        new Date(payload?.trans_createdate || payload?.created_at || Date.now()).toISOString(),
    metadata:           { status },
  };
}

/**
 * STRIPE — webhook events (charge.succeeded, charge.refunded, etc.)
 * Stripe trabalha em centavos por padrão (amount, application_fee_amount).
 */
function normalizarStripe(payload) {
  const event = payload?.type;
  if (!event) return null;

  const MAP = {
    'charge.succeeded':            'venda',
    'payment_intent.succeeded':    'venda',
    'invoice.payment_succeeded':   'assinatura_renovacao',
    'charge.refunded':             'reembolso',
    'charge.dispute.created':      'chargeback',
    'customer.subscription.deleted': 'assinatura_cancelamento',
  };
  const tipo = MAP[event];
  if (!tipo) return null;

  const obj = payload?.data?.object || {};
  const refExterna = String(obj.id || payload.id || '');
  if (!refExterna) return null;

  // Stripe já vem em centavos
  const valorBruto      = obj.amount || obj.amount_paid || obj.amount_received || 0;
  const taxaGateway     = obj.application_fee_amount || obj.balance_transaction?.fee || 0;

  const valorLiquido = (tipo === 'reembolso' || tipo === 'chargeback')
    ? -valorBruto
    : (valorBruto - taxaGateway);

  return {
    ref_externa:        refExterna,
    tipo,
    produto_id_externo: obj.metadata?.product_id || null,
    produto_nome:       obj.description || obj.metadata?.product_name || 'Pagamento Stripe',
    valor_bruto:        valorBruto,
    taxa_plataforma:    0,
    taxa_gateway:       taxaGateway,
    imposto:            0,
    valor_liquido:      valorLiquido,
    moeda:              (obj.currency || 'brl').toUpperCase(),
    comprador_nome:     obj.billing_details?.name || obj.customer_name || null,
    comprador_email:    obj.billing_details?.email || obj.customer_email || obj.receipt_email || null,
    afiliado_nome:      null,
    comissao_afiliado:  0,
    recorrencia:        obj.subscription ? 'mensal' : 'avulsa',
    assinatura_id:      obj.subscription || null,
    status:             tipo === 'reembolso' || tipo === 'chargeback' ? 'estornado'
                      : tipo === 'assinatura_cancelamento' ? 'cancelado'
                      : 'aprovado',
    data_evento:        new Date((obj.created || payload.created || Date.now() / 1000) * 1000).toISOString(),
    metadata:           { event, payment_method: obj.payment_method_details?.type },
  };
}

const ADAPTERS = {
  hotmart: normalizarHotmart,
  kiwify:  normalizarKiwify,
  eduzz:   normalizarEduzz,
  stripe:  normalizarStripe,
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
// DRE POR EMPRESA (fase 5). Antes era por usuário — com multi-empresa isso
// somaria negócios diferentes no mesmo demonstrativo. Agora também UNIFICA as
// duas naturezas: eventos das integrações (digital) + livro caixa (físico).
async function gerarDre(userId, grupoId, periodo, empresaId) {
  const inicio = periodo; // 'YYYY-MM-01'
  const fimDate = new Date(inicio);
  fimDate.setMonth(fimDate.getMonth() + 1);
  const fim = fimDate.toISOString().slice(0, 10);

  // Empresa alvo — sem empresa não existe DRE. Sem o parâmetro, cai na
  // primeira empresa ativa do usuário (compat com chamadas antigas).
  let empId = empresaId;
  if (!empId) {
    const { data: emp } = await supabase.from('empresas')
      .select('id').eq('user_id', userId).eq('ativa', true)
      .order('created_at', { ascending: true }).limit(1).maybeSingle();
    empId = emp?.id || null;
  }
  if (!empId) return null;

  // 1. Eventos das integrações (negócio DIGITAL)
  const { data: eventos, error: errEv } = await supabase
    .from('eventos_financeiros')
    .select('*')
    .eq('empresa_id', empId)
    .gte('data_evento', inicio)
    .lt('data_evento', fim);
  if (errEv) throw errEv;

  // 2. Custos (negócio digital)
  const { data: custos, error: errC } = await supabase
    .from('custos_negocio')
    .select('*')
    .eq('empresa_id', empId)
    .gte('data', inicio)
    .lt('data', fim);
  if (errC) throw errC;

  // 2b. LIVRO CAIXA (negócio FÍSICO): entrada vira receita, saída vira custo.
  //     Só o que está PAGO entra — conta a pagar em aberto não é resultado
  //     realizado. Tolerante: se a 091 não rodou, o DRE segue sem o caixa.
  let lancamentos = [];
  try {
    const { data } = await supabase
      .from('lancamentos_negocio')
      .select('tipo, categoria, valor')
      .eq('empresa_id', empId)
      .eq('status', 'pago')
      .gte('data', inicio).lt('data', fim);
    lancamentos = data || [];
  } catch { /* sem livro caixa ainda */ }

  // 3. Config tributária — por EMPRESA (a PK mudou na migration 090)
  const { data: cfg } = await supabase
    .from('config_negocio').select('*').eq('empresa_id', empId).maybeSingle();
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

  // CAIXA (loja física): entradas somam na receita bruta ANTES do cálculo de
  // taxas/imposto (venda de balcão não tem taxa de plataforma, então as taxas
  // continuam zero pra essa parte); saídas viram custo por categoria.
  let custos_caixa = 0;
  const custos_caixa_cat = {};
  for (const l of lancamentos) {
    if (l.tipo === 'entrada') {
      receita_bruta += l.valor;
      total_vendas  += 1;
    } else {
      custos_caixa += l.valor;
      const k = l.categoria || 'outros';
      custos_caixa_cat[k] = (custos_caixa_cat[k] || 0) + l.valor;
    }
  }

  // Imposto: o que já foi retido + reserva manual sobre receita líquida
  const receita_apos_taxas = receita_bruta - taxas_plataforma - taxas_gateway - reembolsos - chargebacks - comissoes_afiliado;
  const imposto_reserva    = reservarImposto ? Math.round(receita_apos_taxas * (aliquota / 100)) : 0;
  const impostos_total     = imposto_ja_retido + imposto_reserva;
  const receita_liquida    = receita_apos_taxas - imposto_reserva;

  // Custos = custos do digital + saídas do caixa (físico)
  const custos_total = (custos || []).reduce((s, c) => s + c.valor, 0) + custos_caixa;
  const custos_por_categoria = {};
  for (const c of custos || []) {
    custos_por_categoria[c.categoria] = (custos_por_categoria[c.categoria] || 0) + c.valor;
  }
  for (const [k, v] of Object.entries(custos_caixa_cat)) {
    custos_por_categoria[k] = (custos_por_categoria[k] || 0) + v;
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
    empresa_id: empId,
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
    // ⚠️ A unicidade virou (empresa_id, periodo) na migration 090 — com
    // multi-empresa, duas empresas do mesmo dono colidiam no mesmo mês.
    // Manter 'user_id,periodo' aqui quebra o upsert (constraint inexistente).
    .upsert(snapshot, { onConflict: 'empresa_id,periodo' })
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
