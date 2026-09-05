const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');

const norm = p => p?.replace(/\D/g, '');

async function getUser(req) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo').eq('id', req.authUser?.id || '__none__').maybeSingle();
  return data;
}

// GET /api/recorrencias/sugestoes — gastos/receitas fixas detectados nas
// transações (Open Finance/OFX) que ainda não viraram recorrência.
// ANTES de /:phone (curinga) pra não ser capturado por ele.
router.get('/sugestoes', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    if (!grupoId) return res.json({ sugestoes: [] });
    const { detectarRecorrencias } = require('../services/detectarRecorrencias');
    const sugestoes = await detectarRecorrencias(grupoId);
    res.json({ sugestoes });
  } catch (err) {
    console.error('[recorrencias/sugestoes]', err.message);
    res.json({ sugestoes: [] }); // tolerante — nunca quebra a aba
  }
});

// GET /api/recorrencias/categorias-sugeridas — contas fixas em "Outros" que a
// Sora acha que sabe categorizar. SUGERE, não aplica: categoria mexe em
// relatório, limite e Wrapped. ANTES de /:phone (curinga).
router.get('/categorias-sugeridas', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    if (!grupoId) return res.json({ sugestoes: [] });
    const { sugerirCategorias } = require('../services/sugerirCategoriaFixa');
    res.json({ sugestoes: await sugerirCategorias(grupoId) });
  } catch (err) {
    console.error('[recorrencias/categorias-sugeridas]', err.message);
    res.json({ sugestoes: [] }); // tolerante — nunca quebra a aba
  }
});

// POST /api/recorrencias/dispensar { descricao } — marca uma sugestão como
// dispensada (não volta a aparecer). ANTES de /:phone.
router.post('/dispensar', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    const { chaveDe } = require('../services/detectarRecorrencias');
    const chave = chaveDe(req.body?.descricao || '');
    if (!grupoId || !chave) return res.json({ ok: false });
    await supabase.from('recorrencias_dispensadas')
      .upsert({ grupo_id: grupoId, chave }, { onConflict: 'grupo_id,chave' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[recorrencias/dispensar]', err.message);
    res.json({ ok: false }); // tolerante (ex.: migration 058 não rodou)
  }
});

