// ─────────────────────────────────────────────────────────────────────────
// Sora Wrapped — agregação de dados pros resumos (Finance + Grow).
// Disponível só com ~30 dias de uso E dados suficientes no período.
// Suporta período mensal (YYYY-MM) e anual (YYYY).
// ─────────────────────────────────────────────────────────────────────────
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');

const MES_NOMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// Mínimos pra liberar o Wrapped
const MIN_DIAS_USO      = 30;
const MIN_LANCAMENTOS   = 12;  // finance
const MIN_ATIVIDADE_GROW = 15; // checks de hábito + tarefas

function norm(phone) { return String(phone || '').replace(/\D/g, ''); }

async function getUser(phone) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo, created_at').eq('phone', norm(phone)).maybeSingle();
  return data;
}

// Resolve o período: { anual, inicio (YYYY-MM-DD), fim (exclusivo), label, periodo }
function resolverPeriodo(param) {
  const hoje = new Date();
  if (param && /^\d{4}$/.test(param)) {
    const ano = +param;
    return { anual: true, inicio: `${ano}-01-01`, fim: `${ano + 1}-01-01`, label: `${ano}`, periodo: String(ano) };
  }
  const ym = (param && /^\d{4}-\d{2}$/.test(param)) ? param : hoje.toISOString().slice(0, 7);
  const [a, m] = ym.split('-').map(Number);
  const fimDate = new Date(a, m, 1); // m é 1-based → primeiro dia do mês seguinte
  return {
    anual: false,
    inicio: `${ym}-01`,
    fim: fimDate.toISOString().slice(0, 10),
    label: `${MES_NOMES[m - 1]} ${a}`,
    periodo: ym,
  };
}

function diasDeUso(user) {
  if (!user?.created_at) return 999;
  return Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86400000);
}

// Maior sequência de dias consecutivos presentes num Set de datas 'YYYY-MM-DD'
function maiorSequencia(datasSet) {
  const datas = [...datasSet].sort();
  let melhor = 0, atual = 0, anterior = null;
  for (const d of datas) {
    if (anterior) {
      const diff = (new Date(d) - new Date(anterior)) / 86400000;
      atual = diff === 1 ? atual + 1 : 1;
    } else atual = 1;
    melhor = Math.max(melhor, atual);
    anterior = d;
  }
  return melhor;
}

