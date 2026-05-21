/**
 * Webhooks de plataformas (Hotmart, etc.) → ingerem eventos em eventos_financeiros.
 *
 * Endpoints públicos (sem x-api-token), validados por webhook_secret embutido
 * na URL: POST /webhook/negocios/hotmart/:integracao_id?secret=xxx
 *
 * Fluxo:
 *  1. Recebe payload bruto
 *  2. Valida integracao_id + secret
 *  3. Delega pro adapter (handlers/negocios)
 *  4. Devolve 200 rapidamente (Hotmart espera resposta <5s)
 */
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const { ingerirEvento } = require('../handlers/negocios');

// POST /webhook/negocios/:plataforma/:integracao_id?secret=xxx
router.post('/:plataforma/:integracao_id', async (req, res) => {
  const { plataforma, integracao_id } = req.params;
  const secret = req.query.secret || req.headers['x-webhook-secret'];

  try {
    // 1. Carrega integração
    const { data: integ, error } = await supabase
      .from('integracoes')
      .select('*')
      .eq('id', integracao_id)
      .maybeSingle();

    if (error || !integ) {
      console.warn('[webhook] integração não encontrada:', integracao_id);
      return res.status(404).json({ erro: 'Integração não encontrada' });
    }
    if (integ.plataforma !== plataforma) {
      return res.status(400).json({ erro: 'Plataforma inconsistente' });
    }
    if (integ.webhook_secret && integ.webhook_secret !== secret) {
      console.warn('[webhook] secret inválido para', integracao_id);
      return res.status(401).json({ erro: 'Secret inválido' });
    }
    if (integ.status !== 'ativa') {
      return res.status(409).json({ erro: 'Integração pausada/revogada' });
    }

    // 2. Delega ao adapter via handler
    const resultado = await ingerirEvento(integ, req.body);

    if (resultado.ignorado) {
      console.log(`[webhook ${plataforma}] ignorado: ${resultado.motivo}`);
      return res.json({ ok: true, ignorado: true });
    }

    console.log(`[webhook ${plataforma}] ✅ ${resultado.tipo} ${resultado.evento_id}`);
    res.json({ ok: true, evento_id: resultado.evento_id });
  } catch (err) {
    console.error(`[webhook ${plataforma}] erro:`, err);

    // Salva erro na integração mas devolve 200 para evitar retentativas em loop
    if (integracao_id) {
      await supabase.from('integracoes')
        .update({ ultimo_erro: err.message?.slice(0, 500), status: 'erro' })
        .eq('id', integracao_id);
    }
    res.status(500).json({ erro: err.message });
  }
});

// GET /webhook/negocios/:plataforma/:integracao_id — saúde (Hotmart faz ping)
router.get('/:plataforma/:integracao_id', async (req, res) => {
  res.json({ ok: true, plataforma: req.params.plataforma });
});

module.exports = router;
