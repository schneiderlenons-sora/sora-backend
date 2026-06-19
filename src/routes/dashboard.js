// ─────────────────────────────────────────────────────────────────────────
// Endpoint CONSOLIDADO do dashboard.
//
// Junta numa única resposta o que o painel buscava em 6 chamadas separadas
// (resumo do mês, resumo do mês anterior, carteiras, transações recentes,
// gastos do mês e categorias). Menos round-trips = abertura mais rápida no
// mobile.
//
// 100% ADITIVO: este arquivo NÃO altera nenhuma rota existente. As queries
// são cópias fiéis das já usadas em transacoes.js / wallets.js / categorias.js
// (mesma forma de dado). Se algo aqui falhar, o frontend tem fallback pras
// chamadas antigas — então é impossível quebrar o painel.
// ─────────────────────────────────────────────────────────────────────────
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { calcularResumo } = require('../services/resumoTransacoes');

// Primeiro dia do mês seguinte (YYYY-MM-01) — limite exclusivo seguro
// (evita datas inválidas tipo `-31`). Idêntico ao de transacoes.js.
function proximoMesPrimeiroDia(mes) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// Resumo de um mês — FONTE ÚNICA compartilhada com GET /api/transacoes/:phone/resumo
// (services/resumoTransacoes). Garante que dashboard e relatórios nunca divirjam.
const calcResumo = (grupoId, mes) => calcularResumo({ grupoId, mes });

// Lista de transações — mesma lógica de GET /api/transacoes/:phone
// (com o mesmo fallback caso a FK do join não exista no schema).
async function listarTransacoes(grupoId, { mes, tipo, limit }) {
  let query = supabase.from('transacoes')
    .select('*, criador:users!transacoes_criado_por_fkey(id, name, phone)', { count: 'exact' })
    .eq('grupo_id', grupoId)
    .order('data', { ascending: false })
    .range(0, Number(limit) - 1);
  if (mes)  query = query.gte('data', `${mes}-01`).lt('data', proximoMesPrimeiroDia(mes));
  if (tipo) query = query.eq('tipo', tipo);

  let { data, count, error } = await query;
  if (error) {
    let q2 = supabase.from('transacoes').select('*', { count: 'exact' })
      .eq('grupo_id', grupoId)
      .order('data', { ascending: false })
      .range(0, Number(limit) - 1);
    if (mes)  q2 = q2.gte('data', `${mes}-01`).lt('data', proximoMesPrimeiroDia(mes));
    if (tipo) q2 = q2.eq('tipo', tipo);
    const r = await q2; data = r.data; count = r.count;
  }
  const transacoes = (data || []).map(t => ({ ...t, wallet_nome: t.carteira_nome }));
  return { transacoes, total: count || 0 };
}

// GET /api/dashboard/:phone?mes=YYYY-MM&mesAnt=YYYY-MM
router.get('/:phone', auth, async (req, res) => {
  try {
    // O middleware `auth` já amarra o request ao próprio usuário e expõe o
    // grupo ativo — usamos direto (anti-IDOR por construção, sem lookup extra).
    const grupoId = req.authUser?.grupoAtivo;
    if (!grupoId) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const mes    = req.query.mes || new Date().toISOString().slice(0, 7);
    const mesAnt = req.query.mesAnt || (() => {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();

    // Tudo em paralelo; cada peça é tolerante (uma falha não derruba as outras).
    const [resumo, resumoAnt, wallets, txsRec, txsMes, categorias] = await Promise.allSettled([
      calcResumo(grupoId, mes),
      calcResumo(grupoId, mesAnt),
      supabase.from('wallets').select('*').eq('grupo_id', grupoId).order('nome'),
      listarTransacoes(grupoId, { limit: 8 }),
      listarTransacoes(grupoId, { mes, tipo: 'Gasto', limit: 500 }),
      supabase.from('categorias').select('*, parent:parent_id(id,nome)').eq('grupo_id', grupoId).eq('ativa', true).order('nome'),
    ]);

    const val = (r, d) => (r.status === 'fulfilled' ? r.value : d);
    const resumoVazio = { receitas: 0, gastos: 0, saldo: 0, por_categoria: [], por_membro: [] };

    res.json({
      resumo:     val(resumo,    resumoVazio),
      resumoAnt:  val(resumoAnt, resumoVazio),
      wallets:    (val(wallets,    { data: [] }).data) || [],
      txsRec:     val(txsRec, { transacoes: [], total: 0 }),
      txsMes:     val(txsMes, { transacoes: [], total: 0 }),
      categorias: (val(categorias, { data: [] }).data) || [],
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
