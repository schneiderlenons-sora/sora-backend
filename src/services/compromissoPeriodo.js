// =============================================================================
// Compromisso de MAIS DE UM DIA — regra única (eval:compromisso-periodo).
//
// Pedido de cliente (nov/2026): um evento de dois dias seguidos (27 e 28/11,
// dia todo) teve de ser cadastrado duas vezes. O compromisso ganhou uma data
// de FIM opcional (`compromissos.data_fim`, migration 204).
//
// O que mora aqui, pra painel, WhatsApp e briefing não decidirem cada um o seu:
//   · validarPeriodo     — o "até" é válido? (fim igual ao início = um dia só)
//   · diasNoIntervalo    — em quais dias da janela o evento aparece ("dia 2 de 3")
//   · inicioDaBusca      — de quando buscar pra pegar evento que COMEÇOU antes
//                          da janela e ainda está acontecendo dentro dela
//   · fimAoMoverInicio   — mudar só o início mantém a duração
//   · lerPeriodoNaFrase  — "de 27 a 28/11", "dias 27 e 28/11" no WhatsApp
//
// ⚠️ `data` CONTINUA SENDO O INÍCIO. Lembrete (JOB 1J), Planejamento Semanal e
// tudo o que já existia olham `data` — o lembrete sai antes do PRIMEIRO dia.
// `data_fim` nulo = um dia só, exatamente como antes.
//
// ⚠️ A BUSCA NÃO FILTRA POR `data_fim`. Quem busca pede `data` a partir de
// `inicioDaBusca(de)` e filtra aqui. Filtro com a coluna nova quebraria a
// consulta inteira (e a Agenda de todo mundo) antes de a migration 204 rodar.
// =============================================================================

/** Um evento pode durar até isto (dias, contando o primeiro e o último). */
const MAX_DIAS = 60;

const RE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const iso10 = (v) => String(v == null ? '' : v).slice(0, 10);

