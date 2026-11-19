// ─────────────────────────────────────────────────────────────────────────────
// As ferramentas que o ChatGPT do cliente enxerga (fase 1: SÓ LEITURA).
//
// ⚠️ NENHUMA REGRA DE DINHEIRO NASCE AQUI. Cada ferramenta pede a MESMA rota
// que o painel usa (`ctx.get`, ver services/chamadaInterna.js) ou chama o
// serviço canônico (vencimento de dívida, conta do limite, o que entra no
// resumo). Este arquivo só ESCOLHE campos e os nomeia pro modelo entender —
// e tira o que ele não precisa ver (telefone de membro, ids internos do banco).
//
// Por que escolher campos: a resposta crua do painel tem dezenas de colunas
// técnicas. Mandar tudo gasta o contexto do ChatGPT do cliente e convida o
// modelo a interpretar o que não deveria (ex.: `of_bill_id`).
//
// `ctx` = { get(caminho) → { status, json }, hoje: 'AAAA-MM-DD', mesAtual, moeda }.
// ─────────────────────────────────────────────────────────────────────────────
const { proximoVencimento, parcelasEmAtraso } = require('./vencimentoDivida');
const { nomesDoLimite, limpaCat } = require('./limites');
const { ehTransferencia } = require('./resumoTransacoes');

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const r2 = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);

class ErroFerramenta extends Error {}

/** Resposta de uma rota interna → JSON, ou erro com frase pro cliente. */
async function pedir(ctx, caminho) {
  const { status, json } = await ctx.get(caminho);
  if (status >= 200 && status < 300) return json;
  if (status === 403) {
    throw new ErroFerramenta('Esta parte não está liberada no plano da conta, ou a pessoa não tem permissão de leitura neste grupo.');
  }
  if (status === 404) throw new ErroFerramenta('Não encontrei a conta da pessoa na ForSora (sem grupo ativo).');
  throw new ErroFerramenta('A ForSora não conseguiu ler esses dados agora. Tente de novo em instantes.');
}

/**
 * Data da transação no dia de São Paulo.
 * Mesma regra de `sora-frontend/lib/data-br.ts`: meia-noite UTC é DATA PURA
 * (o banco coage 'AAAA-MM-DD' assim); qualquer outra hora é instante real.
 */
