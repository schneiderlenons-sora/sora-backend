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

const PLANOS_VALIDOS = ['inativo', 'basico', 'kit', 'premium', 'platinum'];

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

// Acha o usuário pelo telefone COM e SEM o 9º dígito.
//
// ⚠️ Bug real: o teste do comunicado buscava por igualdade exata. Toda a base
// está com 13 dígitos (55+DDD+9+8), então digitar o número sem o 9 não achava
// ninguém e a mensagem saía "Oi, tudo bem!" em vez do nome — parecendo cadastro
// sem nome, quando na verdade não há UM usuário sem nome na base.
function variantesPhone(p) {
  const fone = String(p || '').replace(/\D/g, '');
  const v = [fone];
  if (fone.length === 13 && fone.startsWith('55')) v.push(fone.slice(0, 4) + fone.slice(5));
  if (fone.length === 12 && fone.startsWith('55')) v.push(fone.slice(0, 4) + '9' + fone.slice(4));
  return v;
}

async function acharPorTelefone(phone) {
  const { data } = await supabase.from('users')
    .select('name, phone').in('phone', variantesPhone(phone)).limit(1);
  return data?.[0] || null;
}

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
// Usa o template `atualizacao_sora` (ver TEMPLATE_COMUNICADO abaixo), com a capa
// de comunicado. São DOIS parâmetros: {{1}} = primeiro nome de quem recebe (por
// isso o disparo busca o `name` junto com o telefone) e {{2}} = o texto do aviso.
//   · teste=<phone>  → manda 1 mensagem e retorna o resultado na hora (síncrono).
//   · dryRun         → só CONTA quantos receberiam (não envia).
//   · senão          → dispara em BACKGROUND (Render aguenta o loop) e responde já.
// Template do comunicado em massa: `atualizacao_sora` (APROVADO na Meta em
// jul/2026) — "Oi, {{1}}! Uma atualização da Sora pra você: {{2}}".
//
// Antes caía no `comunicado_sora`, que é de RESPOSTA A RELATO ("…sobre o que
// você nos enviou: …") e soava errado num aviso em massa — quem não tinha
// relatado nada recebia uma resposta a algo que nunca escreveu.
//
// Os params são os MESMOS dos dois modelos de propósito ({{1}} nome, {{2}}
// texto): trocar de template é trocar o nome, nunca mexer no disparo.
// A env continua valendo pra voltar atrás sem deploy, se a Meta pausar o modelo.
const TEMPLATE_COMUNICADO = process.env.WHATSAPP_TPL_COMUNICADO || 'atualizacao_sora';

// ── PARÁGRAFOS ───────────────────────────────────────────────────────────────
// A Cloud API NÃO aceita \n dentro de um parâmetro de template — o texto todo
// chega grudado numa linha só, o que fica ilegível num aviso comprido.
//
// A saída é ter uma variável POR PARÁGRAFO, com as quebras no corpo FIXO do
// template (que aceita \n normalmente). Como a Meta também rejeita parâmetro
// VAZIO, não dá pra ter um template de 3 parágrafos e mandar 1 — por isso
// existe um modelo por quantidade:
//
//   1 parágrafo  → atualizacao_sora     ({{2}})
//   2 parágrafos → atualizacao_sora_2   ({{2}} {{3}})
//   3 ou mais    → atualizacao_sora_3   ({{2}} {{3}} {{4}}, o resto junto no 4)
//
// Se o modelo da quantidade ainda não estiver aprovado, o envio falha e o
// disparo CAI SOZINHO pro de 1 parágrafo (texto em linha única) — nunca fica
// sem enviar. Ver docs/MIGRACAO-WHATSAPP-TEMPLATES.md.
const MAX_PARAGRAFOS = 3;

function paragrafosDe(texto) {
  return String(texto || '')
    .split(/\n\s*\n+/)                    // linha em branco separa parágrafo
    .map((p) => oneLine(p))               // dentro do parágrafo, quebra vira espaço
    .filter(Boolean);
}

