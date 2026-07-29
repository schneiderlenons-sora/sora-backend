// =====================================================================
// cicloFatura — CICLO REAL da fatura do cartão (fonte única da verdade).
//
// A fatura NÃO é o mês-calendário: ela vai do dia seguinte ao fechamento
// anterior até o dia do fechamento. Ex.: cartão que fecha dia 5 →
// ciclo 06/07 a 05/08 (uma compra em 30/07 e outra em 01/08 caem na MESMA
// fatura — era exatamente a queixa do cliente).
//
// CONVENÇÃO DE IDENTIDADE: `competencia` = 'YYYY-MM' do **VENCIMENTO**
// ("fatura de agosto" = a que vence em agosto, igual Nubank/Itaú). É a chave
// usada em pagamentos_fatura e fatura_rollover (migration 096) — e é única
// por ciclo, porque o vencimento avança exatamente 1 mês por ciclo.
//
// ⚠️ Aritmética: clamp ao ÚLTIMO DIA DO MÊS (nunca a 28). Cartão que fecha
// dia 31 fecha em 28/02 em fevereiro. O helper antigo (handlers/parcelas.js)
// clampava em 28 e estourava o mês em datas altas — 10 cartões da base têm
// fechamento > 28. Ciclos consecutivos são CONTÍGUOS (sem gap nem overlap).
//
// Cartão SEM dia_fechamento → cai no mês-calendário (comportamento legado),
// então quem não configurou o ciclo não sente mudança nenhuma.
//
// Espelhado em sora-frontend/lib/ciclo-fatura.ts — manter os dois em sincronia
// (há bateria de casos comparando as duas saídas).
// =====================================================================

const TZ = 'America/Sao_Paulo';

// Dias do mês (M0 = mês 0-based). Aceita M0 fora de 0..11 (normaliza o ano).
function ultimoDia(Y, M0) {
  return new Date(Date.UTC(Y, M0 + 1, 0)).getUTCDate();
}

// Meio-dia UTC evita que fuso/DST empurre a data pro dia vizinho.
function dataUTC(Y, M0, D) {
  return new Date(Date.UTC(Y, M0, D, 12));
}

const iso = (d) => d.toISOString().slice(0, 10);
const ym  = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const dm  = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

// Hoje no fuso de São Paulo, como 'YYYY-MM-DD' (não usar toISOString: é UTC).
function hojeSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

// Data do fechamento no mês (Y,M0), clampada ao último dia do mês.
function fechamentoDe(Y, M0, diaFechamento) {
  const dia = Math.max(1, Math.min(parseInt(diaFechamento, 10) || 1, 31));
  return dataUTC(Y, M0, Math.min(dia, ultimoDia(Y, M0)));
}

// Vencimento da fatura que fechou em `fim`: o próximo `diaVencimento` APÓS o
// fechamento (mesmo mês se cair depois; senão mês seguinte). Clampado.
function vencimentoApos(fim, diaVencimento) {
  const dia = Math.max(1, Math.min(parseInt(diaVencimento, 10) || 10, 31));
  let Y = fim.getUTCFullYear();
  let M0 = fim.getUTCMonth();
  let v = dataUTC(Y, M0, Math.min(dia, ultimoDia(Y, M0)));
  if (v <= fim) {
    M0 += 1;
    if (M0 > 11) { M0 = 0; Y += 1; }
    v = dataUTC(Y, M0, Math.min(dia, ultimoDia(Y, M0)));
  }
  return v;
}

// Ciclo cujo FECHAMENTO cai no mês (Y,M0).
// Retorna { ini, fim, fimExcl, venc, competencia, label } — datas 'YYYY-MM-DD'.
// `fimExcl` é exclusivo (pra usar direto em .lt('data', fimExcl)).
function cicloPorFechamento(Y, M0, diaFechamento, diaVencimento) {
  const fim = fechamentoDe(Y, M0, diaFechamento);
  // Fechamento anterior + 1 dia → garante contiguidade mesmo em mês curto.
  const antY = M0 === 0 ? Y - 1 : Y;
  const antM = M0 === 0 ? 11 : M0 - 1;
  const ini = new Date(fechamentoDe(antY, antM, diaFechamento));
  ini.setUTCDate(ini.getUTCDate() + 1);
  const fimExcl = new Date(fim);
  fimExcl.setUTCDate(fimExcl.getUTCDate() + 1);
  const venc = vencimentoApos(fim, diaVencimento);
  return {
    ini: iso(ini), fim: iso(fim), fimExcl: iso(fimExcl),
    venc: iso(venc), competencia: ym(venc),
    label: `${dm(ini)} a ${dm(fim)}`,
    porCiclo: true,
  };
}

