// =============================================================================
// Registro de PESO (Saúde do Grow) — valor, DATA e a data dita no WhatsApp.
//
// Pedido de cliente (nov/2026): "opção de colocar a data do peso — hoje ele só
// registra o peso, não permite escolher a data". O backend já aceitava `data`
// no POST, mas a tela nunca a mandava, e o WhatsApp gravava sempre "hoje".
//
// ⚠️ "Hoje" é o dia em SÃO PAULO, nunca `toISOString()` (UTC): às 21h no
// Brasil o UTC já virou o dia seguinte, e a pesagem da noite caía amanhã.
//
// ⚠️ Peso é do PASSADO: data futura é recusada (pesar amanhã não existe), e a
// data dita sem ano ("10/11", "dia 10") é a ocorrência mais RECENTE que já
// passou — "dia 28" falado no dia 5 é o 28 do mês passado, não o do mês que vem.
//
// Travado em `npm run eval:peso`.
// =============================================================================

const PESO_MIN = 1;
const PESO_MAX = 600;          // o CHECK da tabela (013) é > 0 e < 600
const DATA_MIN = '1950-01-01';
const OBS_MAX = 100;

/** Dia de hoje em São Paulo (YYYY-MM-DD). */
function hojeSP(agora = new Date()) {
  return agora.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const ultimoDia = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Data de calendário real? (31/11 não é.) */
function dataValida(y, m, d) {
  return Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)
    && m >= 1 && m <= 12 && d >= 1 && d <= ultimoDia(y, m);
}

/** Soma dias a um YYYY-MM-DD (sem fuso: meio-dia UTC). */
function somarDias(isoData, n) {
  const t = Date.parse(`${isoData}T12:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** "80", "80,5", "80.5", 80.5 → número em kg; inválido → null. */
function lerPeso(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim().replace(/\s*kg$/i, '').replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

/**
 * Valida o que vai pra tabela `pesos`.
 * @returns {{ peso_kg:number, data:string, observacao:string|null } | { erro:string }}
 */
function validarRegistro({ peso_kg, data, observacao } = {}, hoje = hojeSP()) {
  const peso = lerPeso(peso_kg);
  if (peso == null || peso < PESO_MIN || peso >= PESO_MAX) {
    return { erro: 'Informe um peso válido (ex.: 72,5).' };
  }
  let dia = hoje;
  if (data != null && data !== '') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(data));
    if (!m || !dataValida(+m[1], +m[2], +m[3])) return { erro: 'Data inválida.' };
    dia = `${m[1]}-${m[2]}-${m[3]}`;
    if (dia > hoje) return { erro: 'A data não pode ser no futuro.' };
    if (dia < DATA_MIN) return { erro: 'Data inválida.' };
  }
  const obs = String(observacao ?? '').replace(/\s+/g, ' ').trim().slice(0, OBS_MAX);
  return { peso_kg: Math.round(peso * 100) / 100, data: dia, observacao: obs || null };
}

/**
 * Data dita numa frase do WhatsApp → YYYY-MM-DD, ou null se não reconhecer.
 * "hoje" · "ontem" · "anteontem" · "dia 10" · "10/11" · "10/11/26" · "10/11/2026"
 * (aceita "em"/"no dia" na frente). Nunca devolve data futura.
 */
function dataDaFrase(texto, hoje = hojeSP()) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:em|de|do) /, '')        // "em 10/11"
    .replace(/^no dia /, 'dia ')          // "no dia 10"
    .replace(/^dia (?=\d{1,2}\/)/, '');   // "dia 10/11" → "10/11"
  if (t === 'hoje') return hoje;
  if (t === 'ontem') return somarDias(hoje, -1);
  if (t === 'anteontem') return somarDias(hoje, -2);

  const [hy, hm] = hoje.split('-').map(Number);

  let m = /^dia\s+(\d{1,2})$/.exec(t);
  if (m) {
    const d = +m[1];
    // Este mês se já passou (ou é hoje); senão, o mês anterior.
    for (const [y, mes] of [[hy, hm], hm === 1 ? [hy - 1, 12] : [hy, hm - 1]]) {
      if (dataValida(y, mes, d) && iso(y, mes, d) <= hoje) return iso(y, mes, d);
    }
    return null;
  }

  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t);
  if (m) {
    const d = +m[1], mes = +m[2];
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (!dataValida(y, mes, d)) return null;
      const r = iso(y, mes, d);
      return r <= hoje ? r : null;
    }
    // Sem ano: este ano se já passou; senão, o ano passado.
    if (dataValida(hy, mes, d) && iso(hy, mes, d) <= hoje) return iso(hy, mes, d);
    if (dataValida(hy - 1, mes, d)) return iso(hy - 1, mes, d);
    return null;
  }
  return null;
}

/** Trecho de data que o comando de peso do WhatsApp aceita depois do valor. */
const RE_DATA_FALADA = '(?:hoje|ontem|anteontem|(?:no\\s+)?dia\\s+\\d{1,2}|(?:em|no dia|dia)?\\s*\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)';

/**
 * Comando de peso do WhatsApp: "peso 80", "peso 80,5 kg ontem", "estou com 80kg dia 10".
 *
 * ⚠️ Depois de "peso" o "kg" é opcional; depois de "estou com"/"to com" ele é
 * OBRIGATÓRIO — "estou com 80" sozinho pode ser dinheiro, não peso. (A regra
 * antiga exigia "kg" em todas, por um `kg?` que na verdade quer dizer "k" e
 * "g" opcional: "peso 75.2", o próprio exemplo da mensagem de erro, falhava.)
 * @returns {{ peso:string, quando:string|null } | null}
 */
function lerComandoPeso(msg) {
  const quando = `(?:\\s+(${RE_DATA_FALADA}))?\\s*$`;
  const s = String(msg || '').trim();
  const m = new RegExp(`^(?:peso|registrar peso)\\s+(\\d+(?:[.,]\\d+)?)\\s*(?:kg|quilos?)?${quando}`, 'i').exec(s)
    || new RegExp(`^(?:to com|t[oô] com|estou com)\\s+(\\d+(?:[.,]\\d+)?)\\s*(?:kg|quilos?)${quando}`, 'i').exec(s);
  if (!m) return null;
  return { peso: m[1], quando: m[2] ? m[2].trim() : null };
}

module.exports = {
  PESO_MIN, PESO_MAX, OBS_MAX,
  hojeSP, lerPeso, validarRegistro, dataDaFrase, lerComandoPeso, somarDias,
};
