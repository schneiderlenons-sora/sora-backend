// =============================================================================
// Limpa caracteres INVISÍVEIS de formatação da mensagem que chega pelo WhatsApp.
//
// Achado em nov/2026: o script de rastreio da UTMify (carregado no painel
// inteiro) reescreve os links do wa.me e enfia 8 caracteres invisíveis depois
// da primeira letra do texto pronto — "gastei 50" chegava como "g\u206C\u206D\u206C\u206D…astei 50".
// Os exemplos da aba WhatsApp do painel e o "testar" dos comandos chegavam
// assim, e o leitor local (interpretarRapido) não reconhecia mais o comando:
// caía na IA ou virava "não entendi". Texto colado de outros apps traz os
// mesmos caracteres.
//
// ⚠️ O ZWJ (U+200D) FICA: é ele que junta emojis compostos (👨\u200D👩\u200D👧, 👍🏽).
// Tirar só os de FORMATAÇÃO, que não têm significado no texto.
// =============================================================================

// U+200B espaço de largura zero · U+200C não-juntor · U+200E/U+200F marcas de
// direção · U+2060–U+206F juntor de palavra, operadores invisíveis, isoladores
// de direção e os formatadores antigos (U+206C/U+206D, os da marca de rastreio)
// · U+FEFF BOM.
const INVISIVEIS = /[\u200B\u200C\u200E\u200F\u2060-\u206F\uFEFF]/g;

function limparInvisiveis(texto) {
  if (typeof texto !== 'string') return texto;
  return texto.replace(INVISIVEIS, '');
}

module.exports = { limparInvisiveis };