function dataValida(s) {
  if (!RE_ISO.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function somarDias(s, n) {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

/**
 * O "até" do formulário/da frase. Vazio ou igual ao início = um dia só (null).
 * @returns {{ ok: true, dataFim: string|null } | { ok: false, erro: string }}
 */
function validarPeriodo(data, dataFim) {
  const ini = iso10(data);
  if (!dataValida(ini)) return { ok: false, erro: 'Escolha a data.' };
  if (dataFim == null || dataFim === '') return { ok: true, dataFim: null };
  const fim = iso10(dataFim);
  if (!dataValida(fim)) return { ok: false, erro: 'A data de fim não é válida.' };
  const n = diasEntre(ini, fim);
  if (n === 0) return { ok: true, dataFim: null };
  if (n < 0) return { ok: false, erro: 'O fim tem que ser depois do início.' };
  if (n + 1 > MAX_DIAS) return { ok: false, erro: `Um evento pode durar até ${MAX_DIAS} dias.` };
  return { ok: true, dataFim: fim };
}

/** Último dia do evento (o próprio início quando é de um dia só). */
function ultimoDia(c) {
  const ini = iso10(c && c.data);
  const fim = c && c.data_fim ? iso10(c.data_fim) : '';
  return dataValida(fim) && fim > ini ? fim : ini;
}

/** Quantos dias o evento dura (1 quando não tem fim). */
function totalDias(c) {
  return diasEntre(iso10(c.data), ultimoDia(c)) + 1;
}

/**
 * Os dias do evento que caem em [de, ate], com a posição de cada um.
 * Evento de um dia só: [{ data, dia: 1, total: 1 }] se estiver na janela.
 */
function diasNoIntervalo(c, de, ate) {
  const ini = iso10(c && c.data);
  if (!dataValida(ini)) return [];
  const fim = ultimoDia(c);
  const total = diasEntre(ini, fim) + 1;
  const out = [];
  // Teto por segurança: dado torto no banco nunca vira laço longo.
  for (let i = 0; i < Math.min(total, MAX_DIAS); i++) {
    const d = somarDias(ini, i);
    if (d > ate) break;
    if (d >= de) out.push({ data: d, dia: i + 1, total });
  }
  return out;
}

/** De quando buscar `data` pra pegar evento que começou antes de `de`. */
const inicioDaBusca = (de) => somarDias(iso10(de), -(MAX_DIAS - 1));

/** O evento (de um ou mais dias) toca a janela [de, ate]? */
const cruzaIntervalo = (c, de, ate) => iso10(c.data) <= ate && ultimoDia(c) >= de;

/**
 * Mudou só o início: o evento mantém a duração (um de 2 dias continua de 2).
 * Devolve o novo fim, ou null quando o evento é de um dia só.
 */
function fimAoMoverInicio(antigo, novaData) {
  const total = antigo ? totalDias(antigo) : 1;
  return total > 1 ? somarDias(iso10(novaData), total - 1) : null;
}

/** " (dia 2 de 3)" — sufixo pra texto (WhatsApp/briefing). Vazio em evento de um dia. */
const sufixoDoDia = (dia, total) => (total > 1 ? ` (dia ${dia} de ${total})` : '');

// ─── "de 27 a 28/11" no WhatsApp ────────────────────────────────────────────
const MESES_RE = 'janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
const MES_NUM = {
  janeiro: 0, fevereiro: 1, 'março': 2, marco: 2, abril: 3, maio: 4, junho: 5,
  julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
};

// grupos: 1 prefixo · 2 d1 · 3 m1 · 4 a1 · 5 conector · 6 d2 · 7 m2 · 8 a2 · 9 mês escrito · 10 ano escrito
const RE_PERIODO = new RegExp(
  '(?<![\\p{L}\\p{N}/])'
  + '(?:(do\\s+dia|dias|dia|desde\\s+o\\s+dia|de)\\s+)?'
  + '(\\d{1,2})(?:\\/(\\d{1,2})(?:\\/(\\d{2,4}))?)?'
  + '\\s+(a|at[ée]|ao|e)\\s+(?:o\\s+)?(?:dia\\s+)?'
  + `(\\d{1,2})(?:\\/(\\d{1,2})(?:\\/(\\d{2,4}))?|\\s+de\\s+(${MESES_RE})(?:\\s+de\\s+(\\d{4}))?)?`
  + '(?![\\p{L}\\p{N}/])',
  'gu',
);

const RE_UNIDADE_DEPOIS = /^\s*(?:h|hs|hrs?|horas?|min|mins?|minutos?|pessoas?|reais|km|kg|%)(?![\p{L}\p{N}])/u;
const anoDe = (s) => (s.length === 2 ? 2000 + Number(s) : Number(s));
const isoDe = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m, d, 12));
  // "31/11" não existe: o Date rolaria pra 01/12 — aí não é data.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
};
const mesAnterior = (y, m) => (m === 0 ? [y - 1, 11] : [y, m - 1]);
const mesSeguinte = (y, m) => (m === 11 ? [y + 1, 0] : [y, m + 1]);

/**
 * Lê um período na frase (já em minúsculas ou não). Exige um sinal claro de
 * DATA — mês (/11, "de novembro") ou a palavra "dia" —, senão "reunião de 9 a
 * 11" (horário) viraria evento de três dias. "e" só vale com "dias" ou mês, e
 * com dias SEGUIDOS ("dias 10 e 20" são dois dias soltos, não um período).
 *
 * @param agora relógio (o eval passa um fixo)
 * @returns {{ inicio: string, fim: string, matched: string } | null}
 */