function diaSP(v) {
  const s = String(v || '');
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/T00:00:00(?:\.0+)?(?:Z|\+00(?::?00)?)$/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(0, 10) : d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function mesDe(args, ctx) {
  const m = args && args.mes;
  if (m === undefined || m === null || m === '') return ctx.mesAtual;
  if (!MES.test(String(m))) throw new ErroFerramenta('Use o mês no formato AAAA-MM (ex.: 2026-11).');
  return String(m);
}

const PH = 'eu'; // o `:phone` da URL é sobrescrito pelo `auth` com o da própria pessoa

const LEITURA = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// ── As ferramentas ──────────────────────────────────────────────────────────
const FERRAMENTAS = [
  {
    name: 'resumo_do_mes',
    title: 'Resumo do mês',
    description: 'Receitas, despesas e resultado de um mês, com o total por categoria — os mesmos números do painel da ForSora. Transferências entre contas, pagamento de fatura e ajuste de saldo NÃO entram (não são ganho nem gasto). Valores na moeda da conta da pessoa.',
    inputSchema: {
      type: 'object',
      properties: { mes: { type: 'string', description: 'Mês no formato AAAA-MM. Padrão: o mês atual.' } },
      additionalProperties: false,
    },
    async executar(ctx, args) {
      const mes = mesDe(args, ctx);
      const r = await pedir(ctx, `/api/transacoes/${PH}/resumo?mes=${mes}`);
      const membros = (r.por_membro || []).map((m) => ({ nome: m.name, despesas: r2(m.gastos), receitas: r2(m.receitas) }));
      return {
        mes, moeda: ctx.moeda,
        receitas: r2(r.receitas), despesas: r2(r.gastos), resultado: r2(r.saldo),
        despesas_por_categoria: (r.por_categoria || []).slice(0, 60).map((c) => ({ categoria: c.categoria, total: r2(c.total) })),
        receitas_por_categoria: (r.por_categoria_receitas || []).slice(0, 30).map((c) => ({ categoria: c.categoria, total: r2(c.total) })),
        // Só faz sentido em gestão compartilhada (mais de uma pessoa lançando).
        ...(membros.length > 1 ? { por_pessoa: membros } : {}),
      };
    },
  },
  {
    name: 'resumo_do_ano',
    title: 'Resumo do ano',
    description: 'Receitas e despesas de cada um dos 12 meses de um ano, com a mesma regra do resumo do mês. Bom para comparar meses e ver tendência.',
    inputSchema: {
      type: 'object',
      properties: { ano: { type: 'integer', minimum: 2000, maximum: 2100, description: 'Ano com 4 dígitos. Padrão: o ano atual.' } },
      additionalProperties: false,
    },
    async executar(ctx, args) {
      const ano = Number.isInteger(args?.ano) ? args.ano : Number(ctx.hoje.slice(0, 4));
      const r = await pedir(ctx, `/api/transacoes/${PH}/anual?ano=${ano}`);
      return {
        ano, moeda: ctx.moeda,
        receitas: r2(r.receitas), despesas: r2(r.gastos),
        meses: (r.meses || []).map((m) => ({
          mes: m.mes, receitas: r2(m.receitas), despesas: r2(m.gastos),
          resultado: r2((Number(m.receitas) || 0) - (Number(m.gastos) || 0)),
        })),
      };
    },
  },
  {
    name: 'listar_transacoes',
    title: 'Transações',
    description: 'Lançamentos de um mês (data, descrição, valor, categoria, conta), do mais recente pro mais antigo. Dá pra filtrar por tipo, categoria, conta ou um trecho da descrição. `entra_no_resumo` = false marca transferência, pagamento de fatura e ajuste de saldo, que não contam como receita nem despesa.',
    inputSchema: {
      type: 'object',
      properties: {
        mes: { type: 'string', description: 'Mês no formato AAAA-MM. Padrão: o mês atual.' },
        tipo: { type: 'string', enum: ['despesa', 'receita'], description: 'Só despesas ou só receitas.' },
        categoria: { type: 'string', description: 'Nome exato da categoria (veja a ferramenta `categorias`).' },
        conta: { type: 'string', description: 'Nome (ou parte do nome) da conta ou cartão.' },
        busca: { type: 'string', description: 'Trecho da descrição, ex.: "uber", "mercado".' },
        limite: { type: 'integer', minimum: 1, maximum: 300, description: 'Quantas no máximo. Padrão: 100.' },
      },
      additionalProperties: false,
    },
    async executar(ctx, args) {
      const mes = mesDe(args, ctx);
      const limite = Math.min(300, Math.max(1, Number.isInteger(args?.limite) ? args.limite : 100));
      const q = new URLSearchParams({ mes, limit: '500' });
      if (args?.tipo) q.set('tipo', args.tipo === 'receita' ? 'Recebimento' : 'Gasto');
      if (args?.categoria) q.set('categoria', String(args.categoria));
      const r = await pedir(ctx, `/api/transacoes/${PH}?${q}`);
      const norm = (s) => limpaCat(s);
      const conta = args?.conta ? norm(args.conta) : null;
      const busca = args?.busca ? norm(args.busca) : null;
      const filtradas = (r.transacoes || []).filter((t) =>
        (!conta || norm(t.carteira_nome).includes(conta))
        && (!busca || norm(t.observacao).includes(busca) || norm(t.categoria).includes(busca)));
      return {
        mes, moeda: ctx.moeda,
        total_no_mes: r.total ?? null,
        encontradas: filtradas.length,
        mostradas: Math.min(limite, filtradas.length),
        // A rota lê até 500 do mês: acima disso a busca pode não ter visto tudo.
        ...(Number(r.total) > 500 ? { aviso: 'O mês tem mais de 500 lançamentos; a busca olhou os 500 mais recentes.' } : {}),
        transacoes: filtradas.slice(0, limite).map((t) => ({
          data: diaSP(t.data),
          descricao: t.observacao || null,
          valor: r2(t.valor),
          tipo: t.tipo === 'Recebimento' ? 'receita' : 'despesa',
          categoria: t.categoria || null,
          conta: t.carteira_nome || null,
          pago: t.pago !== false,
          ...(Number(t.parcela_total) > 1 ? { parcela: `${t.parcela_num}/${t.parcela_total}` } : {}),
          entra_no_resumo: !ehTransferencia(t),
          ...(t.criador?.name ? { lancado_por: t.criador.name } : {}),
        })),
      };
    },
  },
  {
    name: 'contas_e_cartoes',
    title: 'Contas e cartões',
    description: 'As contas da pessoa com o saldo atual e os cartões de crédito com limite e dias de fechamento e vencimento. Contas ligadas ao banco (Open Finance) têm o saldo do próprio banco. Contas marcadas como da empresa ficam fora do saldo pessoal.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async executar(ctx) {
      const ws = await pedir(ctx, `/api/wallets/${PH}`) || [];
      const contas = ws.filter((w) => w.tipo !== 'Crédito');
      const pessoais = contas.filter((w) => !w.da_empresa);
      // Mesma soma do card "Saldo em contas" do Dashboard (ResumoCards):
      // contas pessoais, fora cartão, na moeda base. Sem câmbio → não soma.
      const semCambio = pessoais.filter((w) => w.saldo_base === null || w.saldo_base === undefined);
      return {
        moeda: ctx.moeda,
        saldo_total_pessoal: r2(pessoais.reduce((s, w) => s + (Number(w.saldo_base) || 0), 0)),
        ...(semCambio.length ? { aviso: `${semCambio.length} conta(s) em outra moeda ficaram fora do total (câmbio indisponível).` } : {}),
        contas: contas.map((w) => ({
          nome: w.nome, tipo: w.tipo,
          saldo: r2(w.saldo), moeda_da_conta: w.moeda || ctx.moeda,
          ...(w.moeda && w.moeda !== ctx.moeda ? { saldo_na_moeda_base: r2(w.saldo_base) } : {}),
          ligada_ao_banco: !!w.of_conta_id,
          da_empresa: !!w.da_empresa,
        })),
        cartoes: ws.filter((w) => w.tipo === 'Crédito').map((w) => ({
          nome: w.nome, limite: r2(w.limite), moeda: w.moeda || ctx.moeda,
          dia_fechamento: w.dia_fechamento ?? null, dia_vencimento: w.dia_vencimento ?? null,
          ligado_ao_banco: !!w.of_conta_id,
        })),
      };
    },
  },
  {
    name: 'faturas_dos_cartoes',
    title: 'Faturas dos cartões',
    description: 'A fatura de cada cartão pelo ciclo real de fechamento (o mesmo valor da aba Cartão de crédito): total, quanto já foi pago, quanto falta, vencimento e faturas atrasadas. `deslocamento` navega por faturas: 0 = a atual, 1 = a próxima, -1 = a anterior.',
    inputSchema: {
      type: 'object',
      properties: { deslocamento: { type: 'integer', minimum: -12, maximum: 12, description: 'Padrão: 0 (a fatura atual).' } },
      additionalProperties: false,
    },
    async executar(ctx, args) {
      const offset = Number.isInteger(args?.deslocamento) ? args.deslocamento : 0;
      const r = await pedir(ctx, `/api/wallets/faturas/${PH}?offset=${offset}`);
      return {
        deslocamento: offset,
        faturas: (r.faturas || []).map((f) => {
          // ⚠️ Mesma decisão do card do Dashboard (ResumoCards) e da aba de
          // cartões: fatura que já FECHOU e foi PAGA não é mais o número vivo —
          // o que a pessoa vê no painel é a seguinte.
          const pulaPraProxima = offset === 0 && f.fechada && f.quitada && f.proxima;
          return {
            cartao: f.nome, moeda: f.moeda || ctx.moeda,
            fatura: f.label || f.competencia,
            periodo: { de: f.ini, ate: f.fim },
            vencimento: f.venc,
            total: r2(f.fatura), pago: r2(f.pago), falta_pagar: r2(f.restante),
            quitada: !!f.quitada, fechada: !!f.fechada,
            ligado_ao_banco: !!f.of,
            ...(Number(f.total_previsto) > 0 ? { parcelas_previstas_pelo_banco: r2(f.total_previsto) } : {}),
            ...(Array.isArray(f.atrasadas) && f.atrasadas.length ? {
              atrasadas: f.atrasadas.map((a) => ({ fatura: a.label || a.competencia, vencimento: a.venc, falta_pagar: r2(a.restante) })),
            } : {}),
            ...(pulaPraProxima ? {
              valor_mostrado_no_painel: r2(f.proxima.restante),
              proxima: { fatura: f.proxima.label || f.proxima.competencia, vencimento: f.proxima.venc, falta_pagar: r2(f.proxima.restante) },
            } : { valor_mostrado_no_painel: r2(f.restante) }),
          };
        }),
      };
    },
  },
  {
    name: 'dividas',
    title: 'Dívidas e parcelamentos',
    description: 'Dívidas, empréstimos, financiamentos e parcelamentos: parcela, quantas faltam, próximo vencimento e se há parcela em atraso — a mesma regra do card da aba Dívidas.',
    inputSchema: {
      type: 'object',
      properties: { incluir_quitadas: { type: 'boolean', description: 'Incluir as já quitadas. Padrão: não.' } },
      additionalProperties: false,
    },
    async executar(ctx, args) {
      const r = await pedir(ctx, `/api/dividas/${PH}`);
      const lista = (r.dividas || []).filter((d) => args?.incluir_quitadas || d.status !== 'quitada');
      return {
        moeda: ctx.moeda,
        total_devido: r2(r.resumo?.total_devido),
        parcelas_do_mes: r2(r.resumo?.parcelas_mes_valor),
        dividas: lista.map((d) => {
          const prox = d.status === 'quitada' ? null : proximoVencimento(d, ctx.hoje);
          const atraso = d.status === 'quitada' ? null : parcelasEmAtraso(d, ctx.hoje);
          const total = Number(d.parcelas_total) || null;
          return {
            titulo: d.titulo, tipo: d.tipo || null, credor: d.credor || null,
            situacao: d.status,
            valor_parcela: r2(d.valor_parcela), valor_total: r2(d.valor_total),
            saldo_devedor: r2(d.saldo_devedor),
            ...(total ? { parcelas_pagas: Number(d.parcelas_pagas) || 0, parcelas_total: total } : {}),
            taxa_juros: r2(d.taxa_juros),
            ...(prox ? { proximo_vencimento: prox.data, dias_ate_vencer: prox.dias } : {}),
            ...(atraso ? { em_atraso: { desde: atraso.desde, parcelas: atraso.parcelas } } : {}),
            ligada_ao_banco: d.origem === 'of' || !!d.of_id,
          };
        }),
      };
    },
  },
  {
    name: 'metas',
    title: 'Metas',
    description: 'As metas de economia: objetivo, quanto já tem (guardado + investimentos ligados à meta), percentual e data-alvo.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async executar(ctx) {
      const ms = await pedir(ctx, `/api/metas/${PH}`) || [];
      return {
        moeda: ctx.moeda,
        metas: ms.map((m) => {
          const objetivo = Number(m.valor_objetivo) || 0;
          const tem = Number(m.valor_total ?? m.valor_atual) || 0;
          return {
            titulo: m.titulo, objetivo: r2(objetivo), ja_tem: r2(tem),
            guardado: r2(m.valor_atual), em_investimentos: r2(m.valor_investido),
            percentual: objetivo > 0 ? Math.round((tem / objetivo) * 1000) / 10 : null,
            data_alvo: m.data_alvo || null, situacao: m.status || null,
          };
        }),
      };
    },
  },
  {
    name: 'contas_fixas',
    title: 'Contas fixas',
    description: 'Gastos e receitas que se repetem (aluguel, luz, salário…): valor, dia, conta e se a deste mês já foi paga/recebida (`resolvida_este_mes`, que também cobre a pulada).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async executar(ctx) {
      const rs = await pedir(ctx, `/api/recorrencias/${PH}`) || [];
      return {
        moeda: ctx.moeda, mes: ctx.mesAtual,
        contas_fixas: rs.map((x) => ({
          descricao: x.descricao || x.categoria, tipo: x.tipo === 'Recebimento' ? 'receita' : 'despesa',
          categoria: x.categoria || null, valor: r2(x.valor), valor_varia: !!x.valor_variavel,
          dia: x.dia_vencimento ?? null, frequencia: x.frequencia || 'mensal',
          conta: x.carteira || null,
          resolvida_este_mes: !!x.resolvida_no_mes,
          ...(x.data_fim ? { termina_em: x.data_fim } : {}),
        })),
      };
    },
  },
  {
    name: 'investimentos',
    title: 'Investimentos',
    description: 'A carteira de investimentos (quanto foi aportado, quanto vale hoje e a rentabilidade) e as caixinhas/reservas do banco, separadas.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async executar(ctx) {
      const [inv, cx] = await Promise.all([
        pedir(ctx, `/api/investimentos/${PH}`),
        pedir(ctx, `/api/investimentos/caixinhas/${PH}`).catch(() => null),
      ]);
      const lista = Array.isArray(inv) ? inv : [];
      return {
        moeda: ctx.moeda,
        total_aportado: r2(lista.reduce((s, i) => s + (Number(i.valor_aportado) || 0), 0)),
        total_atual: r2(lista.reduce((s, i) => s + (Number(i.valor_atual) || 0), 0)),
        investimentos: lista.map((i) => ({
          nome: i.nome, tipo: i.tipo, ticker: i.ticker || null,
          quantidade: i.quantidade != null ? Number(i.quantidade) : null,
          aportado: r2(i.valor_aportado), valor_atual: r2(i.valor_atual),
          rentabilidade_pct: i.rentabilidade != null ? Math.round(Number(i.rentabilidade) * 10000) / 100 : null,
          reserva_de_emergencia: !!i.is_reserva_emergencia,
          ligado_ao_banco: !!i.of_id || i.origem === 'of',
        })),
        ...(cx && Array.isArray(cx.caixinhas) && cx.caixinhas.length ? {
          caixinhas_total: r2(cx.total),
          caixinhas: cx.caixinhas.map((c) => ({ nome: c.nome || 'Caixinha', valor: r2(c.saldo) })),
        } : {}),
      };
    },
  },
  {
    name: 'limites_de_gastos',
    title: 'Limites de gastos',
    description: 'Os tetos de gasto do mês (geral e por categoria) e quanto já foi gasto em cada um. O limite de uma categoria soma também as subcategorias dela, como na aba Limites.',
    inputSchema: {
      type: 'object',
      properties: { mes: { type: 'string', description: 'Mês no formato AAAA-MM. Padrão: o mês atual.' } },
      additionalProperties: false,
    },
    async executar(ctx, args) {
      const mes = mesDe(args, ctx);
      const [lim, resumo, cats] = await Promise.all([
        pedir(ctx, `/api/limites/${PH}?mes=${mes}`),
        pedir(ctx, `/api/transacoes/${PH}/resumo?mes=${mes}`),
        pedir(ctx, `/api/categorias/${PH}`),
      ]);
      const gastoPor = {};
      for (const c of resumo.por_categoria || []) gastoPor[limpaCat(c.categoria)] = (gastoPor[limpaCat(c.categoria)] || 0) + (Number(c.total) || 0);
      // ⚠️ O teto mora em `limite_mensal` (o nome vale também pro teto ANUAL,
      // migration 171) — é o que o painel e o alerta do WhatsApp leem. Lido
      // como `limite`, saía 0 pra todo mundo. Limite pausado não conta.
      const ativos = (lista) => (lista || []).filter((l) => l.ativo !== false);
      const linha = (l) => {
        const gasto = nomesDoLimite(l.categoria, cats || []).reduce((s, n) => s + (gastoPor[n] || 0), 0);
        const teto = Number(l.limite_mensal) || 0;
        return { categoria: l.categoria, teto: r2(teto), gasto: r2(gasto), usado_pct: teto > 0 ? Math.round((gasto / teto) * 1000) / 10 : null };
      };
      const geralAtivo = lim.meta_mensal_ativo !== false && Number(lim.meta_mensal) > 0;
      return {
        mes, moeda: ctx.moeda,
        ...(geralAtivo ? {
          limite_geral: {
            teto: r2(lim.meta_mensal), gasto: r2(resumo.gastos),
            usado_pct: Math.round(((Number(resumo.gastos) || 0) / Number(lim.meta_mensal)) * 1000) / 10,
          },
        } : {}),
        por_categoria: ativos(lim.categorias).map(linha),
        ...(ativos(lim.categorias_ano).length
          ? { tetos_anuais: ativos(lim.categorias_ano).map((l) => ({ categoria: l.categoria, teto_do_ano: r2(Number(l.limite_mensal) || 0) })) } : {}),
      };
    },
  },
  {
    name: 'categorias',
    title: 'Categorias',
    description: 'As categorias da pessoa (de despesa e de receita), com a categoria-pai de cada subcategoria. São os mesmos nomes aceitos no filtro `categoria` de listar_transacoes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async executar(ctx) {
      const cs = await pedir(ctx, `/api/categorias/${PH}`) || [];
      return {
        categorias: cs.filter((c) => !c.arquivada).map((c) => ({
          nome: c.nome, tipo: c.tipo === 'receita' || c.tipo === 'ambos' ? c.tipo : 'despesa',
          ...(c.parent?.nome ? { dentro_de: c.parent.nome } : {}),
        })),
      };
    },
  },
];

/** Descritores pro `tools/list` (sem a função). */
function descritores(escopo) {
  return FERRAMENTAS.map((f) => ({
    name: f.name, title: f.title, description: f.description, inputSchema: f.inputSchema,
    annotations: { title: f.title, ...LEITURA },
    // Toda ferramenta exige a conta da pessoa (OAuth). O Apps SDK lê daqui.
    securitySchemes: [{ type: 'oauth2', scopes: [escopo] }],
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: [escopo] }] },
  }));
}

const porNome = Object.fromEntries(FERRAMENTAS.map((f) => [f.name, f]));

module.exports = { FERRAMENTAS, descritores, porNome, ErroFerramenta, diaSP, pedir };
