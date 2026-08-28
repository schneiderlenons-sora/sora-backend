const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { enviarTexto, enviarImagem } = require('../services/mensageiro');
const { provedor } = require('../services/proativo');
const whatsapp = require('../services/whatsapp');
const { salvarAnexo, assinarLista } = require('../services/bugAnexo');

// WhatsApp que recebe os relatos (configurável; fallback = suporte da Sora).
const SUPORTE_PHONE = (process.env.SUPORTE_PHONE || '5532999167475').replace(/\D/g, '');

// =====================================================================
// POST /api/bug
// Recebe um relato de bug do usuário logado, guarda no histórico
// (bug_reports) e encaminha pro WhatsApp de suporte.
//
// Body: { mensagem: string, imagem?: string (data URI base64, opcional) }
// =====================================================================
router.post('/', auth, async (req, res) => {
  try {
    const user_id = req.authUser?.id;
    const mensagem = (req.body?.mensagem || '').trim();
    const imagem   = req.body?.imagem;
    const tipo     = req.body?.tipo === 'melhoria' ? 'melhoria' : 'problema';
    const ehMelhoria = tipo === 'melhoria';

    if (!mensagem) {
      return res.status(400).json({ erro: ehMelhoria ? 'Escreva sua sugestão antes de enviar.' : 'Descreva o problema antes de enviar.' });
    }
    if (mensagem.length > 4000) {
      return res.status(400).json({ erro: 'Mensagem muito longa (máx. 4000 caracteres).' });
    }

    const temImagem = typeof imagem === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(imagem);

    // Contexto do usuário pra facilitar o atendimento.
    let nome = null, phone = null, email = null, plano = null;
    if (user_id) {
      const { data: u } = await supabase
        .from('users').select('name, phone, email, plano')
        .eq('id', user_id).maybeSingle();
      nome = u?.name; phone = u?.phone; email = u?.email; plano = u?.plano;
    }

    // 1) Histórico (backup — não depende do WhatsApp entregar).
    // Insert tolerante à coluna `tipo` ausente (pré-migration 053): refaz sem.
    let id = null;
    try {
      const base = { user_id, nome, phone, email, mensagem, tem_imagem: temImagem };
      let { data: row, error } = await supabase.from('bug_reports').insert({ ...base, tipo }).select('id').single();
      if (error) ({ data: row } = await supabase.from('bug_reports').insert(base).select('id').single());
      id = row?.id || null;

      // ⚠️ O PRINT PASSA A SER GUARDADO (migration 143). Antes ele ia pro
      // WhatsApp e era DESCARTADO — só sobrava o booleano `tem_imagem`, e o
      // admin abria o relato no painel sem a imagem que o cliente anexou.
      // Tolerante: sem a migration o update falha e o relato segue como antes.
      if (id && temImagem) {
        const caminho = await salvarAnexo(imagem, id);
        if (caminho) {
          try { await supabase.from('bug_reports').update({ imagem_path: caminho }).eq('id', id); }
          catch { /* coluna imagem_path pode não existir ainda */ }
        }
      }
    } catch (e) {
      console.warn('[/api/bug] insert falhou (segue pro WhatsApp):', e.message);
    }

    // 2) Notifica o suporte no WhatsApp.
    // O relato é PROATIVO (o bot inicia a conversa com o número de suporte). Na
    // Cloud API (meta), FORA da janela de 24h só TEMPLATE aprovado é entregue —
    // por isso texto/imagem livres não chegavam (a Meta bloqueia e o erro some).
    // Meta → template `novo_relato` (header de IMAGEM = print; sem print, a capa;
    //        corpo {{1}} = detalhes). Z-API não tem janela → manda rico direto.
    const cabecalho = [
      ehMelhoria ? '💡 *Nova sugestão de melhoria*' : '🐞 *Novo relato de bug*',
      '',
      `👤 ${nome || '—'}${phone ? ` · ${phone}` : ''}`,
      email ? `✉️ ${email}` : null,
      `💳 plano: ${plano || '—'}`,
      id ? `🆔 ${id.slice(0, 8)}` : null,
      '',
      `📝 ${mensagem}`,
    ].filter(Boolean).join('\n');

    try {
      if (provedor() === 'meta') {
        // corpo do template ({{1}}) — LINHA ÚNICA: a Meta rejeita parâmetro com
        // quebra de linha/tab. Junta com " • " e remove \n do texto do usuário.
        const detalhes = [
          ehMelhoria ? '💡 Sugestão de melhoria' : '🐞 Relato de bug',
          `👤 ${nome || '—'}${phone ? ` · ${phone}` : ''}`,
          email ? `✉️ ${email}` : null,
          `💳 ${plano || '—'}${id ? ` · 🆔 ${id.slice(0, 8)}` : ''}`,
          `📝 ${mensagem}`,
        ].filter(Boolean).join('  •  ').replace(/\s*[\r\n\t]+\s*/g, ' ').slice(0, 900);

        // header de imagem: o print (upload → media id) OU a capa da Sora.
        let headerImage = process.env.SORA_CAPA_URL
          || `${process.env.APP_URL || 'https://forsora.com'}/sora-capa.png`;
        if (temImagem) {
          try {
            const mid = await whatsapp.uploadImagemDataUri(imagem);
            if (mid) headerImage = mid;
          } catch (e) { console.warn('[/api/bug] upload do print falhou:', e.message); }
        }
        await whatsapp.enviarTemplate(SUPORTE_PHONE, 'novo_relato', [detalhes], 'pt_BR', { headerImage });
      } else if (temImagem) {
        await enviarImagem(SUPORTE_PHONE, imagem, cabecalho);
      } else {
        await enviarTexto(SUPORTE_PHONE, cabecalho);
      }
    } catch (e) {
      console.warn('[/api/bug] notificação WhatsApp falhou:', e.message);
    }

    res.json({ ok: true, id });
  } catch (err) {
    console.error('[/api/bug] erro:', err);
    res.status(500).json({ erro: 'Não consegui enviar seu relato agora. Tente de novo em instantes.' });
  }
});

