// =============================================================================
// Espaço do Drive por pessoa — cota de 500 MB (eval:espaco-drive).
//
// Decisão do dono (nov/2026): cada pessoa tem até 500 MB de arquivos no Drive.
// Sem cota, um único cliente podia encher o armazenamento do projeto inteiro
// (o plano gratuito do Supabase tem 1 GB pra todos).
//
// O que conta: os arquivos da pessoa no bucket privado `dados-arquivos`
// (pasta `{userId}/`), medidos NO PRÓPRIO STORAGE — é o que custa de verdade.
// Notas e campos de texto ficam no banco e não entram aqui.
//
// ⚠️ ARQUIVO ÓRFÃO NÃO CONTA CONTRA A PESSOA. Órfão = está no storage mas
// nenhum item aponta pra ele (subiu e o formulário foi fechado, ou sobrou de
// uma pasta apagada antes da correção de nov/2026). É lixo NOSSO: a pessoa não
// vê nem consegue apagar. Só conta se tiver menos de 24h (upload em andamento,
// o item ainda vai ser salvo). Se a leitura dos itens falhar, conta TUDO.
//
// ⚠️ SE NÃO DER PRA MEDIR, DEIXA SUBIR. A cota protege o custo, não a
// segurança: um soluço do storage não pode travar o Drive de todo mundo.
// O excesso possível é de um arquivo (o bucket limita cada um a 10 MB).
// =============================================================================

const BUCKET = 'dados-arquivos';
const COTA_BYTES = 500 * 1024 * 1024;
/** Igual ao `file_size_limit` do bucket (migration 042). */
const MAX_ARQUIVO = 10 * 1024 * 1024;
const CARENCIA_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

/** "1,8 MB" · "500 MB" · "0,1 MB" (nunca "0 MB" pra quem tem algo). */
function fmtMB(bytes) {
  const n = Math.max(0, Number(bytes) || 0) / MB;
  if (n === 0) return '0 MB';
  const v = n < 0.1 ? 0.1 : n;
  const casas = v >= 100 || Number.isInteger(v) ? 0 : 1;
  return `${v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })} MB`;
}

/** O caminho é da pasta da pessoa? (nunca de outra, nunca com "..") */
function caminhoDaPessoa(userId, path) {
  return !!userId && typeof path === 'string' && path.startsWith(`${userId}/`)
    && path.length > String(userId).length + 1 && !path.includes('..');
}

/**
 * Soma o que conta contra a cota. Pura.
 * @param objetos  arquivos da pasta (do `storage.list`): { name, metadata: { size }, created_at }
 * @param usados   Set dos `arquivo_url` dos itens — null = não deu pra ler (conta tudo)
 */
function somarUso(userId, objetos, usados, agora = Date.now()) {
  let bytes = 0, arquivos = 0;
  for (const o of objetos || []) {
    const size = Number(o && o.metadata && o.metadata.size);
    if (!Number.isFinite(size) || size < 0) continue;
    const criado = Date.parse(o.created_at);
    const recente = Number.isNaN(criado) || agora - criado < CARENCIA_MS;
    if (!usados || usados.has(`${userId}/${o.name}`) || recente) { bytes += size; arquivos++; }
  }
  return { bytes, arquivos };
}

/**
 * Pode subir um arquivo de `tamanho` bytes com `usado` já ocupado?
 * @returns {{ ok: true } | { ok: false, motivo: 'grande'|'cheio', erro: string }}
 */
function decidirUpload(usado, tamanho) {
  const t = Math.max(0, Number(tamanho) || 0);
  if (t > MAX_ARQUIVO) return { ok: false, motivo: 'grande', erro: 'Esse arquivo é grande demais (máx. 10 MB).' };
  if (usado == null) return { ok: true };
  if (usado + t > COTA_BYTES) {
    return {
      ok: false, motivo: 'cheio',
      erro: usado >= COTA_BYTES
        ? `Seu Drive está cheio (${fmtMB(usado)} de ${fmtMB(COTA_BYTES)}). Apague arquivos que não usa mais pra liberar espaço.`
        : `Esse arquivo não cabe: você está usando ${fmtMB(usado)} de ${fmtMB(COTA_BYTES)}. Apague arquivos que não usa mais pra liberar espaço.`,
    };
  }
  return { ok: true };
}

/** Lê todas as linhas (de 1000 em 1000) — o PostgREST corta em 1000. */
async function lerTudo(montar) {
  const linhas = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await montar().range(de, de + 999);
    if (error) return null;
    linhas.push(...(data || []));
    if (!data || data.length < 1000) return linhas;
  }
}

/**
 * Quanto a pessoa usa. `null` quando o storage não respondeu.
 * @returns {Promise<{ bytes, arquivos, limite } | null>}
 */
async function usoDoDrive(supabase, userId) {
  if (!userId) return null;
  const objetos = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(BUCKET).list(String(userId), { limit: 1000, offset });
    if (error) return null;
    // Pasta vem com id null; arquivo tem id e metadata.
    objetos.push(...(data || []).filter((o) => o && o.id !== null));
    if (!data || data.length < 1000) break;
  }
  const itens = await lerTudo(() => supabase.from('dados_itens').select('arquivo_url')
    .eq('user_id', userId).not('arquivo_url', 'is', null));
  const usados = itens ? new Set(itens.map((i) => i.arquivo_url)) : null;
  return { ...somarUso(userId, objetos, usados), limite: COTA_BYTES };
}

/** Os arquivos dos itens de uma pasta (quadro) ou subpasta (seção). */
async function arquivosDe(supabase, userId, { quadroId = null, secaoId = null }) {
  let secoes = secaoId ? [secaoId] : [];
  if (quadroId) {
    const s = await lerTudo(() => supabase.from('dados_secoes').select('id').eq('user_id', userId).eq('quadro_id', quadroId));
    if (!s) return null;
    secoes = s.map((x) => x.id);
  }
  if (!secoes.length) return [];
  const itens = await lerTudo(() => supabase.from('dados_itens').select('arquivo_url')
    .eq('user_id', userId).in('secao_id', secoes).not('arquivo_url', 'is', null));
  if (!itens) return null;
  return itens.map((i) => i.arquivo_url).filter((p) => caminhoDaPessoa(userId, p));
}

/** Apaga arquivos do storage — só os da pasta da pessoa. Falha não derruba nada. */
async function apagarArquivos(supabase, userId, caminhos) {
  const meus = [...new Set((caminhos || []).filter((p) => caminhoDaPessoa(userId, p)))];
  for (let i = 0; i < meus.length; i += 100) {
    try { await supabase.storage.from(BUCKET).remove(meus.slice(i, i + 100)); }
    catch (e) { console.warn('[drive] não apaguei arquivos do storage:', e.message); }
  }
  return meus.length;
}

module.exports = {
  BUCKET, COTA_BYTES, MAX_ARQUIVO, CARENCIA_MS,
  fmtMB, caminhoDaPessoa, somarUso, decidirUpload, usoDoDrive, arquivosDe, apagarArquivos,
};
