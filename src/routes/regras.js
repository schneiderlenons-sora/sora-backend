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
  salvarRegra, carregarRegras, casaRegra, aplicarNaLinha, normalizar, transacoesDoGrupo,
} = require('../services/regrasCategoria');

async function getGrupoId(req) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('id', req.authUser?.id || '__none__').single();
  return data?.grupo_ativo || null;
}

/**
 * Aplica UMA regra às transações que já existem.
 *
 * ⚠️ Reusa `aplicarNaLinha`, a MESMA função do import e dos syncs. Escrever um
 * segundo aplicador aqui faria "criar a regra" e "importar do banco" produzirem
 * resultados diferentes pro mesmo texto — divergência silenciosa.
 *
 * ⚠️ Só grava o que MUDOU, e campo a campo. Um `update` cego reescreveria a
 * observação de linhas que a pessoa já tinha renomeado à mão.
 */
async function aplicarNoHistorico(grupoId, termo) {
  const regras = await carregarRegras(grupoId);
  const regra = regras.find((r) => r.termo === normalizar(termo));
  if (!regra) return [];

  // ⚠️ `select('*')` — `ignorar_em` (146) pelo nome faria a query falhar antes
  // da migration, e aí a criação de regra pareceria não fazer nada.
  // ⚠️ Paginado (`transacoesDoGrupo`): um `select` só parava em 1.000 linhas.
  const txs = await transacoesDoGrupo(grupoId, '*');

  // Devolve QUAIS linhas mudaram, não só quantas: a tela que criou a regra a
  // partir de um lançamento precisa saber se ELE mudou — senão o "Salvar" do
  // modal, ainda aberto com a categoria antiga, grava o valor velho por cima.
  const alteradas = [];
  for (const t of txs) {
    const alvo = normalizar(t.observacao);
    // ⚠️ Só onde ESTA regra é a que vence — a mesma escolha do import
    // (`aplicarRegrasEmLote` pega a primeira que casa, na ordem exato → termo
    // mais longo). Sem isto, criar uma regra genérica reescrevia lançamentos
    // que uma regra mais específica já tinha classificado.
    if (regras.find((x) => casaRegra(alvo, x)) !== regra) continue;

    const antes = {
      categoria: t.categoria, observacao: t.observacao,
      ignorar_em: t.ignorar_em,
    };
    const depois = { ...antes };
    if (!aplicarNaLinha(depois, regra)) continue;

    const patch = {};
    for (const k of ['categoria', 'observacao', 'ignorar_em']) {
      if (depois[k] !== antes[k]) patch[k] = depois[k];
    }
    if (!Object.keys(patch).length) continue;

    let { error } = await supabase.from('transacoes').update(patch).eq('id', t.id);
    // Tolerante à 146: sem a coluna, aplica o resto e segue.
    if (error && /ignorar_em/i.test(error.message || '')) {
      const { ignorar_em: _drop, ...semIgnorar } = patch;
      if (Object.keys(semIgnorar).length) {
        ({ error } = await supabase.from('transacoes').update(semIgnorar).eq('id', t.id));
      } else { error = null; }
    }
    if (!error) alteradas.push(t.id);
  }
  return alteradas;
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
    const txs = await transacoesDoGrupo(grupoId, 'observacao, categoria');

    const alvos = txs.map((t) => ({
      alvo: normalizar(t.observacao), categoria: t.categoria,
    })).filter((t) => t.alvo);

    const comUso = regras.map((r) => {
      const termo = normalizar(r.termo);
      // ⚠️ `casaRegra`, a MESMA função do motor. Esta tela tinha uma cópia do
      // casamento que ignorava o "texto exato" e não conhecia o casamento por
      // palavras em ordem — prometia um número que a importação não cumpria.
      const casam = alvos.filter((t) => casaRegra(t.alvo, { termo, modo_match: r.modo_match }));
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

// GET /api/regras/sugestoes/:phone — o Watson propondo regra a partir do que
// se repete.
//
// ⚠️ SÓ PROPÕE, NUNCA APLICA. O usuário aceita a sugestão e cai no formulário
// já preenchido — a regra continua sendo decisão dele. Agente que reescreve
// dado sozinho é agente que o usuário desliga.
//
// A evidência é o que existe: descrições que aparecem VÁRIAS vezes e estão em
// "Outros" (ou sem categoria). Medido na base ao escrever isto: 69 descrições
// repetindo 3+ vezes em Outros — 118x "compra elo debito vista", 71x "ott
// grafica". É exatamente a dor que o motor de regras existe pra resolver.
router.get('/sugestoes/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const txs = await transacoesDoGrupo(grupoId, 'observacao, categoria, valor, tipo, data');

    // Só o que está num balde genérico: sugerir regra pra quem já está
    // categorizado seria propor mexer no que a pessoa já resolveu.
    const generica = (c) => {
      const s = String(c || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
      return !s || /^\s*(outros?|outras?|sem categoria|nao categorizado|importado)\s*$/.test(
        s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim());
    };

    const grupos = new Map();
    for (const t of txs || []) {
      if (!generica(t.categoria)) continue;
      const termo = normalizar(t.observacao);
      if (!termo || termo.length < 4) continue;   // texto curto casaria demais
      const g = grupos.get(termo) || { termo, exemplo: t.observacao, n: 0, total: 0, ultima: null };
      g.n++;
      g.total += Math.abs(Number(t.valor) || 0);
      if (!g.ultima || String(t.data) > g.ultima) g.ultima = t.data;
      grupos.set(termo, g);
    }

    // Já existe regra cobrindo? Então não é sugestão.
    const jaTem = await carregarRegras(grupoId);
    const sugestoes = [...grupos.values()]
      .filter((g) => g.n >= 3)                                  // 1 ou 2 vezes não é padrão
      .filter((g) => !jaTem.some((r) => casaRegra(g.termo, r)))
      .sort((a, b) => b.n - a.n)
      .slice(0, 20);

    res.json({ sugestoes });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/regras — CRIAR DO ZERO (a tela "Nova regra" do card do Watson).
//
// ⚠️ `bruto: true` é o ponto central desta rota. O texto vem DIGITADO pelo
// usuário, copiado da descrição como o banco escreve, então NÃO pode passar por
// `termoDe` — ele existe pra tirar ruído de maquininha ("pix", "compra",
// "pagamento", "debito"…) e destruiria justamente as frases que a pessoa
// precisa cadastrar: "PAGAMENTO DEBITO AUTOMATICO" viraria "automatico".
// Aqui só normaliza caixa e acento, que é o que a tela promete.
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const b = req.body || {};
    const descricao = String(b.descricao || '').trim();
    if (!descricao) return res.status(400).json({ erro: 'Escreva a descrição do lançamento.' });

    const tipo = b.tipo === 'ignorar' ? 'ignorar' : 'categorizar';
    if (tipo === 'categorizar' && !String(b.categoria || '').trim() && !String(b.renomear_para || '').trim()) {
      return res.status(400).json({ erro: 'Escolha uma categoria ou um novo nome.' });
    }

    const termo = await salvarRegra({
      grupoId, userId: req.userId, bruto: true,
      descricao,
      tipo,
      categoria:     String(b.categoria || '').trim() || null,
      modoMatch:     b.modo_match,
      renomearPara:  String(b.renomear_para || '').trim() || null,
      ignorarEscopo: b.ignorar_escopo,
    });
    if (!termo) return res.status(400).json({ erro: 'Não consegui montar essa regra.' });

    // Aplica no histórico que já existe, se pedirem. É o que faz a regra ter
    // efeito visível na hora, em vez de só valer pro próximo import.
    let ids = [];
    if (b.aplicar_agora !== false) {
      ids = await aplicarNoHistorico(grupoId, termo);
    }
    res.json({ ok: true, termo, atualizadas: ids.length, ids });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/regras/:id — atualiza a regra (a tela manda só o que mudou).
router.put('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const b = req.body || {};

    const regra = await atualizarRegra({
      grupoId, id: req.params.id,
      categoria:     b.categoria,
      tipo:          b.tipo,
      modoMatch:     b.modo_match,
      renomearPara:  b.renomear_para,
      ignorarEscopo: b.ignorar_escopo,
    });
    if (!regra) return res.status(404).json({ erro: 'Regra não encontrada.' });

    let ids = [];
    if (b.aplicar_agora === true) ids = await aplicarNoHistorico(grupoId, regra.termo);
    res.json({ ...regra, atualizadas: ids.length, ids });
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
