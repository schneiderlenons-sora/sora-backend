// =============================================================================
// Horário opcional da tarefa (migration 210). Puro — eval:tarefa-hora.
// =============================================================================

/** 'HH:MM' válido, ou null (sem horário). `undefined` = valor inválido. */
function normalizarHora(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return undefined;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * O que gravar a partir do corpo do pedido. Horário sem dia não existe: sem
 * data no pedido de CRIAÇÃO vale hoje; apagar a data apaga o horário.
 *
 * @returns { erro } | { campos }  — `campos` só traz o que deve ser escrito
 */
function camposDePrazo(corpo, { criando, hoje }) {
  const campos = {};
  if ('data_vencimento' in corpo) campos.data_vencimento = corpo.data_vencimento || null;
  if ('hora' in corpo) {
    const hora = normalizarHora(corpo.hora);
    if (hora === undefined) return { erro: 'Horário inválido. Use o formato 14:30.' };
    campos.hora = hora;
  }
  if (campos.hora && criando && !campos.data_vencimento) campos.data_vencimento = hoje;
  if (campos.hora && !criando && 'data_vencimento' in campos && !campos.data_vencimento) campos.data_vencimento = hoje;
  if ('data_vencimento' in campos && !campos.data_vencimento && !campos.hora) campos.hora = null;
  return { campos };
}

/** O erro é "a coluna `hora` ainda não existe" (migration 210 pendente)? */
function faltaColunaHora(error) {
  const m = String((error && error.message) || '');
  return /\bhora\b/.test(m) && /(column|schema cache|does not exist)/i.test(m);
}

/**
 * Lê tarefas pedindo a coluna `hora`; sem a 210, repete sem ela — a agenda e o
 * lembrete não podem sumir com as tarefas por causa de uma coluna nova.
 *
 * @param consultar (colunas) => Promise<{ data, error }>
 */
async function lerComHora(consultar, colunas) {
  const r = await consultar(`${colunas}, hora`);
  if (r.error && faltaColunaHora(r.error)) return consultar(colunas);
  return r;
}

module.exports = { normalizarHora, camposDePrazo, faltaColunaHora, lerComHora };
