// =============================================================================
// EVAL — RENOVAR a autorização do Open Finance sem derrubar conexão boa
//        e sem gerar consentimento (custo) à toa.
//
// POR QUE ISTO EXISTE. Um cliente com Santander não conseguia conectar:
//     "400 - invalid_request_uri: request_uri is invalid or expired"
//
// O erro vem do BANCO — `request_uri` é do PAR (RFC 9126), emitido pelo
// Santander, de USO ÚNICO e vida curta. Medido na base em 13/09/2026, o
// Santander é outlier de verdade (4 de 6 consentimentos morreram sem autorizar,
// 67%, contra 17% da base; Nubank 0/9 e Inter 0/4) — a falha não é do nosso
// fluxo. MAS o nosso fluxo transformava uma falha recuperável num BECO SEM
// SAÍDA, de dois jeitos:
//
//   1. o botão "Autorizar" reentregava a MESMA URL de uso único (só o
//      POST /consents/{id}/recreate a renova, e nós nunca o chamávamos);
//   2. o consentimento morto seguia ocupando vaga do plano, então "Conecte de
//      novo" — a mensagem que o próprio sync grava — dava 409 limite_conexoes.
//
// ⚠️ O QUE ESTE EVAL PROTEGE são as duas travas que impedem a correção de virar
// um problema PIOR que o original: revogar a conexão de quem está bem, e criar
// consentimento cobrado a cada clique.
//
// Rodar:  npm run eval:reautorizar
// =============================================================================
const C = require('../src/services/polpCelcoin');
const P = require('../src/services/openFinanceProvider');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

const AGORA = new Date('2026-09-13T12:00:00-03:00').getTime();
const emiteHa = (ms) => new Date(AGORA - ms + C.VIDA_URL_MS).toISOString();
const consent = (extra) => ({
  status: 'AWAITING_AUTHORIZATION',
  url_to_authenticate: 'https://auth.santander.com.br/?request_uri=urn:x:abc',
  url_to_authenticate_expires_at: emiteHa(5 * 60 * 1000),
  ...extra,
});

// ── 1. A TRAVA DE SEGURANÇA: conexão viva NUNCA é recriada ─────────────────
// A doc da Polp: recriar um consentimento AUTORISED faz ela REVOGAR o atual
// antes de criar o novo. Se esta regra afrouxar, um clique no botão apaga a
// conexão de alguém que estava funcionando — muito pior que o bug de origem.
console.log('── 1. conexão viva é intocável ──');
ok(C.precisaRenovar(consent({ status: 'AUTHORISED' }), AGORA) === false,
  'AUTHORISED nunca renova (recriar REVOGARIA a conexão boa)');
ok(C.precisaRenovar(consent({ status: 'UPDATED' }), AGORA) === false,
  'UPDATED nunca renova');
ok(P.ehConexaoViva('updated') && P.ehConexaoViva('authorised') && P.ehConexaoViva('AUTHORISED'),
  'status vivo é reconhecido em qualquer caixa');
ok(!P.ehConexaoViva('expired') && !P.ehConexaoViva('rejected')
  && !P.ehConexaoViva('waiting_user_input') && !P.ehConexaoViva('awaiting_authorization'),
  'status morto/pendente NÃO é vivo');
// ⚠️ ALLOWLIST, não denylist: status novo que a Polp inventar amanhã cai como
// "não vivo", e o pior caso é o usuário refazer a autorização. Na lógica
// invertida o pior caso seria PERDER a conexão.
ok(!P.ehConexaoViva('status_que_nao_existe_ainda'),
  'status desconhecido é tratado como NÃO vivo (lado seguro)');
ok(!P.ehConexaoViva(null) && !P.ehConexaoViva(undefined) && !P.ehConexaoViva(''),
  'status ausente não é vivo');
console.log('  ok');

// ── 2. A TRAVA DE CUSTO: clique duplo não vira consentimento duplicado ─────
// A Polp cobra por consentimento ATIVO, então tentativa morta não entra na
// conta — mas criar um registro a cada toque é desperdício e polui a lista.
console.log('── 2. URL recém-emitida é reaproveitada ──');
ok(C.precisaRenovar(consent({ url_to_authenticate_expires_at: emiteHa(5 * 1000) }), AGORA) === false,
  'emitida há 5s: reaproveita (é o clique duplo)');
ok(C.precisaRenovar(consent({ url_to_authenticate_expires_at: emiteHa(119 * 1000) }), AGORA) === false,
  'emitida há 119s: ainda dentro da janela');
ok(C.precisaRenovar(consent({ url_to_authenticate_expires_at: emiteHa(121 * 1000) }), AGORA) === true,
  'emitida há 121s: renova');
console.log('  ok');

