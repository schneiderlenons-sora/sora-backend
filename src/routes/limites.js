// =============================================================================
// Limites de gasto — teto MENSAL e teto ANUAL, por categoria e geral.
//
// ⚠️ O TETO ANUAL MORA NA MESMA `category_limits`, com `mes_referencia`
// guardando só o ano ('2026' em vez de '2026-09'). A unique
// `(grupo_id, categoria, mes_referencia)` já separa os dois, então um limite
// mensal e um anual da MESMA categoria convivem sem colidir. Migration 171.
//
// ⚠️ `limite_mensal` é o nome da coluna nos DOIS casos — leia como "o teto
// daquela linha". Renomear exigiria tocar em toda query de limite (rotas,
// handler do zap, serviço de alerta e painel): risco alto por ganho cosmético.
// =============================================================================
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');

// ⚠️ FUSO SP, NUNCA `toISOString()`. Era `new Date().toISOString().slice(0,7)`:
// a partir das 21h no Brasil o UTC já virou o dia — e no dia 31 às 21h, o MÊS.
// Quem abrisse a aba à noite no fim do mês veria (e gravaria) o limite do mês
// seguinte. Mesma regra do resto do projeto (ver CLAUDE.md).
const hojeSP  = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const mesSP   = () => hojeSP().slice(0, 7);
const anoSP   = () => hojeSP().slice(0, 4);

// ⚠️ FONTE ÚNICA no serviço, não uma cópia aqui. A rota, o alerta e o painel
// têm de concordar em qual linha é anual — três cópias dessa comparação seriam
// três chances de um teto anual ser lido como mensal (ou sumir da tela).
const { chaveDoPeriodo, ehChaveAnual } = require('../services/limites');

async function getGrupoId(req) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('id', req.authUser?.id || '__none__').single();
  return data?.grupo_ativo || null;
}

