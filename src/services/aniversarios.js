// =============================================================================
// Aniversários e datas comemorativas — regra única (eval:aniversarios).
//
// Pedido de cliente (Tatiane, nov/2026): "uma aba específica para aniversários
// dentro da agenda, com datas comemorativas que se repitam automaticamente
// todos os anos; lembrete com uma semana de antecedência, pra comprar presente
// ou planejar, além de uma notificação no próprio dia".
//
// Tabela `aniversarios` (migration 205): dia + mês (+ ano opcional, pra dizer
// "faz 30 anos"). Pessoal, como a Agenda (por `user_id`).
//
//   · validarAniversario — o que o formulário manda
//   · ocorrencias        — em que dias da janela a data cai (todo ano)
//   · avisosDoDia        — quais lembretes saem HOJE (1 semana antes / no dia)
//   · textoDoAviso       — o que a pessoa lê no WhatsApp
//   · avisarAniversarios — o cron (JOB 1U), com as dependências injetadas
//
// ⚠️ 29/02: em ano que não é bissexto, a data cai em 28/02 — o lembrete não
// pode simplesmente não existir em 3 de cada 4 anos.
// ⚠️ O aviso de cada etapa sai UMA vez por ano (`aviso_semana_ano`,
// `aviso_dia_ano`), reservado ANTES de enviar — dois servidores ou um restart
// não mandam o mesmo aviso duas vezes.
// ⚠️ "No dia" com o briefing matinal ligado: o briefing já lista o aniversário
// (ele vem no feed da agenda), então o aviso separado não sai — mesma regra
// dos outros lembretes ("vence hoje" é do briefing). Exceção: data cadastrada
// HOJE, que o briefing pode ter perdido.
// =============================================================================

const TIPOS = {
  aniversario: { rotulo: 'Aniversário', emoji: '🎂' },
  casamento:   { rotulo: 'Aniversário de casamento', emoji: '💍' },
  data:        { rotulo: 'Data comemorativa', emoji: '🎉' },
};
const ANTECEDENCIA_DIAS = 7;
const HORA_AVISO = 9; // a partir das 9h de São Paulo
const LIM = { nome: 80, observacao: 500 };

const pad = (n) => String(n).padStart(2, '0');
const bissexto = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const diasNoMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12

