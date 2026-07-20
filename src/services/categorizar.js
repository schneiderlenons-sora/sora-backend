// =====================================================================
// Auto-categorização por descrição (Open Finance / Pluggy / OFX / WhatsApp).
// ESPELHA o lib/categorizar.ts do FRONTEND — manter os dois em sincronia.
// Retorna o NOME SIMPLES da categoria (sem emoji); o painel casa por nome
// normalizado, então "Mercado" agrupa em "🛒 Mercado", etc.
//
// Ordem das regras IMPORTA: marca/específico antes de genérico. Keywords
// curtas (<4 letras) casam só como palavra inteira (evita falso positivo).
// =====================================================================

function normalizar(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// substring p/ palavras longas (>=4); palavra inteira p/ curtas.
// Prefixo '=' força palavra inteira mesmo em kw longa — pra kw que é sufixo de
// outra palavra comum (ex.: '=racao', senão "libeRACAO"/"decoRACAO" viram Pet).
function casa(texto, kw) {
  const exato = kw[0] === '=';
  const k = exato ? kw.slice(1) : kw;
  if (!exato && k.length >= 4) return texto.includes(k);
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${esc}(\\s|$)`).test(texto);
}

// Taxonomia v3 (ver sql/084_categorias_v3.sql). Marca conhecida → subcategoria
// da marca (nesta certa + logo no painel). Senão, keyword → subcategoria óbvia
// ou categoria-pai. Ordem: MAIS específico → genérico.
const REGRAS = [
  // ── Encomendas / Compras (marcas) — antes de tudo ──
  // "amazon prime" é streaming, não marketplace → checa ANTES de 'amazon'.
  { cat: 'Prime Video',    kws: ['amazon prime', 'prime video', 'primevideo'] },
  { cat: 'Mercado Livre',  kws: ['mercado livre', 'mercadolivre', 'mercadolibre', 'meli '] },
  { cat: 'Amazon',         kws: ['amazon', 'amzn'] },
  { cat: 'Shopee',         kws: ['shopee'] },
  { cat: 'Aliexpress',     kws: ['aliexpress', 'ali express'] },
  { cat: 'TikTok Shop',    kws: ['tiktok shop', 'tiktok', 'tik tok'] },
  { cat: 'Shein',          kws: ['shein'] },
  { cat: 'Nike',           kws: ['nike'] },
  { cat: 'Adidas',         kws: ['adidas'] },
  { cat: 'Encomendas',     kws: ['magazine luiza', 'magalu', 'americanas', 'casas bahia', 'submarino', 'kabum', 'pichau', 'terabyte', 'temu', 'wish', 'enjoei', 'pontofrio', 'ponto frio', 'fastshop', 'fast shop', 'shopify'] },

  // ── Assinatura da Sora (EC*SORA no extrato) — antes do genérico ──
  { cat: 'Assinaturas',    kws: ['ec sora', 'forsora', 'sora ai'] },

  // ── Trabalho / Negócio (anúncios e ferramentas) ──
  { cat: 'Facebook Ads',   kws: ['facebk', 'facebook ad', 'fb ads', 'meta ads', 'meta plataform', 'instagram ad'] },
  { cat: 'Google Ads',     kws: ['google ads', 'googleads', 'google adwords'] },
  { cat: 'Trabalho/Negócio', kws: ['tiktok ads', 'kwai for business', 'linkedin ads', 'mailchimp', 'fornecedor', 'frete', 'transportadora', 'embalagem', 'correios sedex'] },

  // ── Transferências / Pix / estornos (não-consumo) ──
  { cat: 'Transferências', kws: ['mercado pago', 'mercadopago', 'pix enviado', 'pix recebido', 'pix ', 'ted ', 'doc ', 'transferencia', 'transferencias', 'transf ',
      'venda cancelada', 'liberacao de dinheiro', 'estorno', 'devolucao', 'reembolso', 'chargeback', 'dinheiro recebido', 'boleto'] },

  // ── Delivery (marcas) — ANTES de comida genérica. "Zé Delivery" ≠ "delivery". ──
  { cat: 'iFood',          kws: ['ifood', 'i food'] },
  { cat: 'AiqFome',        kws: ['aiqfome', 'aiq fome'] },
  { cat: 'Zé Delivery',    kws: ['ze delivery', 'zedelivery', 'ze entrega'] },
  { cat: 'Rappi',          kws: ['rappi'] },
  { cat: 'Delivery',       kws: ['uber eats', 'ubereats', 'james delivery', 'delivery', 'tele entrega', 'daki', 'zé delivery'] },

  // ── Alimentação (subcategorias: Café, Padaria, Supermercado, Lanches, Restaurante) ──
  { cat: 'Café',           kws: ['cafeteria', 'starbucks', 'the coffee', 'kopenhagen', 'cacau show', 'cafe ', 'coffee'] },
  { cat: 'Padaria',        kws: ['padaria', 'panificadora', 'panific'] },
  { cat: 'Supermercado',   kws: ['mercado', 'supermercado', 'super mercado', 'atacad', 'atacarejo', 'carrefour', 'assai', 'assaí',
      'pao de acucar', 'extra hiper', 'bompreco', 'hortifruti', 'sams club', 'sam s club', 'makro', 'tenda atac',
      'dia supermercado', 'sonda', 'st marche', 'mambo', 'natural da terra', 'sacolao', 'quitanda', 'hipermercado',
      'mercearia', 'prezunic', 'guanabara', 'zona sul', 'verdemar', 'cometa supermercados',
      'creme de leite', 'creme de avela'] },   // ANTES do Autocuidado: "creme" lá é cosmético
  { cat: 'Lanches',        kws: ['lanchonete', 'lanches', 'lanche', 'hamburgueria', 'burger king', 'burguer', 'hamburgu', 'hamburguer',
      'mcdonald', 'mc donalds', 'bobs', 'subway', 'cheeseburger', 'x-tudo', 'x-salada', 'x-burguer', 'x-bacon', 'cachorro quente',
      'cachorro-quente', 'hot dog', 'hotdog', 'misto quente', 'sandui', 'sanduba', 'bauru', 'beirute', 'batata frita', 'porcao',
      'coxinha', 'coxinhas', 'pastel', 'pasteis', 'esfiha', 'esfirra', 'kibe', 'quibe', 'empada', 'empadao', 'enroladinho',
      'risole', 'rissole', 'bolinho', 'salgad', 'pao de queijo', 'pastelaria', 'tapioca', 'crepe', 'creperia', 'tapiocaria',
      'acaraje', 'food truck', 'foodtruck', 'food park', 'petiscaria', 'trailer de', 'quiosque', 'pipoca', 'churros'] },
  { cat: 'Restaurante',    kws: ['restaurante', 'restaur', 'pizzaria', 'pizza', 'outback', 'habibs', 'spoleto', 'dominos',
      'china in box', 'sushi', 'temaki', 'churrascaria', 'espetinho', 'sorveteria', 'acai', 'doceria', 'confeitaria', 'marmita',
      'self service', 'rotisseria', 'boteco', 'comida', 'galeto', 'frango assado', 'refeicao', 'refeicoes', 'prato feito',
      'prato do dia', 'marmit', 'marmitex', 'quentinha', 'buffet', 'bufe', 'por quilo', 'rodizio', 'yakisoba', 'lamen',
      'macarrao', 'lasanha', 'nhoque', 'feijoada', 'strogonoff', 'estrogonofe', 'parmegiana', 'churrasco'] },

  // ── Transporte (subcategorias: Combustível, apps, Estacionamento, Pedágio…) ──
  { cat: 'Uber',           kws: ['uber'] },
  { cat: '99',             kws: ['99app', '99 pop', '99pop', '99 tecnologia', '99 taxi'] },
  { cat: 'Blablacar',      kws: ['blablacar', 'bla bla car'] },
  { cat: 'Combustível',    kws: ['posto', 'ipiranga', 'shell ', 'petrobras', 'br mania', 'gasolina', 'combustivel', 'etanol', 'diesel', 'alcool posto'] },
  { cat: 'Estacionamento', kws: ['estacionamento', 'estapar', 'zona azul', 'estar zona'] },
  { cat: 'Pedágio',        kws: ['pedagio', 'sem parar', 'conectcar', 'veloe', 'move mais', 'ccr ', 'ecovias', 'artesp'] },
  { cat: 'Manutenção do veículo', kws: ['oficina mecanica', 'borracharia', 'autopecas', 'auto pecas', 'auto center', 'funilaria', 'troca de oleo'] },
  { cat: 'Transporte',     kws: ['cabify', 'indrive', 'in drive', 'metro', 'metrô', 'cptm', 'bilhete unico', 'sptrans', 'onibus',
      'passagem rodoviaria', 'buser', 'licenciamento', 'taxi', 'brt'] },

  // ── Compras (roupa/calçado/eletrônico) ──
  { cat: 'Calçados',       kws: ['centauro', 'netshoes', 'dafiti', 'calcados', 'sapataria', 'arezzo', 'melissa', 'olympikus', 'mizuno', 'usaflex'] },
  { cat: 'Eletrônicos',    kws: ['kabum', 'fast shop', 'samsung', 'apple store', 'iplace', 'girafa', 'eletronico'] },
  { cat: 'Roupas',         kws: ['renner', 'riachuelo', 'pernambucanas', 'marisa', 'c&a ', 'c e a ', 'zara', 'hering', 'puma', 'reserva ',
      'youcom', 'leader', 'calvin klein', 'tommy', 'decathlon', 'track field', 'osklen', 'colcci', 'lojas avenida', 'besni', 'roupa', 'vestuario'] },

  // ── Autocuidado ──
  { cat: 'Barbeiro',       kws: ['barbearia', 'barbeiro', 'barber'] },
  { cat: 'Salão de beleza',kws: ['salao de beleza', 'salao', 'cabeleireiro', 'cabelereiro', 'sobrancelha', 'depilacao'] },
  { cat: 'Manicure',       kws: ['manicure', 'pedicure', 'nail', 'unhas'] },
  { cat: 'Autocuidado',    kws: ['dermatolog', 'esteticista', 'estetica', 'cirurgia plastica',
      'botox', 'harmoniza', 'preenchimento facial', 'corte de cabelo',
      'creme', 'perfume', 'pomada', 'hidratante', 'shampoo', 'xampu', 'condicionador', 'sabonete', 'desodorante',
      'protetor solar', 'maquiagem', 'batom', 'cosmetic', 'skincare', 'esmalte', 'barbeador', 'gilete',
      'escova de dente', 'creme dental', 'fio dental', 'enxaguante', 'boticario', 'natura', 'sephora', 'perfumaria', 'quem disse berenice', 'avon',
      'massagem', 'spa ', 'tatuagem', 'piercing'] },

  // ── Dieta / suplementos ──
  { cat: 'Dieta',          kws: ['whey', 'creatina', 'bcaa', 'suplemento', 'hipercalorico', 'pre treino', 'pre-treino',
      'maltodextrina', 'albumina', 'growth', 'max titanium', 'integralmedica', 'probiotica', 'vitamina', 'multivitaminico',
      'isotonico', 'gatorade', 'colageno', 'termogenico'] },

  // ── Academia / Fitness ──
  { cat: 'Academia',       kws: ['academia', 'smartfit', 'smart fit', 'bodytech', 'bioritmo', 'bio ritmo', 'selfit', 'bluefit',
      'crossfit', 'personal trainer', 'pilates', 'tecnofit', 'totalpass', 'gympass', 'wellhub'] },

  // ── Esporte ──
  { cat: 'Esporte',        kws: ['futebol', 'society', 'quadra de', 'aluguel de quadra', 'beach tennis', 'futevolei', 'volei',
      'basquete', 'jiu jitsu', 'jiujitsu', 'muay thai', 'karate', 'judo', 'natacao', 'tenis '] },

  // ── Assinaturas / Streaming (marcas) ──
  { cat: 'Netflix',        kws: ['netflix'] },
  { cat: 'Spotify',        kws: ['spotify'] },
  { cat: 'Disney+',        kws: ['disney'] },
  { cat: 'Prime Video',    kws: ['prime video', 'primevideo', 'amazon prime'] },
  { cat: 'HBO Max',        kws: ['hbomax', 'hbo max', 'hbo', 'max stream'] },
  { cat: 'Globo Play',     kws: ['globoplay', 'globo play'] },
  { cat: 'Assinaturas',    kws: ['youtube premium', 'youtube music', 'deezer', 'tidal', 'apple music', 'apple com bill', 'apple.com bill',
      'canva', 'notion', 'chatgpt', 'openai', 'midjourney', 'adobe', 'office 365', 'microsoft 365', 'google one', 'icloud',
      'paramount', 'crunchyroll', 'star plus', 'starplus', 'mubi', 'telecine', 'dropbox', 'linkedin premium', 'assinatura'] },

  // ── Saúde (Farmácia, Plano, Dentista, Psicólogo, Exames, Consultas) ──
  { cat: 'Plano de Saúde', kws: ['unimed', 'amil', 'hapvida', 'notredame', 'paz eterna', 'sulamerica', 'sul america',
      'golden cross', 'prevent senior', 'porto seguro saude', 'bradesco saude', 'plano de saude'] },
  { cat: 'Dentista',       kws: ['dentista', 'odontolog', 'odonto'] },
  { cat: 'Psicólogo',      kws: ['psicolog', 'psiquiatra', 'terapia', 'terapeuta'] },
  { cat: 'Exames',         kws: ['exame', 'laboratorio', 'fleury', 'sabin', 'hermes pardini', 'raio x', 'ultrassom', 'ressonancia', 'tomografia'] },
  { cat: 'Farmácia',       kws: ['farmacia', 'drogaria', 'drogasil', 'droga raia', 'pacheco', 'pague menos', 'panvel', 'raia ',
      'extrafarma', 'venancio', 'nissei', 'ultrafarma', 'remedio'] },
  { cat: 'Consultas',      kws: ['otorrino', 'fisioterap', 'cardiolog', 'ortoped', 'pediatra', 'ginecolog', 'urolog', 'oftalmo',
      'neurolog', 'endocrino', 'reumatolog', 'clinico geral', 'consulta medica', 'medico', 'hospital', 'clinica'] },
  { cat: 'Saúde',          kws: ['nutricionista', 'nutrolog', 'vacina', 'otica', 'oculos'] },

  // ── Família / Pet ──
  { cat: 'Pet',            kws: ['petz', 'cobasi', 'petlove', 'veterinari', 'pet shop', 'petshop', 'pet center', 'clinipet', 'agropet', '=racao'] },
  { cat: 'Família',        kws: ['fralda', 'creche', 'bercario', 'mesada', 'escolinha', 'brinquedo', 'ri happy', 'pbkids'] },

  // ── Educação ──
  { cat: 'Educação',       kws: ['udemy', 'coursera', 'alura', 'duolingo', 'rocketseat', 'hotmart', 'escola', 'colegio',
      'faculdade', 'universidade', 'uninter', 'estacio', 'anhanguera', 'qconcursos', 'gran cursos', 'mensalidade escolar',
      'livraria', 'saraiva', 'papelaria', 'kumon', 'wizard', 'ccaa', 'fisk', 'cna ', 'curso de'] },

  // ── Lazer ──
  { cat: 'Lazer',          kws: ['cinema', 'cinemark', 'kinoplex', 'ingresso', 'sympla', 'eventim', 'show ', 'teatro',
      'parque', 'hopi hari', 'beto carrero', 'steam', 'playstation', 'xbox', 'nintendo', 'riot games', 'epic games', 'twitch',
      'boliche', 'balada', 'bar ', 'pub ', 'cervejaria', 'festa', 'evento'] },

  // ── Viagem → subcategoria de Lazer ("Viagem") ──
  { cat: 'Viagem',         kws: ['latam', 'gol linhas', 'azul linhas', 'azul viagens', 'smiles', 'decolar', '123 milhas',
      'cvc ', 'maxmilhas', 'expedia', 'hoteis com', 'airbnb', 'booking', 'hotel', 'pousada', 'hostel', 'resort',
      'rentcars', 'localiza', 'movida', 'unidas', 'rent a car'] },

  // ── Tecnologia (telecom/celular/cloud) ──
  { cat: 'Tecnologia',     kws: ['vivo fibra', 'vivo ', 'claro net', 'claro ', 'oi fibra', 'tim sa', 'tim celular', 'net servicos',
      'sky ', 'telefonica', 'recarga celular', 'google play', 'app store', 'aws ', 'google cloud', 'azure', 'godaddy', 'hostgator', 'hostinger'] },

  // ── Moradia (contas de casa → subcategorias) ──
  { cat: 'Internet',       kws: ['internet', 'banda larga', 'fibra otica', 'tv por assinatura'] },
  { cat: 'Conta de Luz',   kws: ['enel', 'cpfl', 'light ', 'cemig', 'copel', 'celpe', 'coelba', 'energisa', 'equatorial energia',
      'elektro', 'energia eletrica', 'conta de luz', 'conta de energia', 'energia'] },
  { cat: 'Água',           kws: ['sabesp', 'cedae', 'copasa', 'sanepar', 'caesb', 'embasa', 'conta de agua', 'saneamento'] },
  { cat: 'Gás',            kws: ['comgas', 'gas natural', 'ultragaz', 'liquigas', 'botijao', 'gas de cozinha'] },
  { cat: 'Condomínio',     kws: ['condominio', 'taxa condominio'] },
  { cat: 'IPTU',           kws: ['iptu'] },
  { cat: 'Aluguel',        kws: ['aluguel', 'imobiliaria', 'quintoandar', 'quinto andar', 'locacao imovel'] },
  { cat: 'Moradia',        kws: ['construtora', 'leroy merlin', 'telhanorte', 'tok stok', 'madeira madeira', 'mobly',
      'casa bahia moveis', 'material de construcao', 'reforma'] },

  // ── Financeiro (juros, tarifas, impostos, empréstimos) ──
  { cat: 'Financiamento',  kws: ['financiamento', 'consorcio', 'prestacao veiculo'] },
  { cat: 'Financeiro',     kws: ['darf', 'ipva', 'imposto', 'receita federal', 'detran', 'multa de transito', 'tarifa bancaria',
      'tarifa mensal', 'anuidade cartao', 'iof', 'juros', 'emprestimo', 'previdencia', 'consignado'] },

  // ── Seguros → Seguro do veículo / genérico ──
  { cat: 'Seguro do veículo', kws: ['seguro auto', 'seguro do carro', 'seguro veicular', 'porto seguro auto'] },
  { cat: 'Seguro',         kws: ['seguro de vida', 'seguro residencial', 'seguro viagem', 'apolice', 'porto seguro', 'azul seguros',
      'sulamerica seguro', 'bradesco seguros', 'allianz', 'mapfre', 'tokio marine', 'seguro'] },

  // ── Doações ──
  { cat: 'Doações',        kws: ['dizimo', 'oferta igreja', 'doacao', 'vakinha', 'vaquinha', 'apae', 'cruz vermelha'] },

  // ── Compras genérico (fallback antes de Outros) ──
  { cat: 'Compras',        kws: ['presente', 'lembrancinha', 'shopping', 'loja de departamento'] },

  // ── Salário / Renda ──
  { cat: 'Salário',        kws: ['salario', 'folha de pagamento', 'folha pagamento', 'pro labore', 'pro-labore', 'provento', 'remuneracao', 'decimo terceiro'] },

  // ── Negócio (receita de vendas/serviços) ──
  { cat: 'Negócio',        kws: ['venda de', 'recebi de cliente', 'freelance', 'freela', 'consultoria', 'prestacao de servico'] },

  // ── Investimentos (receita) ──
  { cat: 'Investimentos',  kws: ['dividendo', 'rendimento', 'aplicacao', 'resgate', 'tesouro direto', 'corretora', 'xp investimentos', 'nuinvest', 'aporte', 'renda fixa', 'fundo de investimento', 'b3 '] },
];

// Nome da categoria sugerida pela descrição, ou null.
function categorizarDescricao(descricao) {
  const t = normalizar(descricao);
  if (!t) return null;
  for (const regra of REGRAS) {
    for (const kw of regra.kws) {
      // normalizar() comeria o '=' (vira espaço) — reaplica depois pra manter
      // o pedido de "palavra inteira".
      const exato = kw[0] === '=';
      const k = normalizar(kw);
      if (k && casa(t, exato ? `=${k}` : k)) return regra.cat;
    }
  }
  return null;
}

// Fallback: taxonomia do próprio Pluggy (tx.category, em inglês/PT) → Sora.
// Avaliado por substring no nome normalizado da categoria do Pluggy.
const MAPA_PLUGGY = [
  { cat: 'Supermercado',   kws: ['supermarket', 'groceries', 'grocery', 'mercado', 'supermercado'] },
  { cat: 'Restaurante',    kws: ['food and drinks', 'food & drinks', 'restaurant', 'fast food', 'bars', 'dining', 'aliment', 'restaurante', 'comida', 'bares'] },
  { cat: 'Café',           kws: ['coffee', 'cafe'] },
  { cat: 'Delivery',       kws: ['food delivery', 'delivery'] },
  { cat: 'Combustível',    kws: ['gas station', 'fuel', 'combustivel', 'gasolina'] },
  { cat: 'Transporte',     kws: ['transport', 'public transportation', 'parking', 'tolls', 'transporte', 'pedagio', 'estacionamento'] },
  { cat: 'Uber',           kws: ['ride hailing', 'ride-hailing', 'taxi', 'uber'] },
  { cat: 'Consultas',      kws: ['doctor', 'medical'] },
  { cat: 'Farmácia',       kws: ['pharmacy', 'drugstore', 'farmacia'] },
  { cat: 'Saúde',          kws: ['health', 'saude', 'medico'] },
  { cat: 'Autocuidado',    kws: ['beauty', 'personal care', 'cosmetic', 'beleza', 'estetica'] },
  { cat: 'Academia',       kws: ['gym', 'fitness', 'academia'] },
  { cat: 'Compras',        kws: ['clothing', 'apparel', 'fashion', 'shoes', 'vestuario', 'roupa', 'calcado', 'shopping', 'electronics', 'eletronicos'] },
  { cat: 'Assinaturas',    kws: ['streaming', 'subscription', 'digital services', 'software', 'assinatura'] },
  { cat: 'Lazer',          kws: ['leisure', 'entertainment', 'gaming', 'games', 'lazer', 'entreten', 'jogos'] },
  { cat: 'Viagem',         kws: ['travel', 'airline', 'airlines', 'hotel', 'lodging', 'accommodation', 'viagem', 'hospedagem', 'passagens'] },
  { cat: 'Educação',       kws: ['education', 'school', 'tuition', 'courses', 'educacao', 'escola', 'curso'] },
  { cat: 'Pet',            kws: ['pet', 'pets', 'veterinary'] },
  { cat: 'Tecnologia',     kws: ['telecommunication', 'phone', 'mobile', 'internet', 'telefon', 'celular'] },
  { cat: 'Conta de Luz',   kws: ['utilities', 'electricity', 'bills', 'energia', 'luz', 'contas'] },
  { cat: 'Água',           kws: ['water', 'agua'] },
  { cat: 'Gás',            kws: ['gas'] },
  { cat: 'Moradia',        kws: ['rent', 'housing', 'home improvement', 'aluguel', 'moradia', 'casa', 'condominio'] },
  { cat: 'Financeiro',     kws: ['tax', 'taxes', 'government', 'imposto', 'tributo', 'fees', 'interest', 'juros', 'insurance', 'seguro'] },
  { cat: 'Investimentos',  kws: ['investment', 'investments', 'investimento', 'aplicacao', 'dividend', 'dividendo'] },
  { cat: 'Transferências', kws: ['transfer', 'transfers', 'pix', 'ted', 'doc', 'transferencia', 'wire'] },
  { cat: 'Salário',        kws: ['salary', 'income', 'payroll', 'wages', 'salario', 'renda', 'provento'] },
  { cat: 'Encomendas',     kws: ['online shopping', 'e-commerce', 'ecommerce', 'marketplace', 'compras'] },
];

function mapearCategoriaPluggy(pluggyCat) {
  const t = normalizar(pluggyCat);
  if (!t) return null;
  for (const regra of MAPA_PLUGGY) {
    for (const kw of regra.kws) {
      if (casa(t, normalizar(kw))) return regra.cat;
    }
  }
  return null;
}

// Decisão final: descrição (mesma engine do OFX) → categoria do Pluggy → 'Outros'.
function categorizar({ descricao, pluggyCategoria } = {}) {
  return categorizarDescricao(descricao) || mapearCategoriaPluggy(pluggyCategoria) || 'Outros';
}

module.exports = { categorizar, categorizarDescricao, mapearCategoriaPluggy };
