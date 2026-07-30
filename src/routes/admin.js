// ─────────────────────────────────────────────────────────────────
// Admin (server-to-server) — chamado SÓ pelo painel admin do Next.js (que já
// valida checkAdmin). Autenticado por SECRET interno (x-admin-secret) porque o
// auth normal amarra o request ao telefone do próprio usuário (anti-IDOR).
//
// Env: ADMIN_SECRET (mesmo valor no Render e na Vercel).
// ─────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const supabase = require('../db/supabase');
const { enviarProativo } = require('../services/proativo');
const { getLastSendError } = require('../services/whatsapp');

const PLANOS_VALIDOS = ['inativo', 'basico', 'kit', 'premium', 'black'];

const oneLine = (s) => String(s || '').replace(/\s*[\r\n\t]+\s*/g, ' ').trim();
const CAPA = () => process.env.SORA_CAPA_URL
  || `${(process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://www.forsora.com').replace(/\/$/, '')}/sora-capa.png`;

// Template de RESPOSTA AO RELATO: `comunicado_sora` — corpo:
//   "Oi, {{1}}! ... sobre o que você nos enviou: {{2}}. ..."
//   {{1}} = nome do cliente · {{2}} = a resposta do admin.
// ⚠️ Precisa estar APROVADO na Meta; enquanto "em análise", o envio falha.
// Header de imagem: COMUNICADO_CAPA_URL (a capa "Comunicado Sora") — cai na
// capa genérica da Sora se não setar.
const TEMPLATE_RESPOSTA = 'comunicado_sora';
const CAPA_COMUNICADO = () => process.env.COMUNICADO_CAPA_URL || CAPA();

// {{1}} do comunicado_sora. Fallback amigável pra nunca sair "Oi, !" — quem não
// tem nome cadastrado recebe "Oi, tudo bem!", que continua lendo natural.
const primeiroNome = (n) => (oneLine(n || '').split(' ')[0] || 'tudo bem').slice(0, 60);

// POST /api/admin/responder-relato  { phone, nome, texto }
router.post('/responder-relato', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ erro: 'ADMIN_SECRET não configurado no servidor.' });
  if (req.headers['x-admin-secret'] !== secret) return res.status(403).json({ erro: 'nao_autorizado' });

  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  const texto = String(req.body?.texto || '').trim();
  if (!phone || !texto) return res.status(400).json({ erro: 'phone e texto são obrigatórios' });
  const nome = primeiroNome(req.body?.nome);

  const antes = Date.now();
  // Com WHATSAPP_PROVIDER=meta vai o TEMPLATE (entrega dentro E fora das 24h).
  await enviarProativo(phone, {
    texto, // fallback (Z-API / dentro da janela)
    template: { name: TEMPLATE_RESPOSTA, params: [nome, oneLine(texto)], opts: { headerImage: CAPA_COMUNICADO() } },
  });

  const err = getLastSendError();
  if (err && new Date(err.em).getTime() >= antes) {
    return res.json({ ok: false, code: err.code, erro: err.message });
  }
  res.json({ ok: true });
});

// ── COMUNICADO EM MASSA ──────────────────────────────────────────────────────
// POST /api/admin/broadcast  { texto, planos[], teste?, dryRun?, apenasRecorrentes? }
// Usa o template `comunicado_sora` — o mesmo da resposta a relato, com a capa de
// comunicado. São DOIS parâmetros: {{1}} = primeiro nome de quem recebe (por isso
// o disparo busca o `name` junto com o telefone) e {{2}} = o texto do aviso.
//   · teste=<phone>  → manda 1 mensagem e retorna o resultado na hora (síncrono).
//   · dryRun         → só CONTA quantos receberiam (não envia).
//   · senão          → dispara em BACKGROUND (Render aguenta o loop) e responde já.
// Nome do template do comunicado. Configurável por env pra trocar assim que a
// Meta aprovar um modelo novo, SEM esperar deploy — o `comunicado_sora` é de
// resposta a relato ("sobre o que você nos enviou"), que não cabe num aviso em
// massa. O modelo novo tem de manter os MESMOS params: {{1}} nome, {{2}} texto.
const TEMPLATE_COMUNICADO = process.env.WHATSAPP_TPL_COMUNICADO || TEMPLATE_RESPOSTA;

