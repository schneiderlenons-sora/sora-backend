// ─────────────────────────────────────────────────────────────────────────────
// Drive Inteligente — receber arquivos pelo WhatsApp e guardar no painel.
//
// Reaproveita a estrutura da aba "Drive" (ex-Dados Pessoais):
//   quadro "Recebidos" (raiz)  →  seção = pasta (Comprovantes, Contratos…)
//   →  item tipo 'arquivo' (baixa via URL assinada no painel).
// Bucket privado `dados-arquivos`, mesmo path do painel: {userId}/{uuid}-{nome}.
// Local-first: pasta pela legenda explícita → mapa de palavras → "Geral".
// ─────────────────────────────────────────────────────────────────────────────
const axios    = require('axios');
const crypto   = require('crypto');
const supabase = require('../db/supabase');

const BUCKET      = 'dados-arquivos';
const QUADRO_ROOT = 'Recebidos';
const MAX_BYTES   = 20 * 1024 * 1024; // 20 MB

// palavra-chave → { pasta, ícone } (sem IA)
const MAPA_PASTA = [
  [/comprovante|recibo|nota\s*fiscal|cupom/i,        'Comprovantes', '🧾'],
  [/contrato/i,                                       'Contratos',    '📑'],
  [/boleto|fatura/i,                                  'Boletos',      '💳'],
  [/holerite|contrach|sal[áa]rio|trabalho|emprego/i,  'Trabalho',     '💼'],
  [/exame|laudo|receita\s*m[ée]dica|atestado|sa[úu]de/i, 'Saúde',     '🏥'],
  [/curr[íi]culo|\bcv\b/i,                             'Currículos',   '📄'],
  [/foto|imagem|selfie|print|screenshot/i,            'Fotos',        '🖼️'],
];