/** Monta o template pra N parágrafos (1 = o modelo de sempre). */
function TPL_BROADCAST(texto, nome, nParagrafos = 1) {
  const partes = paragrafosDe(texto);
  const n = Math.min(Math.max(1, nParagrafos), MAX_PARAGRAFOS);

  if (n <= 1 || partes.length <= 1) {
    return {
      name: TEMPLATE_COMUNICADO,
      params: [primeiroNome(nome), oneLine(texto)],
      opts: { headerImage: CAPA_COMUNICADO() },
    };
  }

  // Sobra vai toda pro último parágrafo — melhor um bloco maior no fim do que
  // perder texto ou mandar parâmetro vazio (que a Meta recusa).
  const blocos = partes.slice(0, n - 1);
  blocos.push(oneLine(partes.slice(n - 1).join(' ')));

  return {
    name: `${TEMPLATE_COMUNICADO}_${n}`,
    params: [primeiroNome(nome), ...blocos],
    opts: { headerImage: CAPA_COMUNICADO() },
  };
}

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
    // o template abre com "Oi, {{1}}!" e um teste com nome genérico
    // esconderia justamente a saudação que todo mundo vai receber.
    const quem = await acharPorTelefone(teste);

    const antes = Date.now();
    const nPar = paragrafosDe(texto).length;
    let usados = Math.min(nPar, MAX_PARAGRAFOS);
    await enviarProativo(teste, { texto, template: TPL_BROADCAST(texto, quem?.name, usados) });
    let err = getLastSendError();
    let falhou = err && new Date(err.em).getTime() >= antes;

    // Modelo com N parágrafos ainda não aprovado → manda em linha única em vez
    // de deixar o comunicado sem sair.
    if (falhou && usados > 1) {
      const antes2 = Date.now();
      usados = 1;
      await enviarProativo(teste, { texto, template: TPL_BROADCAST(texto, quem?.name, 1) });
      err = getLastSendError();
      falhou = err && new Date(err.em).getTime() >= antes2;
    }

    if (falhou) return res.json({ ok: false, code: err.code, erro: err.message });
    return res.json({
      ok: true, teste: true, paragrafos: usados, nome: quem?.name || null,
      // O painel avisa quando o texto foi achatado — sem isso o admin dispara
      // pra base inteira achando que os parágrafos saíram.
      aviso: (nPar > 1 && usados === 1)
        ? `O modelo de ${Math.min(nPar, MAX_PARAGRAFOS)} parágrafos ainda não está aprovado na Meta — a mensagem saiu em linha única.`
        : null,
    });
  }

  if (!planos.length) return res.status(400).json({ erro: 'Selecione ao menos um plano.' });

  // Destinatários: usuários com telefone e plano no filtro (dedup por número).
  // `apenasRecorrentes` corta o VITALÍCIO — ele tem plano='premium' no banco
  // (29 contas), então filtrar só por plano mandaria aviso de recurso de
  // assinatura pra quem não tem assinatura. Ex.: o comunicado do Open Finance.
  const apenasRecorrentes = !!req.body?.apenasRecorrentes;
  // `name` entra aqui porque o template abre com "Oi, {{1}}!".
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
    // Quantos parágrafos usar. Se o modelo não estiver aprovado, o PRIMEIRO
    // envio descobre e todo o resto já vai em linha única — não adianta insistir
    // 73 vezes num template que a Meta não conhece.
    let nPar = Math.min(paragrafosDe(texto).length, MAX_PARAGRAFOS);
    for (const phone of alvos) {
      try {
        const antes = Date.now();
        await enviarProativo(phone, { texto, template: TPL_BROADCAST(texto, porFone.get(phone), nPar) });
        const err = getLastSendError();
        if (err && new Date(err.em).getTime() >= antes && nPar > 1) {
          nPar = 1;
          await enviarProativo(phone, { texto, template: TPL_BROADCAST(texto, porFone.get(phone), 1) });
          console.warn('[admin/broadcast] modelo com parágrafos indisponível — seguindo em linha única');
        }
        ok++;
      }
      catch { fail++; }
      await new Promise((r) => setTimeout(r, 150)); // throttle (~6/s) pra não estourar a Meta
    }
    console.log(`[admin/broadcast] enviados=${ok} falhas=${fail} total=${alvos.length} planos=${planos.join(',')}`);
  })().catch((e) => console.error('[admin/broadcast] erro no loop:', e && e.message));
});

module.exports = router;
