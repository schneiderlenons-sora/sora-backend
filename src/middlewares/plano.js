const supabase = require('../db/supabase');
const { normalizarPlano } = require('../config/planos');

// Verifica se o usuário tem o plano exigido.
// Também checa plano_valido_ate: se expirado, trata como 'inativo' e
// atualiza a coluna em background (fire-and-forget) pra manter consistência.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ IDENTIFICA PELO JWT, NÃO PELO TELEFONE. Duas coisas quebravam aqui:
//
// 1. `req.body.phone` ESTOURAVA em requisição SEM CORPO. O backend roda
//    Express 5, onde `req.body` é `undefined` quando nada foi parseado (no
//    Express 4 vinha `{}`). Num DELETE — que não manda corpo — a linha
//    `req.params.phone || req.body.phone || ...` lançava
//    "Cannot read properties of undefined (reading 'phone')", a promise da
//    middleware rejeitava e o Express respondia com o HTML padrão
//    "Internal Server Error". Foi exatamente o que um cliente recebeu ao tentar
//    excluir um investimento (relato de 28/08/2026).
//
// 2. Mesmo com a guarda, o telefone NÃO EXISTE nessas rotas. `DELETE
//    /investimentos/:id` não tem `:phone`, não tem corpo e não tem query — ia
//    devolver 400 "phone não informado" pra sempre. Excluir investimento e
//    excluir meta de investimento estavam simplesmente inviáveis pelo painel.
//
// A identidade certa é a do JWT (`req.authUser`), que o middleware `auth` já
// resolveu. É a MESMA correção que o Grow recebeu em jul/2026 (routes/grow.js,
// saude.js, dados.js), quando editar tarefa/consulta dava 400 pelo mesmo
// motivo — só não tinha chegado aqui.
//
// O telefone continua valendo como FALLBACK: rotas antigas passam `:phone` na
// URL e há chamada interna que não carrega JWT.
// ─────────────────────────────────────────────────────────────────────────────
function exigirPlano(...planosPermitidos) {
  return async (req, res, next) => {
    try {
      // `req.body` pode ser undefined (Express 5, requisição sem corpo).
      const phone = req.params?.phone || req.body?.phone || req.query?.phone;
      const userId = req.authUser?.id;

      if (!userId && !phone) {
        return res.status(400).json({ erro: 'Não foi possível identificar o usuário.' });
      }

      // ⚠️ REAPROVEITA A LINHA QUE O `auth` JÁ LEU, quando ela é do MESMO
      // usuário. Antes esta middleware relia a mesma linha de `users` sempre —
      // uma ida a mais ao Supabase em toda rota gated, e o Render (Oregon) está
      // longe do banco (Ohio), então cada ida custa a travessia inteira.
      //
      // A comparação por `id` não é decoração: o `auth` pode não ter rodado
      // (chamada interna sem JWT) ou a rota pode ter caído no ramo do telefone.
      // Nesses casos `jaLida` é null e a consulta acontece como sempre.
      const jaLida = userId && req.authUser?.row?.id === userId ? req.authUser.row : null;

      // JWT primeiro: é quem a requisição REALMENTE é. O telefone é só o
      // endereço, e nem toda rota carrega um.
      let user = jaLida;
      if (!user) {
        const q = supabase.from('users').select('id, phone, plano, plano_valido_ate');
        const r = userId
          ? await q.eq('id', userId).maybeSingle()
          : await q.eq('phone', String(phone).replace(/\D/g, '')).maybeSingle();
        user = r.data;
      }

      if (!user) {
        return res.status(403).json({ erro: 'Usuário não encontrado' });
      }

      // `normalizarPlano` cobre o 'black' aposentado (migration 142): sem ele
      // uma linha esquecida cairia fora da lista e perderia acesso a tudo.
      let planoAtual = normalizarPlano(user.plano);

      // Expira o plano automaticamente se valido_ate for passado.
      //
      // ⚠️ `gratis` FICA DE FORA, junto do `inativo`. O modo manual não vence,
      // e nada deveria gravar `plano_valido_ate` nele — mas se algo gravar
      // (import, escrita manual no Supabase, rota futura), o usuário viraria
      // `inativo` sozinho e cairia no paywall sem ter cancelado nada. Barato
      // de proteger aqui, caro de descobrir depois.
      const venceAlgumDia = planoAtual !== 'inativo' && planoAtual !== 'gratis';
      if (venceAlgumDia && user.plano_valido_ate) {
        if (new Date(user.plano_valido_ate) < new Date()) {
          planoAtual = 'inativo';
          // Atualiza em background sem bloquear a requisição.
          // ⚠️ Por `id`, não por telefone: quem entrou pelo JWT pode nem ter
          // telefone vinculado — e aí o update não achava ninguém.
          supabase
            .from('users')
            .update({ plano: 'inativo' })
            .eq('id', user.id)
            .then(() => {})
            .catch(() => {});
        }
      }

      if (!planosPermitidos.includes(planoAtual)) {
        return res.status(403).json({
          erro: `Esta funcionalidade exige plano: ${planosPermitidos.join(' ou ')}`
        });
      }
      req.userPlano = planoAtual;
      next();
    } catch (err) {
      // Nunca deixar estourar pro handler padrão do Express: ele responde uma
      // página HTML de "Internal Server Error" que o painel não sabe ler e o
      // usuário recebe como um bloco de código na tela.
      console.error('[exigirPlano] erro:', err.message);
      return res.status(500).json({ erro: 'Erro ao verificar seu plano.' });
    }
  };
}

module.exports = { exigirPlano };