// =====================================================================
// CHAMADOS — a conversa entre o usuário e o suporte DENTRO do painel.
//
// Antes disto o relato era mão única: o usuário escrevia, caía no WhatsApp do
// suporte e acabava ali. A resposta do admin não ficava salva em lugar nenhum
// e o usuário não tinha como responder sem abrir outro relato do zero.
// =====================================================================

/** Chamados do usuário logado, com o que ele ainda não leu. */
router.get('/meus', auth, async (req, res) => {
  try {
    const user_id = req.authUser?.id;
    if (!user_id) return res.json({ chamados: [] });

    const { data: rel } = await supabase.from('bug_reports')
      .select('id, mensagem, tipo, status, created_at, tem_imagem')
      .eq('user_id', user_id).order('created_at', { ascending: false }).limit(50);

    const ids = (rel || []).map((r) => r.id);
    const naoLidas = {};
    const ultima = {};
    if (ids.length) {
      try {
        const { data: msgs } = await supabase.from('bug_mensagens')
          .select('bug_id, autor, texto, lida_em, created_at')
          .in('bug_id', ids).order('created_at', { ascending: true });
        for (const m of msgs || []) {
          // "Não lida" aqui é do ponto de vista do USUÁRIO: escrita pelo
          // suporte e ainda sem `lida_em`.
          if (m.autor === 'suporte' && !m.lida_em) naoLidas[m.bug_id] = (naoLidas[m.bug_id] || 0) + 1;
          ultima[m.bug_id] = m;
        }
      } catch { /* migration 143 pendente — a lista funciona sem a thread */ }
    }

    res.json({
      chamados: (rel || []).map((r) => ({
        ...r,
        nao_lidas: naoLidas[r.id] || 0,
        ultima_msg: ultima[r.id]
          ? { autor: ultima[r.id].autor, texto: ultima[r.id].texto, created_at: ultima[r.id].created_at }
          : null,
      })),
    });
  } catch (e) {
    console.error('[/api/bug/meus]', e.message);
    res.json({ chamados: [] });
  }
});

