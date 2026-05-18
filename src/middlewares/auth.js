// Protege os endpoints da API com um token secreto
function auth(req, res, next) {
  const token = req.query.token || req.headers['x-api-token'];
  if (!process.env.API_SECRET_TOKEN || token === process.env.API_SECRET_TOKEN) {
    return next();
  }
  res.status(401).json({ erro: 'Não autorizado' });
}

module.exports = auth;