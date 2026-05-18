const supabase = require('../db/supabase');

// Verifica se o usuário tem o plano exigido
function exigirPlano(...planosPermitidos) {
  return async (req, res, next) => {
    const phone = req.params.phone || req.body.phone || req.query.phone;
    if (!phone) return res.status(400).json({ erro: 'phone não informado' });

    const { data: user } = await supabase
      .from('users')
      .select('plano')
      .eq('phone', phone.replace(/\D/g, ''))
      .single();

    if (!user || !planosPermitidos.includes(user.plano)) {
      return res.status(403).json({
        erro: `Esta funcionalidade exige plano: ${planosPermitidos.join(' ou ')}`
      });
    }
    req.userPlano = user.plano;
    next();
  };
}

module.exports = { exigirPlano };