// ─── FINANCE ──────────────────────────────────────────────────────────────
router.get('/financas/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const P = resolverPeriodo(req.query.periodo);
    const { data: txs } = await supabase.from('transacoes')
      .select('tipo, valor, categoria, data')
      .eq('grupo_id', user.grupo_ativo)
      .gte('data', P.inicio).lt('data', P.fim);

    const lista = txs || [];
    let receitas = 0, gastos = 0;
    const porCat = {};
    const diasSet = new Set();
    let maiorGasto = null;
    for (const t of lista) {
      const v = Number(t.valor) || 0;
      const ehGasto = /gasto/i.test(t.tipo || '');
      // Pagamento de fatura = quitação de dívida (transferência), não consumo.
      // As compras do cartão já contam nas categorias reais — incluir a fatura
      // dobraria os valores (movimentado, gastos, vilão, maior gasto).
      if (t.categoria === 'Fatura cartão') { if (t.data) diasSet.add(t.data.slice(0, 10)); continue; }
      if (ehGasto) {
        gastos += v;
        const c = t.categoria || 'Outros';
        porCat[c] = (porCat[c] || 0) + v;
        if (!maiorGasto || v > maiorGasto.valor) maiorGasto = { valor: v, categoria: c, data: t.data };
      } else receitas += v;
      if (t.data) diasSet.add(t.data.slice(0, 10));
    }
    const movimentado = receitas + gastos;
    const topCats = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([categoria, total]) => ({ categoria, total, pct: gastos ? Math.round((total / gastos) * 100) : 0 }));

    // delta vs período anterior (movimentado)
    let deltaMov = null;
    if (!P.anual) {
      const dAnt = new Date(P.inicio); dAnt.setMonth(dAnt.getMonth() - 1);
      const iniAnt = dAnt.toISOString().slice(0, 10);
      const { data: txAnt } = await supabase.from('transacoes')
        .select('valor').eq('grupo_id', user.grupo_ativo).gte('data', iniAnt).lt('data', P.inicio);
      const movAnt = (txAnt || []).reduce((s, t) => s + (Number(t.valor) || 0), 0);
      if (movAnt > 0) deltaMov = Math.round(((movimentado - movAnt) / movAnt) * 100);
    }

    const dias = diasDeUso(user);
    const disponivel = dias >= MIN_DIAS_USO && lista.length >= MIN_LANCAMENTOS;

    res.json({
      disponivel, periodo: P.periodo, periodo_label: P.label, anual: P.anual,
      movimentado, receitas, gastos, economia: receitas - gastos,
      n_lancamentos: lista.length, dias_registrando: diasSet.size,
      delta_movimentado_pct: deltaMov,
      top_categorias: topCats,
      vilao: topCats[0] || null,
      maior_gasto: maiorGasto,
      faltam: {
        dias: Math.max(0, MIN_DIAS_USO - dias),
        lancamentos: Math.max(0, MIN_LANCAMENTOS - lista.length),
      },
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── GROW ───────────────────────────────────────────────────────────────────
router.get('/grow/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const P = resolverPeriodo(req.query.periodo);
    // Grow é pessoal (hábitos/tarefas/humor por user_id) — o Wrapped é do
    // próprio usuário, não do grupo. Finanças seguem por grupo em outra rota.
    const uid = user.id;

    const [{ data: regs }, { data: habitos }, { data: tarefas }, { data: humores }] = await Promise.all([
      supabase.from('registros_habito').select('habito_id, data, concluido').eq('user_id', uid).gte('data', P.inicio).lt('data', P.fim),
      supabase.from('habitos').select('id, nome, icone').eq('user_id', uid),
      supabase.from('tarefas').select('id, concluida, updated_at, created_at').eq('user_id', uid),
      supabase.from('registros_humor').select('humor, data').eq('user_id', uid).gte('data', P.inicio).lt('data', P.fim),
    ]);

    const feitos = (regs || []).filter(r => r.concluido);
    const habitosConcluidos = feitos.length;

    // top hábitos
    const porHab = {};
    const diasSet = new Set();
    for (const r of feitos) {
      porHab[r.habito_id] = (porHab[r.habito_id] || 0) + 1;
      if (r.data) diasSet.add(r.data.slice(0, 10));
    }
    const mapHab = Object.fromEntries((habitos || []).map(h => [h.id, h]));
    const topVal = Math.max(1, ...Object.values(porHab));
    const topHabitos = Object.entries(porHab).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, total]) => ({
      nome: mapHab[id]?.nome || 'Hábito', icone: mapHab[id]?.icone || '🎯',
      total, pct: Math.round((total / topVal) * 100),
    }));

    const maiorStreak = maiorSequencia(diasSet);

    // tarefas concluídas no período (por updated_at, fallback created_at)
    const tarefasConcluidas = (tarefas || []).filter(t => {
      if (!t.concluida) return false;
      const d = (t.updated_at || t.created_at || '').slice(0, 10);
      return d >= P.inicio && d < P.fim;
    }).length;

    const humorMedio = (humores || []).length
      ? Math.round(((humores.reduce((s, h) => s + (Number(h.humor) || 0), 0)) / humores.length) * 10) / 10
      : null;

    const atividade = habitosConcluidos + tarefasConcluidas;
    const dias = diasDeUso(user);
    const disponivel = dias >= MIN_DIAS_USO && atividade >= MIN_ATIVIDADE_GROW;

    res.json({
      disponivel, periodo: P.periodo, periodo_label: P.label, anual: P.anual,
      habitos_concluidos: habitosConcluidos,
      maior_streak: maiorStreak,
      tarefas_concluidas: tarefasConcluidas,
      humor_medio: humorMedio,
      top_habitos: topHabitos,
      faltam: {
        dias: Math.max(0, MIN_DIAS_USO - dias),
        atividade: Math.max(0, MIN_ATIVIDADE_GROW - atividade),
      },
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
