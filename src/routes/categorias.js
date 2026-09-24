const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const norm     = p => p?.replace(/\D/g, '');

async function getGrupoId(req) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('id', req.authUser?.id || '__none__').single();
  return data?.grupo_ativo || null;
}

router.get('/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { tipo } = req.query;
    let q = supabase.from('categorias')
      // ⚠️ COLUNAS EXPLÍCITAS, não `*`. Esta é a consulta MAIS CHAMADA do
      // painel — 16 telas pedem a lista de categorias (dashboard, /categorias,
      // relatórios, limites, o modal de nova transação, o form de conta fixa…)
      // — e a tabela tem ~180 linhas POR GRUPO (33.584 no total).
      //
      // `select('*')` trazia `grupo_id` (36 chars, redundante: a query já
      // filtra por ele), `created_at` e `updated_at` (32 cada) em toda linha.
      // Ninguém no painel lê nenhum dos três — conferido nos 16 consumidores.
      //
      // Medido em 25 grupos reais: 69,9 KB → 42,0 KB por chamada (−40%).
      // Mesma lição que o dashboard já tinha aprendido (`categoriasDireto` no
      // ssr-data.ts), que ficou só lá enquanto esta rota seguia com `*`.
      .select('id, nome, parent_id, icone, cor, tipo, arquivada, parent:parent_id(id,nome)')
      .eq('grupo_id', grupoId)
      .eq('ativa', true).order('nome');
    // 'ambos' (ex.: Presente) entra nas DUAS listas — filtrar por eq() a esconderia.
    if (tipo === 'despesa' || tipo === 'receita') q = q.or(`tipo.eq.${tipo},tipo.eq.ambos`);
    const { data } = await q;
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { nome, parent_id, icone, cor, tipo } = req.body;
    const grupoId = req.grupoId; // grupo do usuário autenticado (exigirPermissao)
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const tipoNorm = ['receita', 'ambos'].includes(tipo) ? tipo : 'despesa';
    const { data } = await supabase.from('categorias')
      .insert({ grupo_id: grupoId, nome, parent_id: parent_id || null, icone: icone || '📦', cor: cor || '#808080', tipo: tipoNorm })
      .select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo || '__nenhum__';
    const { nome, icone, cor, arquivada, tipo, parent_id } = req.body;
    const patch = { nome, icone, cor, arquivada };
    if (['despesa', 'receita', 'ambos'].includes(tipo)) patch.tipo = tipo;

    // ── MOVER PRA BAIXO DE OUTRA CATEGORIA ────────────────────────────────
    //
    // Relato de cliente (set/2026): "criei uma categoria Carro, mas não consigo
    // colocar Prestação do veículo como subcategoria dela. Eu altero mas ele
    // não grava". Medido: as duas na RAIZ.
    //
    // ⚠️ O POST SEMPRE ACEITOU `parent_id`; o PUT NUNCA — ele nem estava na
    // desestruturação, então o campo era descartado em SILÊNCIO. E o modal
    // MOSTRA o seletor "É subcategoria de" na edição, então a pessoa escolhe,
    // salva, e nada acontece. Mesma família do `is_reserva_emergencia` da
    // migration 147, que também era jogado fora por uma whitelist.
    //
    // `'parent_id' in req.body` e não `if (parent_id)`: mandar `null` é como
    // se TIRA a categoria de baixo do pai, e um `if` truthy descartaria isso.
    if ('parent_id' in req.body) {
      const novoPai = parent_id || null;

      if (novoPai === req.params.id) {
        return res.status(400).json({ erro: 'Uma categoria não pode ser subcategoria dela mesma.' });
      }

      if (novoPai) {
        // ⚠️ A TAXONOMIA TEM DOIS NÍVEIS, e as duas checagens abaixo são o que
        // impede um terceiro. Um neto quebraria o `nomesDoLimite` (que soma a
        // categoria + as filhas DIRETAS, um nível só), a árvore do painel e o
        // categorizador. Ver "Categorias v3" no CLAUDE.md.
        const { data: pai } = await supabase.from('categorias')
          .select('id, parent_id').eq('id', novoPai).eq('grupo_id', grupoId).maybeSingle();
        if (!pai) {
          return res.status(400).json({ erro: 'Categoria de destino não encontrada.' });
        }
        if (pai.parent_id) {
          return res.status(400).json({
            erro: 'Essa categoria já é uma subcategoria. Escolha uma categoria principal.',
          });
        }
        const { count: filhas } = await supabase.from('categorias')
          .select('id', { count: 'exact', head: true })
          .eq('parent_id', req.params.id).eq('grupo_id', grupoId);
        if ((filhas || 0) > 0) {
          return res.status(400).json({
            erro: `Esta categoria tem ${filhas} subcategoria(s). Mova-as antes de transformá-la em subcategoria.`,
          });
        }
      }
      patch.parent_id = novoPai;
    }

    // ⚠️ O ERRO É LIDO. Era `const { data } = await ...` sem `error`: uma falha
    // devolvia `data` null com HTTP 200, e o painel fechava o modal dizendo que
    // salvou. Mesma família dos bugs das migrations 121 e 147.
    const { data, error } = await supabase.from('categorias')
      .update(patch).eq('id', req.params.id).eq('grupo_id', grupoId).select().single();
    if (error) return res.status(500).json({ erro: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await supabase.from('categorias').update({ ativa: false })
      .eq('id', req.params.id).eq('grupo_id', req.authUser?.grupoAtivo || '__nenhum__');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Restaura categorias padrão para o grupo do usuário (chama RPC criar_categorias_padrao)
router.post('/restaurar-padrao/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo ativo não encontrado para este telefone.' });

    const { error: rpcErr } = await supabase.rpc('criar_categorias_padrao', { p_grupo_id: grupoId });
    if (rpcErr) return res.status(500).json({ erro: `Falha na função criar_categorias_padrao: ${rpcErr.message}` });

    const { data: categorias } = await supabase.from('categorias')
      .select('*').eq('grupo_id', grupoId).eq('ativa', true);

    res.json({ ok: true, total: categorias?.length || 0 });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;