// ── 3. O PADRÃO É RENOVAR — "não venceu" não quer dizer "serve" ────────────
// É o coração do bug: o `request_uri` é de uso único e a API não conta se já
// foi consumido. Uma URL válida de 10 minutos atrás pode estar morta, e era
// justamente ela que o botão reentregava para sempre.
console.log('── 3. o padrão é renovar ──');
ok(C.precisaRenovar(consent(), AGORA) === true,
  'URL válida mas de 5 min atrás: RENOVA (uso único, pode já ter sido gasta)');
ok(C.precisaRenovar(consent({ url_to_authenticate_expires_at: emiteHa(59 * 60 * 1000) }), AGORA) === true,
  'quase vencendo: renova');
ok(C.precisaRenovar(consent({
  url_to_authenticate_expires_at: new Date(AGORA - 1000).toISOString(),
}), AGORA) === true, 'vencida: renova');
console.log('  ok');

// ── 4. Dado faltando nunca vira "está tudo bem" ────────────────────────────
console.log('── 4. dado ausente/estranho ──');
ok(C.precisaRenovar(null, AGORA) === true, 'sem consentimento: renova');
ok(C.precisaRenovar(undefined, AGORA) === true, 'undefined: renova');
ok(C.precisaRenovar(consent({ url_to_authenticate: null }), AGORA) === true,
  'sem URL nenhuma: renova');
ok(C.precisaRenovar(consent({ url_to_authenticate_expires_at: null }), AGORA) === true,
  'sem expiração: renova (não dá pra afirmar que serve)');
ok(C.precisaRenovar(consent({ url_to_authenticate_expires_at: 'nao-e-data' }), AGORA) === true,
  'expiração ilegível: renova');
// A forma camelCase é a que sai do nosso próprio cliente — as duas convivem.
ok(C.precisaRenovar({
  status: 'AWAITING_AUTHORIZATION', urlToAuthenticate: 'https://x',
  urlExpiraEm: emiteHa(10 * 1000),
}, AGORA) === false, 'aceita o payload camelCase do nosso cliente');
console.log('  ok');

// ── 5. Só o Celcoin sabe recriar ───────────────────────────────────────────
// No trilho Pluggy legado não existe /recreate. A rota decide por
// `typeof p.recriarConexao === 'function'` — se isto virar um stub que lança,
// o caminho antigo quebra em vez de ser ignorado.
console.log('── 5. fronteira entre os dois trilhos ──');
ok(typeof P.para('polp-celcoin').recriarConexao === 'function', 'Celcoin recria');
ok(typeof P.para('polp').recriarConexao === 'undefined',
  'Pluggy NÃO expõe recriarConexao (a rota cai no caminho antigo)');
console.log('  ok');

// ── 6. Reuso da tentativa morta: TODAS mortas, nunca ALGUMA ───────────────
// Medido na base em 13/09/2026: 4 pares (usuário, banco) têm MAIS DE UMA
// conexão — Nubank, Itaú, Mercado Pago e o próprio Santander. Ter duas contas
// no mesmo banco é caso REAL, não hipótese. Se alguma está VIVA, quem clica
// "conectar" quer uma SEGUNDA conta (outro CPF), e reaproveitar a morta
// entregaria a autorização do CPF ERRADO — o `recreate` mantém o CPF do
// consentimento original (doc da Polp).
console.log('── 6. reuso da tentativa morta ──');
{
  const morta  = { external_id: 'm1', status: 'expired', ultima_sync: null };
  const morta2 = { external_id: 'm2', status: 'waiting_user_input', ultima_sync: null };
  const viva   = { external_id: 'v1', status: 'updated', ultima_sync: '2026-09-13T10:00:00Z' };
  const zumbi  = { external_id: 'z1', status: 'expired', ultima_sync: '2026-08-01T10:00:00Z' };

  ok(P.escolherTentativaMorta([morta])?.external_id === 'm1',
    'uma morta sozinha: reaproveita (é o caso do cliente do relato)');
  ok(P.escolherTentativaMorta([morta2, morta])?.external_id === 'm2',
    'duas mortas: pega a MAIS RECENTE (as 2 tentativas em 55 min)');
  ok(P.escolherTentativaMorta([viva, morta]) === null,
    'com uma VIVA junto: NÃO reaproveita (entregaria o CPF errado)');
  ok(P.escolherTentativaMorta([viva]) === null, 'só viva: nada a reaproveitar');
  // ⚠️ Já trouxe dado alguma vez = conexão REAL, ainda que o status esteja
  // estranho hoje. Recriar por aqui mexeria numa conexão de verdade.
  ok(P.escolherTentativaMorta([zumbi]) === null,
    'expirada mas que JÁ SINCRONIZOU não é tentativa morta');
  ok(P.escolherTentativaMorta([]) === null && P.escolherTentativaMorta(null) === null,
    'lista vazia/ausente não inventa reuso');
}
console.log('  ok');
console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  console.log('\n── Falhas ──');
  falhas.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
