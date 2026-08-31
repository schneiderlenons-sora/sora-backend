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
const arquivadas = require('../services/arquivadas');
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
// Colunas mínimas do GRÁFICO do dashboard (`txsMes`). ESPELHA `COLUNAS_GRAFICO`
// de sora-frontend/lib/ssr-data.ts — mexeu num, mexa no outro, senão o SSR
// pinta uma forma e a revalidação troca por outra.
//
// Enumeradas a partir dos consumidores REAIS: computeDailyAmount (data, valor),
// o filtro do gráfico (categoria, transferencia), gastoPorContaDe (tipo,
// carteira_nome) e ResumoCards (carteira_nome). Sem o embed do criador — o
// gráfico não mostra avatar, e o join puxava 6 campos de `users` POR LINHA.
// Medido: 57,8 KB → 14,0 KB por visita.
const COLUNAS_GRAFICO = 'id, data, valor, categoria, tipo, transferencia, carteira_nome';

async function listarTransacoes(grupoId, { mes, tipo, limit, ate, colunas }) {
  // Caminho enxuto: quem pede colunas específicas não usa o embed do criador,
  // logo não precisa da escada de fallback de embed que vem depois.
  if (colunas) {
    let q = supabase.from('transacoes').select(colunas, { count: 'exact' })
      .eq('grupo_id', grupoId)
      .order('data', { ascending: false })
      .range(0, Number(limit) - 1);
    if (mes)  q = q.gte('data', `${mes}-01`).lt('data', proximoMesPrimeiroDia(mes));
    if (ate)  q = q.lte('data', ate);
    if (tipo) q = q.eq('tipo', tipo);
    q = await arquivadas.filtrar(q, {});
    const { data: d, count: c } = await q;
    return { transacoes: (d || []).map(t => ({ ...t, wallet_nome: t.carteira_nome })), total: c || 0 };
  }

  let query = supabase.from('transacoes')
    .select('*, criador:users!transacoes_criado_por_fkey(id, name, phone, avatar_url, avatar_preset, avatar_cor)', { count: 'exact' })
    .eq('grupo_id', grupoId)
    .order('data', { ascending: false })
    .range(0, Number(limit) - 1);
  if (mes)  query = query.gte('data', `${mes}-01`).lt('data', proximoMesPrimeiroDia(mes));
  if (ate)  query = query.lte('data', ate); // exclui lançamentos futuros (parcelas)
  if (tipo) query = query.eq('tipo', tipo);
  // Arquivadas (migration 131) ficam de fora — igual à lista da aba Transações.
  query = await arquivadas.filtrar(query, {});

  let { data, count, error } = await query;
  if (error) {
    // Fallback: mantém o criador, mas só com colunas que existem sem a
    // migration 048 (preset/cor). Assim o avatar do autor não some.
    let q2 = supabase.from('transacoes')
      .select('*, criador:users!transacoes_criado_por_fkey(id, name, phone, avatar_url)', { count: 'exact' })
      .eq('grupo_id', grupoId)
      .order('data', { ascending: false })
      .range(0, Number(limit) - 1);
    if (mes)  q2 = q2.gte('data', `${mes}-01`).lt('data', proximoMesPrimeiroDia(mes));
    if (ate)  q2 = q2.lte('data', ate);
    if (tipo) q2 = q2.eq('tipo', tipo);
    q2 = await arquivadas.filtrar(q2, {});
    let r = await q2;
    if (r.error) { // último recurso: sem embed nenhum
      let q3 = supabase.from('transacoes').select('*', { count: 'exact' })
        .eq('grupo_id', grupoId).order('data', { ascending: false }).range(0, Number(limit) - 1);
      if (mes)  q3 = q3.gte('data', `${mes}-01`).lt('data', proximoMesPrimeiroDia(mes));
      if (ate)  q3 = q3.lte('data', ate);
      if (tipo) q3 = q3.eq('tipo', tipo);
      q3 = await arquivadas.filtrar(q3, {});
      r = await q3;
    }
    data = r.data; count = r.count;
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
      listarTransacoes(grupoId, { limit: 8, ate: new Date().toISOString() }), // recentes: nada de futuro (parcelas)
      // ⚠️ Só o GRÁFICO vai enxuto. A lista de RECENTES (acima) continua com
      // `select('*')` + embed do criador porque ela mostra observação, avatar de
      // quem lançou e o resto — estreitar ali apagaria conteúdo da tela.
      listarTransacoes(grupoId, { mes, tipo: 'Gasto', limit: 500, colunas: COLUNAS_GRAFICO }),
      // ⚠️ Colunas explícitas e SEM o embed do pai. Era a leitura mais cara do
      // dashboard (~180 categorias por grupo × todas as colunas, em toda visita).
      // O dashboard só usa `categorias` via `getCategoriaTheme`, cujo contrato é
      // nome + icone + cor. Medido: 58,4 KB → 27,4 KB.
      // ⚠️ Vale só pra ESTA rota. A aba /categorias usa GET /api/categorias/:phone,
      // que segue devolvendo tudo — ela precisa.
      supabase.from('categorias').select('id, nome, icone, cor, parent_id, tipo')
        .eq('grupo_id', grupoId).eq('ativa', true).order('nome'),
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
