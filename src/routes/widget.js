// ─────────────────────────────────────────────────────────────────────────────
// /api/widget — os widgets do iPhone e do Android (fase 2, migration 201).
//
//   POST   /codigo          (login do painel) código de conexão, uso único, 5 min
//   POST   /token           (sem login)       troca o código pela chave do aparelho
//   GET    /resumo          (chave do widget) o retrato dos widgets
//   GET    /aparelhos       (login do painel) aparelhos conectados
//   DELETE /aparelhos/:id   (login do painel) desconecta um aparelho
//
// ⚠️ O CUSTO MORA NO /resumo, e foi desenhado pra ser barato (medido antes):
// o aparelho pergunta a cada hora; cada pergunta custa UMA ida ao banco
// (`widget_contexto`, ~1 KB), que devolve a versão do grupo. O retrato
// (12–14 idas) só é refeito quando a versão muda — o banco a aumenta quando
// algo que o widget mostra muda — ou quando vira o dia. `If-None-Match` igual
// → 304, sem corpo nenhum.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const auth = require('../middlewares/auth');
const chave = require('../services/widgetChave');
const { acessoWidget } = require('../config/widgets');
const { lerDados, montarResumo, FORMATO } = require('../services/widgetResumo');
const { hojeSP } = require('../services/vencimentoDivida');

// Retrato pronto por conta: { etag, corpo }. Some num restart — aí só custa
// refazer uma vez.
const cache = new Map();
const MAX_CACHE = 3000;
const guardar = (userId, item) => {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(userId, item);
};

/** Erro de migration pendente vira "ainda sendo liberado" (sem jargão pro cliente). */
const faltaMigration = (e) => /widget_|grupo_versao|does not exist|schema cache/i.test(String(e && e.message));

router.post('/codigo', auth, async (req, res) => {
  try {
    const userId = req.authUser && req.authUser.id;
    if (!userId) return res.status(401).json({ erro: 'Não autenticado' });
    const { data: u } = await supabase.from('users')
      .select('email, plano, vitalicio, stripe_subscription_id, plano_fonte, plano_valido_ate')
      .eq('id', userId).maybeSingle();
    const acesso = acessoWidget(u && { ...u, assinatura_stripe: !!u.stripe_subscription_id });
    if (!acesso.ok) return res.status(403).json({ erro: 'Os widgets não fazem parte do seu plano.', motivo: acesso.motivo });
    res.json(await chave.criarCodigo(supabase, userId));
  } catch (err) {
    if (faltaMigration(err)) {
      console.warn('[widget] /codigo sem a migration 201:', err.message);
      return res.status(503).json({ erro: 'Os widgets ainda estão sendo liberados. Tente de novo mais tarde.' });
    }
    res.status(500).json({ erro: 'Não consegui conectar o widget agora. Tente de novo.' });
  }
});

router.post('/token', async (req, res) => {
  try {
    const { codigo, plataforma, aparelho } = req.body || {};
    const r = await chave.trocarCodigo(supabase, { codigo, plataforma, aparelho });
    if (r.erro) {
      const status = r.erro === 'codigo_expirado' ? 410 : 400;
      return res.status(status).json({ erro: r.erro });
    }
    res.json({ chave: r.chave });
  } catch (err) {
    console.warn('[widget] /token falhou:', err.message);
    res.status(500).json({ erro: 'falha' });
  }
});

router.get('/resumo', async (req, res) => {
  try {
    const m = String(req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
    const ctx = m ? await chave.contexto(supabase, m[1]) : null;
    if (!ctx) return res.status(401).json({ formato: FORMATO, estado: 'desconectado' });

    const acesso = acessoWidget(ctx);
    if (!acesso.ok) return res.json({ formato: FORMATO, estado: acesso.motivo });
    if (!ctx.grupo_id) return res.json({ formato: FORMATO, estado: 'sem_grupo' });

    const etag = `"w${FORMATO}-${ctx.grupo_id.slice(0, 8)}-${ctx.versao}-${hojeSP()}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');
    if (req.get('if-none-match') === etag) return res.status(304).end();

    const pronto = cache.get(ctx.user_id);
    if (pronto && pronto.etag === etag) return res.json(pronto.corpo);

    const dados = await lerDados(ctx.grupo_id, { metaMensal: ctx.meta_mensal });
    const corpo = { estado: 'ok', ...montarResumo(dados, { versao: etag }) };
    guardar(ctx.user_id, { etag, corpo });
    res.json(corpo);
  } catch (err) {
    if (faltaMigration(err)) {
      console.warn('[widget] /resumo sem a migration 201:', err.message);
      return res.status(503).json({ formato: FORMATO, estado: 'indisponivel' });
    }
    console.error('[widget] /resumo falhou:', err.message);
    res.status(500).json({ formato: FORMATO, estado: 'indisponivel' });
  }
});

// Lista os aparelhos E diz se a conta pode usar (a tela explica o porquê em vez
// de mostrar um botão que daria 403).
router.get('/aparelhos', auth, async (req, res) => {
  let acesso = { ok: false, motivo: 'plano' };
  try {
    const { data: u } = await supabase.from('users')
      .select('email, plano, vitalicio, stripe_subscription_id, plano_fonte, plano_valido_ate')
      .eq('id', req.authUser.id).maybeSingle();
    acesso = acessoWidget(u && { ...u, assinatura_stripe: !!u.stripe_subscription_id });
    res.json({ acesso, aparelhos: await chave.listar(supabase, req.authUser.id) });
  } catch (err) {
    if (faltaMigration(err)) return res.json({ acesso, aparelhos: [], liberando: true });
    res.status(500).json({ erro: 'Não consegui carregar os aparelhos.' });
  }
});

router.delete('/aparelhos/:id', auth, async (req, res) => {
  try {
    const ok = await chave.revogar(supabase, { conexaoId: req.params.id, userId: req.authUser.id });
    cache.delete(req.authUser.id);
    if (!ok) return res.status(404).json({ erro: 'Aparelho não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: 'Não consegui desconectar agora.' });
  }
});

module.exports = router;
module.exports._cache = cache;
