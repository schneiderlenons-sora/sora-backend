// =============================================================================
// POR QUE O CARTÃO NÃO VEIO NESTA CONEXÃO — fonte única.
//
// Relato de cliente (25/09/2026): o cartão do BTG não aparece. Ele removeu a
// conexão na Sora, removeu TODAS as conexões pelo app do BTG e reconectou do
// zero — três vezes. A conta vem; o cartão não, e a tela mandava reconectar.
//
// ⚠️ RECONECTAR ERA O CONSELHO ERRADO. Não traz o que o banco não libera, e
// cada volta cria um consentimento novo que a Polp COBRA. Quem responde aqui
// é o próprio banco, via `GET /consents/{id}/resources` (migration 175).
//
// Vive em arquivo próprio porque a decisão é testável e a rota não é: dentro
// do handler ela só poderia ser verificada por cópia no eval — e cópia que
// diverge é o defeito que este projeto mais paga caro.
// =============================================================================

/**
 * @param {object} p
 * @param {number} p.cartoes    quantos cartões a conexão JÁ trouxe
 * @param {string[]|null} p.produtos  produtos do consentimento (o que PEDIMOS)
 * @param {Array|null} p.recursos     [{type, status}] do banco (o que ELE tem)
 * @returns {'ok'|'a_caminho'|'temporario'|'falta_titular'|'indisponivel'|'inexistente'|'nao_pedido'|null}
 *   `null` = não sabemos, e aí a tela não afirma nada — melhor que afirmar errado.
 */
function statusCartao({ cartoes = 0, produtos = null, recursos = null } = {}) {
  if (cartoes) return 'ok';

  // Sem diagnóstico nenhum (a 175 ainda não rodou, ou o sync não leu os
  // recursos) o fluxo abaixo já termina em `null` sozinho — e é isso que faz
  // a tela não afirmar nada. Não há early return aqui de propósito: ele seria
  // uma linha que nenhum teste consegue matar, ou seja, ruído.

  // ⚠️ O QUE A SORA PEDIU VENCE O QUE O BANCO TEM. `criarConsentimento` tem
  // fallback em cascata e a última tentativa pede SÓ `ACCOUNT`: o
  // consentimento nasce autorizado e sem cartão. Aí o furo é NOSSO e
  // reconectar resolve — culpar o banco mandaria o cliente desistir de algo
  // que tem conserto.
  if (Array.isArray(produtos) && produtos.length
      && !produtos.includes('CREDIT_CARD_ACCOUNT')) return 'nao_pedido';

  const rec = Array.isArray(recursos)
    ? recursos.find((r) => r && r.type === 'CREDIT_CARD_ACCOUNT') : null;

  // Lista VAZIA é "não li", não "não tem" — não vira afirmação sobre o banco.
  if (!rec) return (Array.isArray(recursos) && recursos.length) ? 'inexistente' : null;

  // ⚠️ A doc da Celcoin separa os dois de propósito: TEMPORARILY_UNAVAILABLE
  // pede retry/polling, UNAVAILABLE é encerramento. Tratar como iguais manda
  // reconectar por uma indisponibilidade que passa sozinha.
  if (rec.status === 'AVAILABLE') return 'a_caminho';
  if (rec.status === 'TEMPORARILY_UNAVAILABLE') return 'temporario';
  if (rec.status === 'PENDING_AUTHORISATION') return 'falta_titular';
  // Status novo/desconhecido cai no conservador, nunca em "está vindo".
  return 'indisponivel';
}

module.exports = { statusCartao };