router.get('/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    const mes = req.query.mes || mesSP();
    const ano = (req.query.ano || mes).slice(0, 4);

    // ⚠️ As colunas anuais vêm em consulta SEPARADA e TOLERANTE. Pedi-las junto
    // das mensais faria o SELECT inteiro falhar enquanto a migration 171 não
    // rodar — e aí a aba de limites quebraria para a base inteira, que só usa
    // o mensal. É a lição do `getUser` do Grow, registrada no CLAUDE.md.
    const { data: user } = await supabase.from('users')
      .select('meta_mensal, meta_mensal_ativo, meta_mensal_alerta_ativo, meta_mensal_alerta_pct')
      .eq('id', req.authUser?.id || '__none__').single();

    const anual = await supabase.from('users')
      .select('meta_anual, meta_anual_ativo, meta_anual_alerta_ativo, meta_anual_alerta_pct')
      .eq('id', req.authUser?.id || '__none__').single()
      .then((r) => r.data, () => null);

    // Uma consulta só pros dois: '2026' e '2026-09' na mesma lista.
    const { data: limites } = await supabase.from('category_limits')
      .select('*').eq('grupo_id', grupoId).in('mes_referencia', [mes, ano]);


    res.json({
      meta_mensal:               user?.meta_mensal || 0,
      meta_mensal_ativo:         user?.meta_mensal_ativo ?? true,
      meta_mensal_alerta_ativo:  user?.meta_mensal_alerta_ativo ?? true,
      meta_mensal_alerta_pct:    user?.meta_mensal_alerta_pct ?? 80,
      meta_anual:                anual?.meta_anual || 0,
      meta_anual_ativo:          anual?.meta_anual_ativo ?? true,
      meta_anual_alerta_ativo:   anual?.meta_anual_alerta_ativo ?? true,
      meta_anual_alerta_pct:     anual?.meta_anual_alerta_pct ?? 80,
      categorias:                (limites || []).filter((l) => !ehChaveAnual(l.mes_referencia)),
      categorias_ano:            (limites || []).filter((l) => ehChaveAnual(l.mes_referencia)),
      ano,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── VISÃO DO ANO: 12 meses, realizado × previsto ────────────────────────────
//
// É o gráfico que o cliente pediu ("Orçamento anual", com barra por mês). Uma
// chamada só: sem isso a tela faria 12 requisições, uma por mês.
//
// ⚠️ "Previsto" do mês = a soma dos tetos MENSAIS daquele mês, NÃO o teto anual
// dividido por 12. São dois orçamentos diferentes: o anual é um teto próprio
// (gasto sazonal cabe no ano estourando um mês), e fatiá-lo mentiria sobre o
// que a pessoa configurou.
router.get('/:phone/ano', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    const ano = String(req.query.ano || anoSP()).slice(0, 4);
    const meses = Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, '0')}`);

    // Mesma leitura tolerante e o MESMO `ehTransferencia` do serviço de alerta.
    // Divergir aqui faria a tela e o aviso do WhatsApp mostrarem números
    // diferentes pro mesmo teto — o erro que este projeto mais pagou caro.
    const q = (campos) => supabase.from('transacoes').select(campos)
      .eq('grupo_id', grupoId).eq('tipo', 'Gasto')
      .gte('data', `${ano}-01-01`).lt('data', `${Number(ano) + 1}-01-01`);
    let r = await q('data, valor, categoria, transferencia, ignorar_em');
    if (r.error) r = await q('data, valor, categoria, transferencia');
    const { ehTransferencia } = require('../services/resumoTransacoes');
    const gastos = (r.data || []).filter((g) => !ehTransferencia(g));

    const { data: limites } = await supabase.from('category_limits')
      .select('*').eq('grupo_id', grupoId)
      .or(`mes_referencia.eq.${ano},mes_referencia.like.${ano}-%`);

    const ativos = (limites || []).filter((l) => l.ativo !== false && l.limite_mensal);
    const doAno  = ativos.filter((l) => ehChaveAnual(l.mes_referencia));
    const doMes  = ativos.filter((l) => !ehChaveAnual(l.mes_referencia));

    // ⚠️ A DATA É FATIADA, não passada por `new Date()`. `transacoes.data` é
    // timestamptz e guarda duas semânticas (data pura em meia-noite UTC ×
    // instante real) — `new Date(...).getMonth()` jogaria o gasto do dia 1 pro
    // mês anterior no Brasil. Ver a seção `lib/data-br.ts` no CLAUDE.md.
    const mesDe = (d) => String(d || '').slice(0, 7);

    const porMes = meses.map((m) => ({
      mes: m,
      realizado: gastos.filter((g) => mesDe(g.data) === m).reduce((s, g) => s + (g.valor || 0), 0),
      previsto:  doMes.filter((l) => l.mes_referencia === m).reduce((s, l) => s + (l.limite_mensal || 0), 0),
    }));

    // Por categoria: realizado do ano + os DOIS tetos, pra tela mostrar lado a
    // lado sem ter de adivinhar qual existe.
    const nomes = [...new Set([
      ...ativos.map((l) => l.categoria),
      ...gastos.map((g) => g.categoria),
    ].filter(Boolean))];

    const { limpaCat, nomesDoLimite } = require('../services/limites');
    const { data: cats } = await supabase
      .from('categorias').select('id, nome, parent_id').eq('grupo_id', grupoId);

    const porCategoria = nomes.map((cat) => {
      const chaves = new Set(nomesDoLimite(cat, cats));
      return {
        categoria: cat,
        realizado: gastos.filter((g) => chaves.has(limpaCat(g.categoria)))
          .reduce((s, g) => s + (g.valor || 0), 0),
        teto_ano: doAno.find((l) => l.categoria === cat)?.limite_mensal || 0,
        // Soma dos tetos mensais do ano — o "previsto" do orçamento mensal.
        teto_meses: doMes.filter((l) => l.categoria === cat)
          .reduce((s, l) => s + (l.limite_mensal || 0), 0),
      };
    }).sort((a, b) => b.realizado - a.realizado);

    res.json({
      ano,
      meses: porMes,
      categorias: porCategoria,
      total: {
        realizado: porMes.reduce((s, m) => s + m.realizado, 0),
        previsto:  porMes.reduce((s, m) => s + m.previsto, 0),
      },
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/geral', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { valor, ativo, alerta_ativo, alerta_pct, periodo } = req.body;
    const anualP = periodo === 'anual';
    const pre = anualP ? 'meta_anual' : 'meta_mensal';

    const patch = { [pre]: valor };
    if (typeof ativo === 'boolean')        patch[`${pre}_ativo`] = ativo;
    if (typeof alerta_ativo === 'boolean') patch[`${pre}_alerta_ativo`] = alerta_ativo;
    if (typeof alerta_pct === 'number')    patch[`${pre}_alerta_pct`] = alerta_pct;

    const { error } = await supabase.from('users').update(patch)
      .eq('id', req.authUser?.id || '__none__');
    // ⚠️ O ERRO É LIDO. Sem a migration 171 as colunas anuais não existem e o
    // UPDATE falha — respondendo `ok` a tela fecharia dizendo que salvou, e o
    // teto nunca existiria. Mesma família dos bugs das migrations 121 e 147.
    if (error) {
      return res.status(500).json({
        erro: error.message,
        dica: anualP ? 'Rode a migration 171 (limites anuais).' : undefined,
      });
    }
    res.json({ ok: true, ...patch });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/categoria', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { categoria, limite_mensal, percentual_alerta, ativo, mes_referencia, periodo } = req.body;
    const grupoId = await getGrupoId(req);
    const ref = chaveDoPeriodo(periodo, mes_referencia);

    const payload = {
      grupo_id: grupoId, categoria, limite_mensal,
      percentual_alerta: percentual_alerta || 80,
      mes_referencia: ref,
    };
    if (typeof ativo === 'boolean') payload.ativo = ativo;

    // ⚠️ `periodo` vai num upsert TOLERANTE: com a migration 171 pendente a
    // coluna não existe e o insert falharia. O teto anual funciona sem ela (a
    // chave é o `mes_referencia`); a coluna é pra tela não precisar deduzir o
    // período pelo tamanho do texto.
    let r = await supabase.from('category_limits')
      .upsert({ ...payload, periodo: periodo === 'anual' ? 'anual' : 'mensal' },
        { onConflict: 'grupo_id,categoria,mes_referencia' }).select().single();
    if (r.error) {
      r = await supabase.from('category_limits')
        .upsert(payload, { onConflict: 'grupo_id,categoria,mes_referencia' }).select().single();
    }
    if (r.error) return res.status(500).json({ erro: r.error.message });
    res.json(r.data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await supabase.from('category_limits').delete()
      .eq('id', req.params.id).eq('grupo_id', req.authUser?.grupoAtivo || '__nenhum__');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