const semAcento = (s = '') => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Nome pra EXIBIR — mantém acentos (compõe NFC). Ex.: "Currículo - Lenon.pdf".
function nomeExibicao(s = '') {
  return String(s).normalize('NFC').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'arquivo';
}
// Nome ASCII-seguro pro path do bucket (sem acento/espaço/símbolo).
function nomeStorage(s = '') {
  return semAcento(s).replace(/[^a-z0-9.\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 90) || 'arquivo';
}

// Extrai "…pasta X" explicitamente dito na legenda.
function pastaDaLegenda(caption = '') {
  const m = String(caption).match(/pasta\s+(?:d[aeo]s?\s+)?["']?([\wà-úÀ-Ú][\wà-úÀ-Ú \-]{1,28})["']?/i);
  if (!m) return null;
  let nome = m[1].trim().replace(/\s+/g, ' ')
    .replace(/\b(por\s*favor|pf|sora|a[íi]|obrigad[oa]).*$/i, '').trim();
  if (!nome) return null;
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}

function pastaPorPalavra(texto = '') {
  for (const [re, nome, icone] of MAPA_PASTA) if (re.test(texto)) return { nome, icone };
  return null;
}

// Acha (reusa) uma PASTA de topo = quadro pelo nome, ignorando acento/maiúscula
// ("curriculos" acha "Currículos"). Só cria se realmente não existir.
async function acharOuCriarQuadro(userId, nome, cor, icone) {
  const alvo = semAcento(nome);
  const { data: todos } = await supabase.from('dados_quadros').select('id, nome').eq('user_id', userId);
  const existe = (todos || []).find(q => semAcento(q.nome) === alvo);
  if (existe) return existe.id;
  const { data, error } = await supabase.from('dados_quadros')
    .insert({ user_id: userId, nome, cor: cor || '#10b981', icone: icone || '📁' })
    .select('id').single();
  if (error) throw new Error(`quadro: ${error.message}`);
  return data.id;
}

async function acharOuCriarSecao(userId, quadroId, nome, icone) {
  const alvo = semAcento(nome);
  const { data: todas } = await supabase.from('dados_secoes').select('id, nome').eq('user_id', userId).eq('quadro_id', quadroId);
  const existe = (todas || []).find(s => semAcento(s.nome) === alvo);
  if (existe) return existe;
  const { data, error } = await supabase.from('dados_secoes')
    .insert({ user_id: userId, quadro_id: quadroId, nome, icone: icone || '📄' })
    .select('id, nome').single();
  if (error) throw new Error(`secao: ${error.message}`);
  return data;
}

// Baixa um arquivo do WhatsApp e guarda no Drive do usuário.
// Retorna { ok, pasta, arquivo } ou { ok:false, erro }.
async function salvarArquivoDrive({ userId, fileUrl, fileName, mimeType, caption }) {
  if (!userId || !fileUrl) return { ok: false, erro: 'sem_url' };

  // 1) baixa — 2 tentativas: pública e, se falhar, com o client-token do Z-API
  // (algumas URLs de mídia do Z-API exigem o header de autenticação).
  const baixar = (hdr) => axios.get(fileUrl, {
    responseType: 'arraybuffer', maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES,
    timeout: 30000, maxRedirects: 5, headers: { 'User-Agent': 'SoraBot/1.0', ...(hdr || {}) },
  });
  let buffer, erroDl;
  for (const hdr of [null, { 'client-token': process.env.ZAPI_CLIENT_TOKEN }]) {
    try { const resp = await baixar(hdr); buffer = Buffer.from(resp.data); erroDl = null; break; }
    catch (e) { erroDl = e; if (/maxContentLength|content length/i.test(e.message || '')) return { ok: false, erro: 'grande' }; }
  }
  if (!buffer) return { ok: false, erro: 'download', detalhe: `${erroDl?.response?.status || ''} ${erroDl?.message || ''}`.trim() };
  if (buffer.length > MAX_BYTES) return { ok: false, erro: 'grande' };

  // 2) resolve a PASTA (= quadro de topo): legenda explícita > palavra-chave >
  // "Recebidos". Se bater no mapa, usa o nome canônico ("curriculos" → "Currículos").
  const nomeExib  = nomeExibicao(fileName);
  const explicita = pastaDaLegenda(caption);
  let pastaNome, pastaIcone;
  if (explicita) {
    const m = pastaPorPalavra(explicita);
    pastaNome = m ? m.nome : explicita; pastaIcone = m ? m.icone : '📁';
  } else {
    const m = pastaPorPalavra(`${caption || ''} ${nomeExib}`);
    pastaNome = m ? m.nome : QUADRO_ROOT; pastaIcone = m ? m.icone : '📁';
  }

  // 3) sobe no bucket privado (path ASCII-seguro; nome exibido mantém acentos)
  const path = `${userId}/${crypto.randomUUID()}-${nomeStorage(fileName)}`;
  const up = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType || 'application/octet-stream', upsert: false,
  });
  if (up.error) return { ok: false, erro: 'upload', detalhe: up.error.message };

  // 4) grava PASTA (quadro) > "Arquivos" (seção) > item
  try {
    const quadroId = await acharOuCriarQuadro(userId, pastaNome, '#10b981', pastaIcone);
    const secao    = await acharOuCriarSecao(userId, quadroId, 'Arquivos', '📄');
    const { error } = await supabase.from('dados_itens').insert({
      user_id: userId, secao_id: secao.id, tipo: 'arquivo',
      titulo: null, arquivo_url: path, arquivo_nome: nomeExib,
    });
    if (error) throw new Error(error.message);
    return { ok: true, pasta: pastaNome, arquivo: nomeExib };
  } catch (e) {
    try { await supabase.storage.from(BUCKET).remove([path]); } catch {}
    return { ok: false, erro: 'db', detalhe: e.message };
  }
}

// Detecta pedido de busca de arquivo ("ache meu comprovante") e devolve o termo.
// Local-first: exige verbo de busca + substantivo de arquivo (evita colidir).
function intentoBuscaArquivo(msg = '') {
  const m = String(msg).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!/\b(ache|acha|achar|encontr\w*|cade|onde|me\s+manda|manda|busca\w*|procur\w*|preciso\s+d[oae]|quero\s+(?:o|a|meu|minha))\b/.test(m)) return null;
  if (!/\b(arquivo|documento|comprovante|contrato|foto|imagem|pdf|nota|recibo|boleto|curriculo|planilha|holerite|exame|laudo|contrach\w*|drive)\w*/.test(m)) return null;
  return m.replace(/[?!.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
}

// Busca arquivos por palavra-chave (nome + rótulo). Retorna até 5, mais recentes.
async function buscarArquivosDrive(userId, termo) {
  const stop = new Set(['ache','acha','achar','encontrar','encontra','cade','onde','esta','ta','que','fiz','esse','ano','pra','para','com','meu','minha','meus','minhas','arquivo','documento','manda','busca','buscar','procura','procurar','preciso','quero','sora','pelo','pela','uns','umas','favor']);
  const palavras = String(termo || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\wà-ú ]+/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !stop.has(w)).slice(0, 5);
  if (!palavras.length) return [];
  const ors = palavras.flatMap(w => [`arquivo_nome.ilike.%${w}%`, `titulo.ilike.%${w}%`]).join(',');
  const { data } = await supabase.from('dados_itens')
    .select('id, titulo, arquivo_nome, arquivo_url')
    .eq('user_id', userId).eq('tipo', 'arquivo')
    .or(ors).order('created_at', { ascending: false }).limit(5);
  return data || [];
}

async function urlAssinada(path, segundos = 600) {
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, segundos);
  return data?.signedUrl || null;
}

module.exports = { salvarArquivoDrive, buscarArquivosDrive, urlAssinada, intentoBuscaArquivo };