/** Conversa de um chamado. Marca como lidas as mensagens do suporte. */
router.get('/:id/mensagens', auth, async (req, res) => {
  try {
    const user_id = req.authUser?.id;
    const { id } = req.params;

    // ⚠️ ANTI-IDOR: o chamado tem de ser DESTE usuário. Sem esta checagem
    // qualquer um leria o chamado de qualquer outro trocando o id na URL — e
    // chamado de suporte carrega print de extrato.
    const { data: rel } = await supabase.from('bug_reports')
      .select('id, user_id, mensagem, tipo, status, created_at, imagem_path')
      .eq('id', id).maybeSingle();
    if (!rel || rel.user_id !== user_id) return res.status(404).json({ erro: 'Chamado não encontrado.' });

    let msgs = [];
    try {
      const { data } = await supabase.from('bug_mensagens')
        .select('*').eq('bug_id', id).order('created_at', { ascending: true });
      msgs = data || [];
      // Quem está lendo agora é o usuário → marca as do SUPORTE como lidas.
      const pendentes = msgs.filter((m) => m.autor === 'suporte' && !m.lida_em).map((m) => m.id);
      if (pendentes.length) {
        await supabase.from('bug_mensagens')
          .update({ lida_em: new Date().toISOString() }).in('id', pendentes);
      }
    } catch { /* migration 143 pendente */ }

    const urls = await assinarLista([rel.imagem_path, ...msgs.map((m) => m.imagem_path)]);
    res.json({
      chamado: { ...rel, imagem_url: urls[rel.imagem_path] || null },
      mensagens: msgs.map((m) => ({
        id: m.id, autor: m.autor, texto: m.texto, created_at: m.created_at,
        imagem_url: urls[m.imagem_path] || null,
      })),
    });
  } catch (e) {
    console.error('[/api/bug/:id/mensagens]', e.message);
    res.status(500).json({ erro: 'Não consegui carregar o chamado.' });
  }
});

/** Usuário responde no chamado. Avisa o suporte no WhatsApp. */
router.post('/:id/mensagens', auth, async (req, res) => {
  try {
    const user_id = req.authUser?.id;
    const { id } = req.params;
    const texto = (req.body?.texto || '').trim();
    const imagem = req.body?.imagem;
    if (!texto) return res.status(400).json({ erro: 'Escreva sua mensagem.' });
    if (texto.length > 4000) return res.status(400).json({ erro: 'Mensagem muito longa (máx. 4000 caracteres).' });

    const { data: rel } = await supabase.from('bug_reports')
      .select('id, user_id, nome, status').eq('id', id).maybeSingle();
    if (!rel || rel.user_id !== user_id) return res.status(404).json({ erro: 'Chamado não encontrado.' });

    // Chamado resolvido teve a conversa apagada — responder aqui criaria uma
    // thread solta, sem o contexto que foi limpo. A pessoa abre um relato novo.
    if (rel.status === 'resolvido') {
      return res.status(409).json({ erro: 'Este chamado já foi encerrado. Abra um novo relato que a gente continua daí.' });
    }

    const caminho = imagem ? await salvarAnexo(imagem, id) : null;
    const { data: msg, error } = await supabase.from('bug_mensagens').insert({
      bug_id: id, autor: 'usuario', autor_id: user_id, texto, imagem_path: caminho,
    }).select('id, created_at').single();
    if (error) {
      console.error('[/api/bug] insert mensagem:', error.message);
      return res.status(500).json({ erro: 'Não consegui enviar sua mensagem.' });
    }

    // O suporte precisa SABER que alguém respondeu — senão o chamado morre aqui,
    // esperando uma resposta que ninguém viu chegar.
    try {
      await enviarTexto(SUPORTE_PHONE,
        `💬 *Resposta no chamado* ${String(id).slice(0, 8)}\n\n`
        + `👤 ${rel.nome || '—'}\n\n📝 ${texto}`
        + (caminho ? '\n\n📎 (com anexo — veja no painel)' : ''));
    } catch (e) { console.warn('[/api/bug] aviso ao suporte falhou:', e.message); }

    res.json({ ok: true, id: msg?.id, created_at: msg?.created_at });
  } catch (e) {
    console.error('[/api/bug/:id/mensagens POST]', e.message);
    res.status(500).json({ erro: 'Não consegui enviar sua mensagem.' });
  }
});

module.exports = router;
