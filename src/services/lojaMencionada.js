// =============================================================================
// QUAL LOJA A FRASE CITOU — Fase 4 do Negócios multiusuário.
//
// Quem opera 2+ lojas pelo WhatsApp precisa poder dizer "vendi 3 bolos na loja
// Centro". Até a fase 3 a venda caía na PRIMEIRA loja (com a confirmação
// nomeando qual) — agora, se a frase cita uma das lojas que a pessoa alcança,
// é nela que a venda entra.
//
// ⚠️ NÃO PARSEIA A GRAMÁTICA DA FRASE — casa contra o CONJUNTO CONHECIDO de
// nomes de loja. Tentar extrair "a loja X" por regex comeria o produto ou o
// cliente ("vendi na Casa da Maria" — Casa é loja? cliente?). Procurar os
// nomes REAIS das lojas dentro da mensagem é robusto e não inventa.
//
// ⚠️ NA DÚVIDA, NÃO ESCOLHE (devolve null → cai no comportamento de hoje, que
// não recusa a venda). Loja escolhida errada é pior que cair na primeira e
// nomear.
// =============================================================================

/** Sem acento, minúsculo, espaços normalizados. */
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '')      // tira diacríticos
    .replace(/[^a-z0-9\s]/g, ' ')          // pontuação vira espaço
    .replace(/\s+/g, ' ').trim();
}

/**
 * A empresa que a mensagem cita, ou `null` se nenhuma (ou ambíguo).
 *
 * @param mensagem  texto cru do usuário
 * @param empresas  [{ id, nome }] — as que a pessoa ALCANÇA (já filtradas)
 */
function acharLojaNaFrase(mensagem, empresas) {
  const msg = ` ${norm(mensagem)} `;
  if (!msg.trim() || !Array.isArray(empresas) || empresas.length < 2) return null;
  // Com 1 loja só não há o que escolher — quem chama já usa essa.

  const casam = [];
  for (const e of empresas) {
    const nome = norm(e && e.nome);
    // ⚠️ Nome curto demais casa por acaso ("MEI", "Loja"): exige 3+ e que a
    // ocorrência tenha FRONTEIRA (espaço antes e depois do nome inteiro), pra
    // "centro" não casar dentro de "centrofone".
    if (nome.length < 3) continue;
    if (msg.includes(` ${nome} `)) casam.push({ id: e.id, nome, orig: e });
  }
  if (casam.length === 0) return null;
  if (casam.length === 1) return casam[0].orig;

  // Mais de uma casou. Só resolve se a MAIS LONGA contém todas as outras — é o
  // caso "Centro" × "Centro Sul" numa frase que diz "centro sul": a específica
  // vence. Se forem lojas de fato diferentes citadas juntas, é ambíguo → null.
  const porTamanho = [...casam].sort((a, b) => b.nome.length - a.nome.length);
  const maior = porTamanho[0];
  const todasDentro = porTamanho.slice(1).every((c) => maior.nome.includes(c.nome));
  return todasDentro ? maior.orig : null;
}

module.exports = { acharLojaNaFrase, norm };
