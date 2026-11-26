// =============================================================================
// importarDesde — "Trazer movimentações a partir de [data]", por banco
// (of_conexoes.importar_desde, migration 202). Pedido de cliente (Tatiane) e
// decisão do dono em 26/11/2026.
//
// Ao conectar, o banco traz uns 90 dias de histórico (a sincronização
// automática relê 90 dias e o botão Atualizar, 180). Quem não quer o passado
// apagava à mão — e o Atualizar trazia meses que nunca tinham vindo. Com a data
// de corte:
//   · NENHUMA sincronização grava movimentação de dia anterior à data. O filtro
//     mora em `inserirTransacoes` (polpCelcoinSync): o resto do sync (fatura,
//     parcelas previstas, saldo, dedup do reprocesso) continua vendo o lote
//     inteiro, então nada além das linhas gravadas muda.
//   · Ao salvar, quem pede apaga as movimentações DO BANCO (com of_tx_id)
//     anteriores à data, só das contas e cartões DAQUELA conexão. O que a
//     pessoa digitou à mão fica.
//
// ⚠️ O DIA É O DE SÃO PAULO. `transacoes.data` guarda data pura (meia-noite
//    UTC) e instante real (a hora da compra); 23h de 31/08 no Brasil já é 01/09
//    em UTC. Mesma regra de `lib/data-br.ts` no painel.
// ⚠️ APAGAR NÃO GRAVA EM `of_tx_ignoradas`: quem impede a volta é o corte. Se a
//    pessoa mover a data pra trás, o que o banco ainda mandar dentro da janela
//    volta — é o que "a partir de" quer dizer.
// ⚠️ Saldo não muda: conta e cartão do Open Finance têm o saldo do BANCO.
// =============================================================================

const TZ = 'America/Sao_Paulo';
const SO_DATA = /^\d{4}-\d{2}-\d{2}$/;
const MEIA_NOITE_UTC = /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?(Z|\+00(:?00)?)$/;

/** Dia (YYYY-MM-DD) da transação em São Paulo. '' quando não dá pra saber. */
function diaSP(v) {
  if (!v) return '';
  const s = String(v);
  if (SO_DATA.test(s) || MEIA_NOITE_UTC.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** É uma data de calendário de verdade? (2026-02-30 não é.) */
function dataValida(s) {
  if (!SO_DATA.test(String(s || ''))) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Valida o que a tela mandou. `null`/'' = tirar o corte (trazer tudo).
 * @returns {{ ok: true, desde: string|null } | { ok: false, erro: string }}
 */
function validarImportarDesde(valor, { hoje }) {
  if (valor === null || valor === undefined || valor === '') return { ok: true, desde: null };
  const s = String(valor).trim();
  if (!dataValida(s)) return { ok: false, erro: 'Escolha uma data válida.' };
  if (s > hoje) return { ok: false, erro: 'A data não pode ser depois de hoje.' };
  return { ok: true, desde: s };
}

/**
 * A movimentação entra? Sem corte, tudo entra. Data que não dá pra ler ENTRA
 * (falha aberta: descartar em silêncio seria perder um lançamento real).
 */
function dentroDoCorte(data, desde) {
  if (!desde) return true;
  const dia = diaSP(data);
  if (!dia) return true;
  return dia >= desde;
}

/** O lote que a sincronização pode gravar. */
function filtrarPorCorte(txs, desde) {
  return (txs || []).filter((t) => t && dentroDoCorte(t.data, desde));
}

/**
 * Limite da consulta de candidatas a apagar: meia-noite de `desde` em São
 * Paulo (03:00 UTC). Pega todo instante anterior — e também a data pura do
 * PRÓPRIO dia `desde` (00:00 UTC), que `dentroDoCorte` devolve como dentro.
 * Por isso a lista do banco SEMPRE passa por `dentroDoCorte` antes de apagar.
 */
function limiteDaConsulta(desde) {
  return `${desde}T03:00:00.000Z`;
}

module.exports = {
  diaSP, dataValida, validarImportarDesde, dentroDoCorte, filtrarPorCorte, limiteDaConsulta,
};
