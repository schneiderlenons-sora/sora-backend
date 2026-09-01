// ─────────────────────────────────────────────────────────────────
// Regras de categoria do grupo — a TELA do motor que já existia.
//
// O motor (services/regrasCategoria + migration 104) roda desde sempre e está
// ligado em tudo: sync do Open Finance (Pluggy/Polp/Celcoin), import de OFX e
// lançamento pelo WhatsApp. O que nunca existiu foi um jeito de VER o que está
// valendo — a regra só nascia por um toggle desligado por padrão, escondido
// dentro do modal de edição de transação.
//
// Resultado medido antes de escrever isto: ZERO regras na base inteira, e ao
// mesmo tempo 69 descrições repetindo 3+ vezes paradas em "Outros" (118x
// "compra elo debito vista", 71x "ott grafica"…). A dor existia, o motor
// existia, e os dois nunca se encontraram.
//
// ⚠️ NÃO HÁ POST AQUI, de propósito. Criar regra continua sendo consequência de
// corrigir uma transação (`PUT /api/transacoes/:id` com `aplicar_todas`), que é
// onde a pessoa tem o contexto pra decidir. Um "criar regra do zero" pediria
// que ela adivinhasse qual pedaço da descrição casa — exatamente o formulário
// que fica vazio. Esta rota é pra VER, TROCAR A CATEGORIA e APAGAR.
// ─────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const {
  listarRegras, atualizarRegra, removerRegraPorId,
} = require('../services/regrasCategoria');

async function getGrupoId(req) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('id', req.authUser?.id || '__none__').single();
  return data?.grupo_ativo || null;
}

// GET /api/regras/:phone — as regras do grupo, com quantos lançamentos cada
// uma alcança hoje. A contagem é o que dá sentido à linha: "ott grafica → Casa"
// não diz nada; "ott grafica → Casa · 71 lançamentos" diz.
router.get('/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const regras = await listarRegras(grupoId);
    if (!regras.length) return res.json([]);

    // Uma leitura só do grupo e a contagem em memória — o mesmo motivo de
    // `aplicarRegrasEmLote` não ir ao banco por linha.
    //
    // ⚠️ Só `observacao` e `categoria`: é uma tela de gestão, não precisa da
    // transação inteira (e egress é cota escassa aqui).
    const { data: txs } = await supabase.from('transacoes')
      .select('observacao, categoria').eq('grupo_id', grupoId);

    const { normalizar } = require('../services/regrasCategoria');
    const alvos = (txs || []).map((t) => ({
      alvo: normalizar(t.observacao), categoria: t.categoria,
    })).filter((t) => t.alvo);

    const comUso = regras.map((r) => {
      const termo = normalizar(r.termo);
      // MESMO casamento do motor (`categoriaPorRegra`) — se divergir, a tela
      // promete um número que a importação não cumpre.
      const casam = alvos.filter((t) =>
        t.alvo === termo || t.alvo.includes(termo) || termo.includes(t.alvo));
      return {
        ...r,
        lancamentos: casam.length,
        // Quantos ainda NÃO estão na categoria da regra: é o que a próxima
        // importação (ou uma reaplicação) mudaria.
        fora: casam.filter((t) => t.categoria !== r.categoria).length,
      };
    });

    res.json(comUso);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/regras/:id  { categoria }
router.put('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const categoria = String(req.body?.categoria || '').trim();
    if (!categoria) return res.status(400).json({ erro: 'Informe a categoria.' });

    const regra = await atualizarRegra({ grupoId, id: req.params.id, categoria });
    if (!regra) return res.status(404).json({ erro: 'Regra não encontrada.' });
    res.json(regra);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/regras/:id
//
// ⚠️ Apagar a regra NÃO desfaz as transações que ela já categorizou — elas
// ficam como estão. Desfazer em massa seria destrutivo e silencioso: a pessoa
// pode ter corrigido linhas à mão depois. A tela diz isso em vez de a gente
// adivinhar.
router.delete('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    await removerRegraPorId({ grupoId, id: req.params.id });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
