// =============================================================================
// notasPainel — as NOTAS na aba Drive do painel (nov/2026, pedido de cliente:
// "Poderia ter um espaço para notas! Eu escrevo muito!").
//
// A tabela é a MESMA das notas do WhatsApp (`notas`, migration 063: "anota que
// …", "tive uma ideia …"). Antes elas só existiam no zap; agora o painel lista,
// cria, edita, fixa e apaga — e o "o que anotei sobre …" do WhatsApp continua
// lendo tudo, inclusive o que foi escrito no painel.
//
// Migration 203 traz `fixada` e `updated_at`. Sem ela: listar, criar, editar e
// apagar funcionam; só fixar responde "ainda sendo liberado".
//
// ⚠️ PRIVADO POR user_id, como Tarefas e Agenda: em gestão compartilhada cada
//    um vê só as próprias notas (o grupo_id é gravado, mas não filtra leitura).
// ⚠️ TEXTO NUNCA É CORTADO EM SILÊNCIO: quem "escreve muito" perderia o fim da
//    nota sem perceber. Passou do limite → erro dizendo o limite.
// =============================================================================

const LIMITES = { titulo: 200, texto: 50000, caderno: 40 };

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Limpa o que a tela mandou.
 * @param {object} body
 * @param {{ parcial?: boolean }} opts  parcial = edição (só os campos enviados)
 * @returns {{ ok: true, dados: object } | { ok: false, erro: string }}
 */
function limparNota(body, { parcial = false } = {}) {
  const b = body || {};
  const dados = {};

  if (!parcial || 'titulo' in b) {
    const t = str(b.titulo).replace(/\s+/g, ' ').trim();
    if (t.length > LIMITES.titulo) return { ok: false, erro: `O título pode ter até ${LIMITES.titulo} caracteres.` };
    dados.titulo = t || null;
  }
  if (!parcial || 'texto' in b) {
    // O texto fica como a pessoa escreveu (quebras de linha, espaços no meio).
    // Só sai o espaço sobrando no fim.
    const t = str(b.texto).replace(/\s+$/, '');
    if (t.length > LIMITES.texto) {
      return { ok: false, erro: `A nota passou do limite de ${LIMITES.texto.toLocaleString('pt-BR')} caracteres. Divida em duas.` };
    }
    dados.texto = t;
  }
  if (!parcial || 'categoria' in b) {
    const c = str(b.categoria).replace(/\s+/g, ' ').trim();
    if (c.length > LIMITES.caderno) return { ok: false, erro: `O nome do caderno pode ter até ${LIMITES.caderno} caracteres.` };
    dados.categoria = c || null;
  }
  if ('fixada' in b) {
    if (typeof b.fixada !== 'boolean') return { ok: false, erro: 'Valor inválido pra fixar.' };
    dados.fixada = b.fixada;
  }

  if (!parcial && !dados.titulo && !dados.texto) return { ok: false, erro: 'Escreva alguma coisa antes de salvar.' };
  if (parcial && !Object.keys(dados).length) return { ok: false, erro: 'Nada pra salvar.' };
  return { ok: true, dados };
}

/** Quando a nota mudou pela última vez (sem a 203, a data de criação). */
const momento = (n) => String((n && (n.updated_at || n.created_at)) || '');

/** Fixadas primeiro; dentro de cada grupo, a mexida mais recente primeiro. */
function ordenarNotas(lista) {
  return [...(lista || [])].sort((a, b) => {
    const fa = a && a.fixada ? 1 : 0;
    const fb = b && b.fixada ? 1 : 0;
    if (fa !== fb) return fb - fa;
    return momento(b).localeCompare(momento(a));
  });
}

/** O erro do banco é "coluna não existe" (migration 203 pendente)? */
const faltaColuna = (err) => /column|does not exist|schema cache/i.test(String((err && err.message) || err || ''));

module.exports = { LIMITES, limparNota, ordenarNotas, faltaColuna };