// GET /api/recorrencias/:phone — lista as recorrências ativas do grupo
router.get('/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const cols = 'id, tipo, categoria, valor, dia_vencimento, descricao, carteira, ativa';
    const listar = (sel) => supabase.from('recorrencias')
      .select(sel)
      .eq('grupo_id', user.grupo_ativo)
      .eq('ativa', true)
      .order('tipo', { ascending: true })
      .order('dia_vencimento', { ascending: true });
    // Tolerante às migrations 066 (valor_variavel) e 112 (modo/lembrete):
    // tenta com tudo e vai tirando o que o banco ainda não tem.
    const c157 = 'frequencia, dia_semana, mes_vencimento, repeticoes, data_inicio, data_fim, lembrete_dias';
    let { data, error } = await listar(`${cols}, valor_variavel, modo_lancamento, lembrete, ${c157}`);
    if (error) ({ data, error } = await listar(`${cols}, valor_variavel, modo_lancamento, lembrete`));
    if (error) ({ data, error } = await listar(`${cols}, valor_variavel`));
    if (error) ({ data, error } = await listar(cols));
    if (error) throw error;
    // Sem a 112 o painel ainda precisa dos campos pra desenhar os controles —
    // devolve o padrão de sempre em vez de `undefined` (que viraria toggle vazio).
    res.json((data || []).map((r) => ({
      ...r,
      modo_lancamento: r.modo_lancamento || 'lancar',
      lembrete: r.lembrete === undefined || r.lembrete === null ? true : r.lembrete,
      // Migration 157. ⚠️ Os defaults DESCREVEM o comportamento de sempre —
      // mensal, para sempre, avisa no dia — pra a tela não desenhar controle
      // vazio (que a pessoa leria como "não configurado") antes da migration.
      frequencia:     r.frequencia || 'mensal',
      dia_semana:     r.dia_semana ?? null,
      mes_vencimento: r.mes_vencimento ?? null,
      repeticoes:     r.repeticoes ?? null,
      data_fim:       r.data_fim ?? null,
      lembrete_dias:  r.lembrete_dias ?? 0,
    })));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/recorrencias — cria gasto/receita fixa (body inclui phone)
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const {
      tipo, categoria, valor, dia_vencimento, descricao, carteira, valor_variavel,
      modo_lancamento, lembrete,
      frequencia, dia_semana, mes_vencimento, repeticoes, lembrete_dias,
    } = req.body;
    const { criarRecorrencia } = require('../services/recorrencias');
    const row = await criarRecorrencia({
      grupoId:   req.grupoId,
      criadoPor: req.authUser?.id || req.userId || null,
      tipo, categoria, valor, dia_vencimento, descricao, carteira, valor_variavel,
      modo_lancamento, lembrete,
      frequencia, dia_semana, mes_vencimento, repeticoes, lembrete_dias,
    });
    res.json(row);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/recorrencias/:id — edita uma recorrência existente (categoria,
// valor, dia, descrição, conta). Antes só dava pra excluir e recriar.
//
// A recorrência é um TEMPLATE: editá-la mudava só os lançamentos futuros, então
// quem corrigia a categoria via o lançamento deste mês continuar em "Outros" e
// achava que não salvou. Agora a mudança de categoria PROPAGA pro lançamento do
// mês corrente gerado por ela (só se ele ainda estiver na categoria antiga —
// assim um ajuste manual naquela transação específica é preservado).
router.put('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const {
      categoria, valor, dia_vencimento, descricao, carteira, modo_lancamento, lembrete,
      frequencia, dia_semana, mes_vencimento, repeticoes, lembrete_dias,
    } = req.body;
    const MODOS = ['lancar', 'prever', 'nao_lancar'];
    const patch = {};
    if (valor !== undefined)          patch.valor          = parseFloat(valor) || 0;
    if (dia_vencimento !== undefined) patch.dia_vencimento = Math.max(1, Math.min(31, parseInt(dia_vencimento, 10) || 5));
    if (descricao !== undefined)      patch.descricao      = String(descricao).trim().slice(0, 120);
    if (carteira !== undefined)       patch.carteira       = carteira || 'Dinheiro';
    // Migration 112 — separados do resto pra poder cair fora se a coluna não existir.
    const patch112 = {};
    if (modo_lancamento !== undefined && MODOS.includes(modo_lancamento)) patch112.modo_lancamento = modo_lancamento;
    if (lembrete !== undefined) patch112.lembrete = !!lembrete;

    // Estado ANTES da edição — precisamos da categoria/descrição antigas.
    // ⚠️ Select tolerante: pedir colunas da 157 antes da migration derruba a
    // leitura inteira, e com ela a propagação de categoria que já funcionava.
    let { data: antes } = await supabase.from('recorrencias')
      .select('categoria, descricao, dia_vencimento, frequencia, repeticoes, data_inicio, dia_semana, mes_vencimento')
      .eq('id', req.params.id).eq('grupo_id', req.grupoId).maybeSingle();
    if (!antes) ({ data: antes } = await supabase.from('recorrencias')
      .select('categoria, descricao, dia_vencimento')
      .eq('id', req.params.id).eq('grupo_id', req.grupoId).maybeSingle());

    // ── Migration 157 ──────────────────────────────────────────────────────
    const patch157 = {};
    if (frequencia !== undefined && ['semanal', 'mensal', 'anual'].includes(frequencia)) {
      patch157.frequencia = frequencia;
      // ⚠️ Trocar de frequência tem de LIMPAR o campo da outra. Uma semanal que
      // virou mensal com o `dia_semana` sobrando dispararia toda semana pra
      // sempre: a coluna velha continuaria casando dentro de `venceHoje`.
      if (frequencia !== 'semanal') patch157.dia_semana = null;
      if (frequencia !== 'anual')   patch157.mes_vencimento = null;
    }
    if (dia_semana !== undefined && dia_semana !== null) {
      patch157.dia_semana = Math.max(0, Math.min(6, parseInt(dia_semana, 10) || 0));
    }
    if (mes_vencimento !== undefined && mes_vencimento !== null) {
      patch157.mes_vencimento = Math.max(1, Math.min(12, parseInt(mes_vencimento, 10) || 1));
    }
    if (lembrete_dias !== undefined) {
      patch157.lembrete_dias = Math.max(0, Math.min(30, parseInt(lembrete_dias, 10) || 0));
    }

    // ⚠️ `data_fim` é DERIVADA, nunca vem do cliente — e sai da `data_inicio`
    // ORIGINAL, não de hoje. Recalcular a partir de hoje faria "12x" reiniciar
    // a contagem a cada edição: uma recorrência que já rodou 10 meses ganharia
    // mais 12 sem ninguém ter pedido.
    if (repeticoes !== undefined || frequencia !== undefined) {
      const { calcularDataFim } = require('../services/frequenciaRecorrencia');
      const hojeSP = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      const reps = repeticoes !== undefined ? repeticoes : antes?.repeticoes;
      patch157.repeticoes = Number(reps) > 0 ? Math.min(999, parseInt(reps, 10)) : null;
      patch157.data_fim = calcularDataFim({
        frequencia: patch157.frequencia || antes?.frequencia || 'mensal',
        repeticoes: patch157.repeticoes,
        dataInicio: (antes?.data_inicio && String(antes.data_inicio).slice(0, 10)) || hojeSP,
        diaVencimento: patch.dia_vencimento ?? antes?.dia_vencimento,
        // ⚠️ Sem estes dois a contagem parte da data de criação, não da
        // primeira ocorrência — e "12x" vira 11.
        diaSemana: patch157.dia_semana ?? antes?.dia_semana,
        mesVencimento: patch157.mes_vencimento ?? antes?.mes_vencimento,
      });
    }

    // ⚠️ Categoria passa pela validação contra o CATÁLOGO do grupo. Sem isso,
    // salvar um nome que não existe (herdado do rebuild 084→087) fazia o
    // lançamento cair em "Outros" e parecia que a edição não tinha salvado.
    if (categoria !== undefined) {
      const { categoriaValida } = require('../services/recorrencias');
      patch.categoria = await categoriaValida(req.grupoId, categoria || 'Outros');
    }
    if (!Object.keys(patch).length && !Object.keys(patch112).length && !Object.keys(patch157).length) {
      return res.json({ ok: true });
    }

    const salvar = (p) => supabase.from('recorrencias').update(p)
      .eq('id', req.params.id).eq('grupo_id', req.grupoId).select().single();
    // ⚠️ Cascata de MIGRATION PENDENTE, do mais completo pro mais antigo: sem a
    // 157 (ou sem a 112) o que dá pra salvar é salvo, em vez de a edição inteira
    // ser recusada por um erro de coluna que o usuário não tem como interpretar.
    let { data, error } = await salvar({ ...patch, ...patch112, ...patch157 });
    if (error && Object.keys(patch157).length) ({ data, error } = await salvar({ ...patch, ...patch112 }));
    if (error && /modo_lancamento|lembrete/i.test(error.message || '') && Object.keys(patch).length) {
      ({ data, error } = await salvar(patch));
    }
    if (error) throw error;

    // Propaga a categoria nova pro lançamento deste mês. O cron nomeia a
    // transação como '[Recorrente] X' (fixo) ou '[Previsto] X' (variável), e o
    // "confirmar" tira o prefixo — por isso as 3 formas.
    let propagadas = 0;
    const mudouCategoria = patch.categoria && antes && patch.categoria !== antes.categoria;
    if (mudouCategoria) {
      try {
        const desc = antes.descricao || data.descricao;
        const inicioMes = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 7) + '-01';
        const { data: alvos } = await supabase.from('transacoes')
          .select('id, observacao, categoria')
          .eq('grupo_id', req.grupoId)
          .eq('categoria', antes.categoria)      // preserva ajuste manual
          .gte('data', inicioMes)
          .in('observacao', [desc, `[Recorrente] ${desc}`, `[Previsto] ${desc}`]);
        const ids = (alvos || []).map(t => t.id);
        if (ids.length) {
          await supabase.from('transacoes').update({ categoria: patch.categoria }).in('id', ids);
          propagadas = ids.length;
        }
      } catch { /* tolerante: a edição da recorrência já valeu */ }
    }

    res.json({ ...data, propagadas });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/recorrencias/:id — cancela (ativa=false). phone no body p/ permissão.
router.delete('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    await supabase.from('recorrencias').update({ ativa: false })
      .eq('id', req.params.id).eq('grupo_id', req.grupoId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
