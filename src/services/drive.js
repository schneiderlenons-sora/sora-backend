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

function limparNome(s = '') {
  return String(s).replace(/[^\wà-úÀ-Ú.\- ]+/g, '_').trim().slice(0, 90) || 'arquivo';
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

async function acharOuCriarQuadro(userId) {
  const { data: existe } = await supabase.from('dados_quadros')
    .select('id').eq('user_id', userId).ilike('nome', QUADRO_ROOT).limit(1).maybeSingle();
  if (existe) return existe.id;
  const { data, error } = await supabase.from('dados_quadros')
    .insert({ user_id: userId, nome: QUADRO_ROOT, cor: '#10b981', icone: '📁' })
    .select('id').single();
  if (error) throw new Error(`quadro: ${error.message}`);
  return data.id;
}

async function acharOuCriarSecao(userId, quadroId, nome, icone) {
  const { data: existe } = await supabase.from('dados_secoes')
    .select('id, nome').eq('user_id', userId).eq('quadro_id', quadroId)
    .ilike('nome', nome).limit(1).maybeSingle();
  if (existe) return existe;
  const { data, error } = await supabase.from('dados_secoes')
    .insert({ user_id: userId, quadro_id: quadroId, nome, icone: icone || '🗂️' })
    .select('id, nome').single();
  if (error) throw new Error(`secao: ${error.message}`);
  return data;
}

// Baixa um arquivo do WhatsApp e guarda no Drive do usuário.
// Retorna { ok, pasta, arquivo } ou { ok:false, erro }.
async function salvarArquivoDrive({ userId, fileUrl, fileName, mimeType, caption }) {
  if (!userId || !fileUrl) return { ok: false, erro: 'sem_url' };

  // 1) baixa
  let buffer;
  try {
    const resp = await axios.get(fileUrl, {
      responseType: 'arraybuffer', maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES, timeout: 30000,
    });
    buffer = Buffer.from(resp.data);
  } catch (e) {
    if (/maxContentLength|content length/i.test(e.message || '')) return { ok: false, erro: 'grande' };
    return { ok: false, erro: 'download', detalhe: e.message };
  }
  if (buffer.length > MAX_BYTES) return { ok: false, erro: 'grande' };

  // 2) resolve a pasta (subpasta): legenda explícita > palavra-chave > Geral
  const nomeArq   = limparNome(fileName);
  const explicita = pastaDaLegenda(caption);
  const contexto  = `${caption || ''} ${nomeArq}`;
  const pasta = explicita
    ? { nome: explicita, icone: pastaPorPalavra(explicita)?.icone || '📁' }
    : (pastaPorPalavra(contexto) || { nome: 'Geral', icone: '🗂️' });

  // 3) sobe no bucket privado
  const path = `${userId}/${crypto.randomUUID()}-${nomeArq}`;
  const up = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType || 'application/octet-stream', upsert: false,
  });
  if (up.error) return { ok: false, erro: 'upload', detalhe: up.error.message };

  // 4) grava quadro > seção > item
  try {
    const quadroId = await acharOuCriarQuadro(userId);
    const secao    = await acharOuCriarSecao(userId, quadroId, pasta.nome, pasta.icone);
    const titulo   = (caption && caption.trim().slice(0, 80)) || nomeArq;
    const { error } = await supabase.from('dados_itens').insert({
      user_id: userId, secao_id: secao.id, tipo: 'arquivo',
      titulo, arquivo_url: path, arquivo_nome: nomeArq,
    });
    if (error) throw new Error(error.message);
    return { ok: true, pasta: secao.nome, arquivo: nomeArq };
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
