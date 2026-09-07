// Autenticação real do usuário via JWT do Supabase.
// Antes: um token compartilhado (x-api-token) que vinha no bundle do cliente
// → qualquer um chamava a API e acessava dados de qualquer telefone (IDOR).
// Agora: exige o access token do usuário logado, valida no Supabase e
// AMARRA o request ao próprio usuário (sobrescreve o phone informado).
const supabase = require('../db/supabase');

// ── Cache curto da VALIDAÇÃO do token ──────────────────────────────────────
//
// `supabase.auth.getUser(jwt)` é uma ida de REDE ao Auth do Supabase, e ela
// acontecia em TODA chamada de API. Medido no `pg_stat_statements` do projeto:
// as 4 consultas que o Auth roda por validação (sessions, mfa_amr_claims,
// identities, users) somam ~3,2 MILHÕES de linhas devolvidas — de longe a
// maior carga identificável do banco, acima de qualquer consulta da Sora.
//
// O painel faz ~10 chamadas de API por tela aberta, todas com o MESMO token,
// em poucos segundos. Validar as 10 é pagar 10 vezes pela mesma resposta.
//
// ⚠️ O PREÇO É A REVOGAÇÃO DEMORAR ATÉ 60s. Deslogar em outro aparelho ou
// trocar a senha derruba a sessão no Auth, mas um token já validado seguiria
// aceito até o cache dele vencer. É uma janela pequena e limitada contra um
// token que, de qualquer forma, vale 1 HORA — e é o trade-off padrão de quem
// não valida na rede a cada request.
//
// ⚠️ NUNCA ALÉM DO `exp` DO PRÓPRIO TOKEN. Cache não pode ressuscitar token
// expirado: o vencimento do cache é o MENOR entre 60s e o `exp` do JWT.
//
// ⚠️ O QUE **NÃO** ENTRA NO CACHE É A LINHA DE `users`. Ela continua sendo
// lida a cada request, de propósito: é ali que mora o `plano`, e a tela de
// checkout fica consultando de 2 em 2 segundos esperando a ativação. Cachear
// isso faria o cliente que acabou de pagar continuar vendo "inativo".
const TTL_AUTH_MS = 60_000;
const TETO_CACHE  = 2000;          // trava de memória; o Render free é apertado
const cacheAuth = new Map();       // jwt → { user, ate }

/** `exp` do JWT em ms, sem verificar assinatura (quem verifica é o Auth). */
function expiraEm(jwt) {
  try {
    const [, corpo] = String(jwt).split('.');
    const p = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp * 1000 : 0;
  } catch { return 0; }
}

/** Valida o token, reaproveitando a resposta recente do Auth. */
async function validarToken(jwt) {
  const agora = Date.now();
  const hit = cacheAuth.get(jwt);
  if (hit && hit.ate > agora) return hit.user;
  if (hit) cacheAuth.delete(jwt);

  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) return null;

  // Vence junto com o token quando ele expira antes dos 60s.
  const exp = expiraEm(jwt);
  const ate = exp ? Math.min(agora + TTL_AUTH_MS, exp) : agora + TTL_AUTH_MS;
  if (ate > agora) {
    // Sem LRU: quando enche, esvazia. O custo é revalidar por um ciclo, e
    // isso é mais barato (e mais simples de acertar) que manter ordem de uso.
    if (cacheAuth.size >= TETO_CACHE) cacheAuth.clear();
    cacheAuth.set(jwt, { user, ate });
  }
  return user;
}

async function auth(req, res, next) {
  try {
    const header = req.headers['authorization'] || '';
    const jwt = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!jwt) return res.status(401).json({ erro: 'Não autenticado' });

    const user = await validarToken(jwt);
    if (!user) return res.status(401).json({ erro: 'Sessão inválida' });

    // Dados básicos do usuário (pra autorização por posse)
    //
    // ⚠️ `plano` e `plano_valido_ate` VÊM JUNTO DE PROPÓSITO. O `exigirPlano`
    // lia EXATAMENTE esta linha de novo, logo depois, só por essas duas colunas
    // — uma segunda ida ao Supabase pra um dado que já estava na mão. O Render
    // (Oregon) está longe do banco (Ohio), então o custo de uma ida é a
    // travessia, não o tamanho da query: pedir duas colunas a mais aqui é de
    // graça, e a leitura repetida lá custava uma viagem inteira.
    const { data: row } = await supabase
      .from('users')
      .select('id, phone, grupo_ativo, plano, plano_valido_ate')
      .eq('id', user.id)
      .maybeSingle();

    req.authUser = {
      id:         user.id,
      phone:      row?.phone || null,
      grupoAtivo: row?.grupo_ativo || null,
      // ⚠️ A linha CRUA, e não campos soltos: o `exigirPlano` precisa
      // distinguir "plano é null no banco" de "não consegui ler a linha". Com
      // campos soltos os dois casos ficariam `undefined` e um usuário sem linha
      // em `users` seria tratado como plano inativo em vez de reconsultado.
      row:        row || null,
    };

    // Anti-IDOR: rotas keyed por :phone na URL (ou ?phone=) resolvem o grupo
    // pelo telefone. Forçamos o telefone do PRÓPRIO usuário — bloqueia ler
    // dados de outra pessoa passando outro número. (body.phone NÃO é tocado:
    // ele é dado legítimo em algumas rotas, ex.: vincular WhatsApp / convite.)
    const phoneDoUsuario = req.authUser.phone || '__sem_phone__';
    if (req.params && Object.prototype.hasOwnProperty.call(req.params, 'phone')) {
      req.params.phone = phoneDoUsuario;
    }
    if (req.query && req.query.phone !== undefined) req.query.phone = phoneDoUsuario;

    // body.phone também é forçado ao do usuário (blinda os POST/PUT que
    // resolvem grupo por body.phone). Exceções: rotas onde o telefone é DADO
    // legítimo de outra pessoa — vincular WhatsApp e convite de grupo.
    const url = req.originalUrl || '';
    // /user/welcome: vincular WhatsApp de outra pessoa é dado legítimo.
    // (convite NÃO está mais aqui — agora usa o usuário autenticado, não body.phone)
    const phoneEhDado = url.includes('/user/welcome');
    if (!phoneEhDado && req.body && req.body.phone !== undefined) {
      req.body.phone = phoneDoUsuario;
    }

    next();
  } catch (e) {
    console.error('[auth] erro:', e.message);
    return res.status(401).json({ erro: 'Não autorizado' });
  }
}

module.exports = auth;