const TPL_BROADCAST = (texto, nome) => ({
  name: TEMPLATE_COMUNICADO,
  params: [primeiroNome(nome), oneLine(texto)],
  opts: { headerImage: CAPA_COMUNICADO() },
});

router.post('/broadcast', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ erro: 'ADMIN_SECRET não configurado no servidor.' });
  if (req.headers['x-admin-secret'] !== secret) return res.status(403).json({ erro: 'nao_autorizado' });

  const texto  = String(req.body?.texto || '').trim();
  const teste  = String(req.body?.teste || '').replace(/\D/g, '');
  const dryRun = !!req.body?.dryRun;
  const planos = Array.isArray(req.body?.planos)
    ? req.body.planos.filter((p) => PLANOS_VALIDOS.includes(p))
    : [];

  // Teste: manda pra 1 número e devolve ok/erro na hora (pra validar antes do disparo).
  if (teste) {
    if (!texto) return res.status(400).json({ erro: 'Escreva a mensagem.' });
    if (teste.length < 10) return res.status(400).json({ erro: 'Número de teste inválido.' });
    // Busca o nome do número de teste pra o teste sair IGUAL ao disparo real —
    // o comunicado_sora abre com "Oi, {{1}}!" e um teste com nome genérico
    // esconderia justamente a saudação que todo mundo vai receber.
    const { data: quem } = await supabase.from('users')
      .select('name').eq('phone', teste).maybeSingle();

    const antes = Date.now();
    await enviarProativo(teste, { texto, template: TPL_BROADCAST(texto, quem?.name) });
    const err = getLastSendError();
    if (err && new Date(err.em).getTime() >= antes) return res.json({ ok: false, code: err.code, erro: err.message });
    return res.json({ ok: true, teste: true });
  }

  if (!planos.length) return res.status(400).json({ erro: 'Selecione ao menos um plano.' });

  // Destinatários: usuários com telefone e plano no filtro (dedup por número).
  // `apenasRecorrentes` corta o VITALÍCIO — ele tem plano='premium' no banco
  // (29 contas), então filtrar só por plano mandaria aviso de recurso de
  // assinatura pra quem não tem assinatura. Ex.: o comunicado do Open Finance.
  const apenasRecorrentes = !!req.body?.apenasRecorrentes;
  // `name` entra aqui porque o comunicado_sora abre com "Oi, {{1}}!".
  let q = supabase.from('users').select('phone, name').in('plano', planos).not('phone', 'is', null);
  if (apenasRecorrentes) q = q.or('vitalicio.is.null,vitalicio.eq.false');
  const { data: rows, error } = await q;
  if (error) return res.status(500).json({ erro: error.message });
  // Dedup por número; o 1º registro do número define o nome usado na saudação.
  const porFone = new Map();
  for (const u of rows || []) {
    const p = String(u.phone || '').replace(/\D/g, '');
    if (p.length >= 10 && !porFone.has(p)) porFone.set(p, u.name || '');
  }
  const alvos = [...porFone.keys()];

  if (dryRun) return res.json({ ok: true, total: alvos.length });
  if (!texto) return res.status(400).json({ erro: 'Escreva a mensagem.' });

  // Dispara em BACKGROUND — a resposta volta na hora e o loop segue no Render.
  res.json({ ok: true, iniciado: true, total: alvos.length });
  (async () => {
    let ok = 0, fail = 0;
    for (const phone of alvos) {
      try { await enviarProativo(phone, { texto, template: TPL_BROADCAST(texto, porFone.get(phone)) }); ok++; }
      catch { fail++; }
      await new Promise((r) => setTimeout(r, 150)); // throttle (~6/s) pra não estourar a Meta
    }
    console.log(`[admin/broadcast] enviados=${ok} falhas=${fail} total=${alvos.length} planos=${planos.join(',')}`);
  })().catch((e) => console.error('[admin/broadcast] erro no loop:', e && e.message));
});

module.exports = router;