// Fallback do mês-calendário (cartão sem dia_fechamento) — comportamento legado.
// Aqui competência = o próprio mês, e o "vencimento" é só rótulo.
function cicloMesCalendario(ym0, diaVencimento) {
  const [Y, M] = ym0.split('-').map(Number);
  const M0 = M - 1;
  const ini = dataUTC(Y, M0, 1);
  const fim = dataUTC(Y, M0, ultimoDia(Y, M0));
  const fimExcl = dataUTC(Y, M0 + 1, 1);
  const venc = diaVencimento
    ? dataUTC(Y, M0, Math.min(Math.max(parseInt(diaVencimento, 10) || 10, 1), ultimoDia(Y, M0)))
    : fim;
  return {
    ini: iso(ini), fim: iso(fim), fimExcl: iso(fimExcl),
    venc: iso(venc), competencia: ym0,
    label: `${dm(ini)} a ${dm(fim)}`,
    porCiclo: false,
  };
}

// Competência (YYYY-MM) da fatura "atual" de um cartão = a do PRÓXIMO
// vencimento a partir de hoje. Ex.: fecha 21 / vence 28, hoje 26/07 → a fatura
// que fechou em 21/07 vence 28/07 (ainda não venceu) → é a atual (comp 2026-07).
// Já em 29/07 a atual passa a ser a que fecha 21/08 (comp 2026-08).
function competenciaAtual(cartao, hojeStr) {
  const hoje = hojeStr || hojeSP();
  if (!cartao?.dia_fechamento) return hoje.slice(0, 7);
  const [Y, M] = hoje.split('-').map(Number);
  // Começa no ciclo que fechou no mês ANTERIOR: quando o vencimento é antes do
  // fechamento (ex.: fecha 24, vence 5), a fatura que vence hoje fechou no mês
  // passado — começar no mês de hoje pularia ela. Avança até venc >= hoje.
  for (let i = -1; i < 4; i++) {
    const c = cicloPorFechamento(Y, (M - 1) + i, cartao.dia_fechamento, cartao.dia_vencimento);
    if (c.venc >= hoje) return c.competencia;
  }
  return cicloPorFechamento(Y, M - 1, cartao.dia_fechamento, cartao.dia_vencimento).competencia;
}

// Resolve o ciclo de um cartão para uma competência ('YYYY-MM' do vencimento).
// Cartão sem dia_fechamento → mês-calendário. Sempre retorna um ciclo.
function cicloPorCompetencia(cartao, competencia) {
  const comp = /^\d{4}-\d{2}$/.test(competencia || '') ? competencia : hojeSP().slice(0, 7);
  if (!cartao?.dia_fechamento) return cicloMesCalendario(comp, cartao?.dia_vencimento);
  const [Y, M] = comp.split('-').map(Number);
  // O ciclo que vence em `comp` fecha no mesmo mês ou no anterior — testa os
  // dois (e vizinhos, por segurança) e devolve o que casa a competência.
  for (const off of [0, -1, 1, -2]) {
    const c = cicloPorFechamento(Y, (M - 1) + off, cartao.dia_fechamento, cartao.dia_vencimento);
    if (c.competencia === comp) return c;
  }
  // Não deveria acontecer; devolve o do mês pra nunca retornar null.
  return cicloPorFechamento(Y, M - 1, cartao.dia_fechamento, cartao.dia_vencimento);
}

// Navega entre faturas (delta em ciclos: -1 = anterior, +1 = próxima).
function competenciaVizinha(cartao, competencia, delta) {
  const base = cicloPorCompetencia(cartao, competencia);
  if (!cartao?.dia_fechamento) {
    const [Y, M] = base.competencia.split('-').map(Number);
    const d = new Date(Date.UTC(Y, (M - 1) + delta, 1, 12));
    return ym(d);
  }
  const [fY, fM] = base.fim.split('-').map(Number);
  return cicloPorFechamento(fY, (fM - 1) + delta, cartao.dia_fechamento, cartao.dia_vencimento).competencia;
}

module.exports = {
  TZ, hojeSP, ultimoDia, fechamentoDe, vencimentoApos,
  cicloPorFechamento, cicloMesCalendario,
  competenciaAtual, cicloPorCompetencia, competenciaVizinha,
};