function somarDias(s, n) {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

/** A data no ano `y`. 29/02 em ano comum vira 28/02. */
function dataNoAno(dia, mes, y) {
  const d = mes === 2 && dia === 29 && !bissexto(y) ? 28 : Math.min(dia, diasNoMes(y, mes));
  return `${y}-${pad(mes)}-${pad(d)}`;
}

/** Ano em que a data acontece a 1ª vez que conta (depois do ano de nascimento/casamento). */
const primeiroAno = (item) => (item.ano ? Number(item.ano) + 1 : -Infinity);

/** Todas as vezes que a data cai em [de, ate] (inclusive), uma por ano. */
function ocorrencias(item, de, ate) {
  const dia = Number(item.dia), mes = Number(item.mes);
  if (!dia || !mes) return [];
  const out = [];
  for (let y = Number(de.slice(0, 4)); y <= Number(ate.slice(0, 4)); y++) {
    if (y < primeiroAno(item)) continue;
    const d = dataNoAno(dia, mes, y);
    if (d >= de && d <= ate) out.push(d);
  }
  return out;
}

/** A próxima vez (hoje inclusive). */
function proximaOcorrencia(item, hoje) {
  const [d] = ocorrencias(item, hoje, somarDias(hoje, 800));
  return d || null;
}

/** Quantos anos completa naquela data (null sem ano). */
function anosEm(item, dataIso) {
  if (!item.ano) return null;
  const n = Number(dataIso.slice(0, 4)) - Number(item.ano);
  return n > 0 ? n : null;
}

/** "faz 30 anos" · "30 anos de casados" · "30 anos" — ou null. */
function rotuloAnos(item, dataIso) {
  const n = anosEm(item, dataIso);
  if (!n) return null;
  const anos = `${n} ${n === 1 ? 'ano' : 'anos'}`;
  if (item.tipo === 'casamento') return `${anos} de casados`;
  if (item.tipo === 'data') return anos;
  return `faz ${anos}`;
}

/** Título na agenda: "Aniversário: Ana" · "Aniversário de casamento: Ana e João" · "Formatura". */
function tituloDe(item) {
  const t = TIPOS[item.tipo] || TIPOS.aniversario;
  return item.tipo === 'data' ? String(item.nome) : `${t.rotulo}: ${item.nome}`;
}

/** Confere o que o formulário mandou. `parcial` = edição (só o que veio). */
function validarAniversario(body, { parcial = false, anoAtual = new Date().getFullYear(), hoje = null } = {}) {
  const b = body || {};
  const dados = {};
  const tem = (k) => k in b;
  if (!parcial || tem('nome')) {
    const nome = String(b.nome == null ? '' : b.nome).replace(/\s+/g, ' ').trim();
    if (!nome) return { ok: false, erro: 'Diga de quem é (ou o nome da data).' };
    if (nome.length > LIM.nome) return { ok: false, erro: `O nome pode ter até ${LIM.nome} caracteres.` };
    dados.nome = nome;
  }
  if (!parcial || tem('tipo')) {
    const tipo = b.tipo == null || b.tipo === '' ? 'aniversario' : String(b.tipo);
    if (!TIPOS[tipo]) return { ok: false, erro: 'Tipo de data inválido.' };
    dados.tipo = tipo;
  }
  if (!parcial || tem('dia') || tem('mes')) {
    const dia = Number(b.dia), mes = Number(b.mes);
    if (!Number.isInteger(mes) || mes < 1 || mes > 12) return { ok: false, erro: 'Escolha o mês.' };
    // 29/02 vale (cai em 28/02 nos anos comuns); 31/04 não existe.
    const maximo = mes === 2 ? 29 : diasNoMes(2024, mes);
    if (!Number.isInteger(dia) || dia < 1 || dia > maximo) return { ok: false, erro: 'Esse dia não existe nesse mês.' };
    dados.dia = dia; dados.mes = mes;
  }
  if (!parcial || tem('ano')) {
    if (b.ano == null || b.ano === '') dados.ano = null;
    else {
      const ano = Number(b.ano);
      if (!Number.isInteger(ano) || ano < 1900 || ano > anoAtual) return { ok: false, erro: `O ano tem que ser entre 1900 e ${anoAtual}.` };
      if (dados.dia && dados.mes === 2 && dados.dia === 29 && !bissexto(ano)) return { ok: false, erro: `${ano} não teve 29 de fevereiro.` };
      // Nascimento/casamento ainda por vir não existe (o 1º aniversário sumiria).
      const dHoje = hoje || `${anoAtual}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}`;
      if (dados.dia && `${ano}-${pad(dados.mes)}-${pad(dados.dia)}` > dHoje) return { ok: false, erro: 'Essa data ainda não aconteceu. Deixe o ano em branco se for o caso.' };
      dados.ano = ano;
    }
  }
  for (const k of ['lembrete_semana', 'lembrete_dia']) {
    if (!parcial || tem(k)) {
      if (b[k] == null) { if (!parcial) dados[k] = true; continue; }
      if (typeof b[k] !== 'boolean') return { ok: false, erro: 'Lembrete inválido.' };
      dados[k] = b[k];
    }
  }
  if (!parcial || tem('observacao')) {
    const obs = String(b.observacao == null ? '' : b.observacao).trim();
    if (obs.length > LIM.observacao) return { ok: false, erro: `A observação pode ter até ${LIM.observacao} caracteres.` };
    dados.observacao = obs || null;
  }
  if (parcial && !Object.keys(dados).length) return { ok: false, erro: 'Nada pra salvar.' };
  return { ok: true, dados };
}

/**
 * Quais avisos saem HOJE. Cada um: { item, etapa: 'semana'|'dia', data, ano }.
 * Já avisado naquele ano (`aviso_*_ano`) não volta.
 */
function avisosDoDia(itens, hoje) {
  const out = [];
  const daquiUmaSemana = somarDias(hoje, ANTECEDENCIA_DIAS);
  for (const item of itens || []) {
    if (item.lembrete_semana && ocorrencias(item, daquiUmaSemana, daquiUmaSemana).length) {
      const ano = Number(daquiUmaSemana.slice(0, 4));
      if (Number(item.aviso_semana_ano) !== ano) out.push({ item, etapa: 'semana', data: daquiUmaSemana, ano });
    }
    if (item.lembrete_dia && ocorrencias(item, hoje, hoje).length) {
      const ano = Number(hoje.slice(0, 4));
      if (Number(item.aviso_dia_ano) !== ano) out.push({ item, etapa: 'dia', data: hoje, ano });
    }
  }
  return out;
}

/**
 * Os (dia, mês) que podem gerar aviso HOJE: hoje e daqui a 7 dias — mais o
 * 29/02 quando um deles é 28/02 de ano comum. Vira o filtro da consulta do
 * cron (lê só as datas do dia, não a tabela inteira a cada rodada).
 */
function paresDoDia(hoje) {
  const pares = [];
  for (const d of [hoje, somarDias(hoje, ANTECEDENCIA_DIAS)]) {
    const y = Number(d.slice(0, 4)), mes = Number(d.slice(5, 7)), dia = Number(d.slice(8, 10));
    pares.push({ dia, mes });
    if (mes === 2 && dia === 28 && !bissexto(y)) pares.push({ dia: 29, mes: 2 });
  }
  return pares;
}

/** "sexta, 05/12" */
function diaDaSemana(s) {
  return new Date(`${s}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: '2-digit' })
    .replace('-feira', '');
}

/** O texto do aviso: { texto (in-window), core (resumo), campos (template de 3 campos) }. */
function textoDoAviso({ item, etapa, data }) {
  const t = TIPOS[item.tipo] || TIPOS.aniversario;
  const anos = rotuloAnos(item, data);
  const titulo = `${t.emoji} ${tituloDe(item)}`;
  const quando = etapa === 'semana'
    ? `daqui a 1 semana: ${diaDaSemana(data)}${anos ? ` · ${anos}` : ''}`
    : `é hoje!${anos ? ` ${anos.charAt(0).toUpperCase()}${anos.slice(1)}.` : ''}`;
  const abertura = etapa === 'semana'
    ? (item.tipo === 'aniversario' ? 'Aniversário chegando: dá tempo de pensar no presente.' : 'Data especial chegando: dá tempo de se organizar.')
    : (item.tipo === 'aniversario' ? 'Hoje tem aniversário! Não esquece de dar os parabéns.' : 'Hoje é uma data especial!');
  const obs = item.observacao ? `\n📝 ${item.observacao}` : '';
  const texto = `${t.emoji} *${etapa === 'semana' ? 'Daqui a 1 semana' : 'É hoje!'}*\n\n`
    + `*${tituloDe(item)}*\n🗓️ ${diaDaSemana(data)}${anos ? ` · ${anos}` : ''}${obs}\n\n`
    + 'Ver agenda: 🌐 https://www.forsora.com/grow/agenda';
  const core = `${titulo} — ${quando}`;
  return { texto, core, campos: [abertura, titulo, `${quando.charAt(0).toUpperCase()}${quando.slice(1)}`] };
}

/**
 * O cron (JOB 1U). Tudo de fora vem injetado, pro eval rodar sem rede.
 * @returns {Promise<{ enviados, cobertosPeloBriefing, falhas, tentarDeNovo }>}
 */
async function avisarAniversarios({ supabase, hoje, enviar, phoneDoUser, avisosLigados, briefingLigado, log = console }) {
  const r = { enviados: 0, cobertosPeloBriefing: 0, falhas: 0, tentarDeNovo: 0 };
  // Só as datas que podem avisar hoje (o filtro exato fica no avisosDoDia).
  const filtro = paresDoDia(hoje).map((p) => `and(dia.eq.${p.dia},mes.eq.${p.mes})`).join(',');
  const { data: itens, error } = await supabase.from('aniversarios')
    .select('id, user_id, grupo_id, nome, tipo, dia, mes, ano, lembrete_semana, lembrete_dia, observacao, aviso_semana_ano, aviso_dia_ano, created_at')
    .or(filtro);
  if (error) { if (!/aniversarios/i.test(error.message || '')) log.warn('[aniversarios] leitura falhou:', error.message); return r; }

  for (const aviso of avisosDoDia(itens, hoje)) {
    const { item, etapa, ano } = aviso;
    const col = etapa === 'semana' ? 'aviso_semana_ano' : 'aviso_dia_ano';
    try {
      if (!(await avisosLigados(item.user_id))) continue; // kill-switch: não marca (reativa depois)
      const phone = await phoneDoUser(item.user_id, item.grupo_id);
      if (!phone) continue;
      // Reserva atômica: só quem vira a marca envia.
      const anterior = item[col] ?? null;
      let q = supabase.from('aniversarios').update({ [col]: ano }).eq('id', item.id);
      q = anterior == null ? q.is(col, null) : q.eq(col, anterior);
      const { data: pego, error: e2 } = await q.select('id');
      if (e2 || !pego || !pego.length) continue;

      const criadoHoje = String(item.created_at || '').slice(0, 10) === hoje;
      if (etapa === 'dia' && !criadoHoje && (await briefingLigado(item.user_id))) { r.cobertosPeloBriefing++; continue; }

      const res = await enviar(phone, textoDoAviso(aviso), { seed: `${item.id}-${ano}-${etapa}` });
      if (res && res.ok) { r.enviados++; continue; }
      if (res && res.nadaSaiu) {
        // A Meta provou que nada saiu: desfaz a marca e tenta na próxima rodada.
        let u = supabase.from('aniversarios').update({ [col]: anterior }).eq('id', item.id);
        u = u.eq(col, ano);
        await u;
        r.tentarDeNovo++;
      } else r.falhas++; // ambígua: não repete (dois avisos iguais é pior)
    } catch (e) {
      r.falhas++;
      log.error(`[aniversarios] erro em ${item.id}:`, e.message);
    }
  }
  return r;
}

module.exports = {
  TIPOS, ANTECEDENCIA_DIAS, HORA_AVISO, LIM,
  dataNoAno, ocorrencias, proximaOcorrencia, anosEm, rotuloAnos, tituloDe,
  validarAniversario, avisosDoDia, paresDoDia, textoDoAviso, diaDaSemana, avisarAniversarios, somarDias, diasEntre,
};
