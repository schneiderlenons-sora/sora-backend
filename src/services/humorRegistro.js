// =============================================================================
// Registro de humor (Bem-estar do Grow) — regra única (eval:humor).
//
// Pedido de cliente (Tatiane, nov/2026): "permitir o registro retroativo de
// humor, selecionando a data, e editar a data de registros já feitos. Fui
// dormir depois da meia-noite e o app já considerava o dia seguinte".
//
// ⚠️ O "HOJE" ERA O DE LONDRES. Painel, rota e WhatsApp usavam
// `toISOString().slice(0, 10)` (UTC): das 21h à meia-noite no Brasil o humor
// já caía no dia SEGUINTE. Hoje é o dia de São Paulo (`hojeSP`, o mesmo do
// peso).
//
// Um registro por dia (unique grupo_id + user_id + data, migration 012):
// registrar de novo num dia substitui; mover um registro pra um dia que já
// tem outro é recusado (a pessoa escolhe qual fica).
// =============================================================================

const { hojeSP, somarDias } = require('./pesoRegistro');

/** Até quanto tempo pra trás dá pra registrar (esqueceu o diário). */
const DIAS_PRA_TRAS = 366;
const LIM = { nota: 400, gratidao: 80, itensGratidao: 3 };

function dataValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A data do registro: hoje (SP) quando não vem; nunca no futuro nem antes de 1 ano. */
function validarData(data, hoje = hojeSP()) {
  if (data == null || data === '') return { ok: true, data: hoje };
  const d = String(data).slice(0, 10);
  if (!dataValida(d)) return { ok: false, erro: 'Data inválida.' };
  if (d > hoje) return { ok: false, erro: 'Não dá pra registrar o humor de um dia que ainda não chegou.' };
  if (d < somarDias(hoje, -DIAS_PRA_TRAS)) return { ok: false, erro: 'Dá pra registrar até 1 ano pra trás.' };
  return { ok: true, data: d };
}

const intEntre = (v, a, b) => Number.isInteger(Number(v)) && Number(v) >= a && Number(v) <= b;

/**
 * O que a tela/o WhatsApp mandou, limpo. `parcial` = edição (só o que veio).
 * @returns {{ ok: true, dados } | { ok: false, erro }}
 */
function limparHumor(body, { parcial = false, hoje = hojeSP() } = {}) {
  const b = body || {};
  const tem = (k) => k in b;
  const dados = {};
  if (!parcial || tem('humor')) {
    if (!intEntre(b.humor, 1, 5)) return { ok: false, erro: 'Escolha o humor (de 1 a 5).' };
    dados.humor = Number(b.humor);
  }
  if (!parcial || tem('data')) {
    const v = validarData(b.data, hoje);
    if (!v.ok) return v;
    dados.data = v.data;
  }
  if (!parcial || tem('energia')) {
    if (b.energia == null || b.energia === '') dados.energia = null;
    else if (!intEntre(b.energia, 1, 5)) return { ok: false, erro: 'Energia vai de 1 a 5.' };
    else dados.energia = Number(b.energia);
  }
  if (!parcial || tem('sono_horas')) {
    if (b.sono_horas == null || b.sono_horas === '') dados.sono_horas = null;
    else {
      const h = Number(String(b.sono_horas).replace(',', '.'));
      if (!Number.isFinite(h) || h < 0 || h > 24) return { ok: false, erro: 'Horas de sono vão de 0 a 24.' };
      dados.sono_horas = Math.round(h * 10) / 10;
    }
  }
  if (!parcial || tem('nota')) {
    const n = String(b.nota == null ? '' : b.nota).trim();
    if (n.length > LIM.nota) return { ok: false, erro: `A anotação pode ter até ${LIM.nota} caracteres.` };
    dados.nota = n || null;
  }
  if (!parcial || tem('gratidao')) {
    const g = Array.isArray(b.gratidao) ? b.gratidao.map((x) => String(x == null ? '' : x).trim()).filter(Boolean) : [];
    if (g.length > LIM.itensGratidao) return { ok: false, erro: `São até ${LIM.itensGratidao} coisas de gratidão.` };
    if (g.some((x) => x.length > LIM.gratidao)) return { ok: false, erro: `Cada gratidão pode ter até ${LIM.gratidao} caracteres.` };
    dados.gratidao = g.length ? g : null;
  }
  if (parcial && !Object.keys(dados).length) return { ok: false, erro: 'Nada pra salvar.' };
  return { ok: true, dados };
}

module.exports = { DIAS_PRA_TRAS, LIM, hojeSP, validarData, limparHumor };
