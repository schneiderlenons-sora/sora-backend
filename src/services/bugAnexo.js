// =============================================================================
// Anexos dos chamados de suporte — bucket PRIVADO `bug-anexos` (migration 143).
//
// ⚠️ POR QUE BUCKET E NÃO data URI NA TABELA. As logos de marca
// (`marcas_personalizadas`) são data URI e funcionam, mas ali a imagem tem
// ~20 KB. Print de tela tem MEGABYTES: guardado como texto, ele entra em todo
// `select *` de `bug_reports` — inclusive na listagem do admin, que puxa 200
// relatos de uma vez. Seriam centenas de MB trafegados pra desenhar uma lista.
//
// ⚠️ E POR QUE PRIVADO. Print de bug quase sempre mostra saldo, extrato e nome
// do cliente. Em bucket público a URL é adivinhável e vaza dado financeiro de
// terceiro. O acesso sai por URL ASSINADA, gerada aqui com service role.
// =============================================================================
const supabase = require('../db/supabase');

const BUCKET = 'bug-anexos';
/** Validade da URL assinada. 1h cobre a leitura do chamado sem virar link eterno. */
const TTL_SEGUNDOS = 3600;

const TIPOS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif',
};

/**
 * Sobe uma imagem em data URI e devolve o caminho no bucket.
 * @returns {Promise<string|null>} `null` em qualquer falha — anexo nunca pode
 *          derrubar o chamado: melhor o relato chegar sem print do que não
 *          chegar.
 */
async function salvarAnexo(dataUri, bugId) {
  try {
    if (typeof dataUri !== 'string') return null;
    const m = dataUri.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/i);
    if (!m) return null;

    const ext = TIPOS[m[1].toLowerCase()] || 'png';
    const buf = Buffer.from(m[2], 'base64');
    // Segunda trava de tamanho. A primeira é a tela (6 MB); esta protege contra
    // chamada direta à API, que não passa pelo navegador.
    if (!buf.length || buf.length > 6 * 1024 * 1024) return null;

    // Caminho por chamado: apagar o chamado é apagar a pasta inteira.
    const caminho = `${bugId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from(BUCKET)
      .upload(caminho, buf, { contentType: m[1], upsert: false });
    if (error) { console.warn('[bugAnexo] upload falhou:', error.message); return null; }
    return caminho;
  } catch (e) {
    console.warn('[bugAnexo] erro:', e.message);
    return null;
  }
}

/** URL assinada pra exibir o anexo. `null` se não houver (ou se falhar). */
async function urlAssinada(caminho) {
  if (!caminho) return null;
  try {
    const { data, error } = await supabase.storage.from(BUCKET)
      .createSignedUrl(caminho, TTL_SEGUNDOS);
    if (error) return null;
    return data?.signedUrl || null;
  } catch { return null; }
}

/** Assina vários caminhos de uma vez (lista de mensagens). */
async function assinarLista(caminhos) {
  const unicos = [...new Set((caminhos || []).filter(Boolean))];
  const mapa = {};
  await Promise.all(unicos.map(async (c) => { mapa[c] = await urlAssinada(c); }));
  return mapa;
}

/**
 * Apaga TODOS os anexos de um chamado.
 * Usado ao encerrar: a conversa some e os prints vão junto — deixar imagem de
 * saldo num bucket depois do chamado resolvido é guardar dado sem motivo.
 */
async function apagarAnexos(bugId) {
  try {
    const { data } = await supabase.storage.from(BUCKET).list(String(bugId));
    const arquivos = (data || []).map((f) => `${bugId}/${f.name}`);
    if (arquivos.length) await supabase.storage.from(BUCKET).remove(arquivos);
    return arquivos.length;
  } catch (e) {
    console.warn('[bugAnexo] limpeza falhou:', e.message);
    return 0;
  }
}

module.exports = { salvarAnexo, urlAssinada, assinarLista, apagarAnexos, BUCKET };