function lerPeriodoNaFrase(frase, agora = new Date()) {
  const txt = String(frase || '').toLowerCase();
  const hoje = isoDe(agora.getFullYear(), agora.getMonth(), agora.getDate());
  for (const m of txt.matchAll(RE_PERIODO)) {
    const [, prefixo = '', d1s, m1s, a1s, conector, d2s, m2s, a2s, mesEscrito, anoEscrito] = m;
    // "27/11 a 30 minutos", "de 2 a 3 pessoas": o número do fim é outra coisa.
    if (RE_UNIDADE_DEPOIS.test(txt.slice(m.index + m[0].length))) continue;
    const temMes = !!(m1s || m2s || mesEscrito);
    if (!temMes && !/dia/.test(prefixo)) continue;
    // "e" só com "dias" ou com mês ("dias 27 e 28", "27 e 28/11") — e só dia SEGUIDO (abaixo).
    if (conector === 'e' && prefixo !== 'dias' && !temMes) continue;

    const d1 = Number(d1s), d2 = Number(d2s);
    let ini = null, fim = null;
    if (m1s && (m2s || mesEscrito)) {
      // "27/11 a 02/12" · "27/11 a 2 de dezembro"
      const y1 = a1s ? anoDe(a1s) : (a2s ? anoDe(a2s) : (anoEscrito ? Number(anoEscrito) : agora.getFullYear()));
      ini = isoDe(y1, Number(m1s) - 1, d1);
      const mo2 = m2s ? Number(m2s) - 1 : MES_NUM[mesEscrito];
      const yExplicito = a2s ? anoDe(a2s) : (anoEscrito ? Number(anoEscrito) : null);
      let y2 = yExplicito ?? y1;
      fim = isoDe(y2, mo2, d2);
      // "30/12 a 02/01": virou o ano.
      if (fim && ini && fim < ini && yExplicito == null) { y2 += 1; fim = isoDe(y2, mo2, d2); }
    } else if (m2s || mesEscrito) {
      // "de 27 a 28/11" · "dia 27 a 29 de novembro" — o mês do fim vale pros dois
      const mo = m2s ? Number(m2s) - 1 : MES_NUM[mesEscrito];
      const anoExplicito = a2s ? anoDe(a2s) : (anoEscrito ? Number(anoEscrito) : null);
      let y = anoExplicito ?? agora.getFullYear();
      fim = isoDe(y, mo, d2);
      // Mês escrito sem ano e já passado: a próxima vez (igual "dia N de mês").
      if (mesEscrito && anoExplicito == null && fim && fim < hoje) { y += 1; fim = isoDe(y, mo, d2); }
      if (fim) {
        const [yi, mi] = d1 > d2 ? mesAnterior(y, mo) : [y, mo]; // "de 30 a 2/12"
        ini = isoDe(yi, mi, d1);
      }
    } else if (m1s) {
      // "27/11 a 29" — o fim no mesmo mês (ou no seguinte, se o dia for menor)
      const y = a1s ? anoDe(a1s) : agora.getFullYear();
      const mo = Number(m1s) - 1;
      ini = isoDe(y, mo, d1);
      const [yf, mf] = d2 < d1 ? mesSeguinte(y, mo) : [y, mo];
      fim = isoDe(yf, mf, d2);
    } else {
      // "dia 27 a 29" / "do dia 27 ao dia 29": mês corrente, ou o próximo se já passou
      let y = agora.getFullYear(), mo = agora.getMonth();
      ini = isoDe(y, mo, d1);
      if (ini && ini < hoje) { [y, mo] = mesSeguinte(y, mo); ini = isoDe(y, mo, d1); }
      const [yf, mf] = d2 < d1 ? mesSeguinte(y, mo) : [y, mo];
      fim = isoDe(yf, mf, d2);
    }
    if (!ini || !fim) continue;
    const n = diasEntre(ini, fim);
    if (n < 1 || n + 1 > MAX_DIAS) continue;
    if (conector === 'e' && n !== 1) continue;
    return { inicio: ini, fim, matched: m[0].trim() };
  }
  return null;
}

/** "sex, 27/11" — pra texto do WhatsApp. */
function dataCurta(s) {
  return new Date(`${iso10(s)}T12:00:00Z`)
    .toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' })
    .replace('.', '');
}

module.exports = {
  MAX_DIAS, validarPeriodo, ultimoDia, totalDias, diasNoIntervalo, inicioDaBusca,
  cruzaIntervalo, fimAoMoverInicio, sufixoDoDia, lerPeriodoNaFrase, dataCurta,
  somarDias, diasEntre,
};
