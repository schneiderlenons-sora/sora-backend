// Detecta categoria pelo texto da mensagem
function detectarCategoria(msg) {
  const m = msg.toLowerCase();
  if (m.includes('mercado') || m.includes('supermercado')) return 'Mercado';
  if (m.match(/(uber|99|gasolina|combustivel|posto|onibus|metro)/i)) return 'Transporte';
  if (m.match(/(pizza|lanche|restaurante|janta|almoço|ifood|delivery)/i)) return 'Alimentação';
  if (m.match(/(netflix|spotify|prime|hbo|disney|globo|iptv)/i)) return 'Assinaturas';
  if (m.match(/(farmacia|remedio|medico|hospital|clinica|plano de saude)/i)) return 'Saúde';
  if (m.includes('aluguel')) return 'Aluguel';
  if (m.match(/(padaria|pao|cafe da manha)/i)) return 'Padaria';
  if (m.match(/(internet|wifi|vivo|claro|tim|oi |banda larga)/i)) return 'Internet';
  if (m.match(/(pet|cachorro|gato|racao|veterinario)/i)) return 'Pet';
  if (m.match(/(lazer|cerveja|breja|balada|cinema|show)/i)) return 'Lazer e Entretenimento';
  if (m.match(/(escola|faculdade|curso|livro|material)/i)) return 'Educação';
  if (m.match(/(luz|agua|gas|condominio|iptu)/i)) return 'Casa';
  if (m.match(/(roupa|tenis|calcado|camiseta|calca|vestido)/i)) return 'Vestuário';
  if (m.match(/(viagem|passagem|hotel|airbnb|hospedagem)/i)) return 'Viagem';
  if (m.includes('pix')) return 'Transferências';
  return 'Outros';
}

// Normaliza valor: "50,90" → 50.90  |  "1.000,50" → 1000.50
function parseValor(str) {
  return parseFloat(str.replace(/\./g, '').replace(',', '.'));
}

// Tenta interpretar a mensagem sem chamar a IA (mais rápido e grátis)
function interpretarRapido(message) {
  const msg = message.toLowerCase().trim();

  // --- GRUPOS ---
  let m;
  if ((m = msg.match(/criar\s+grupo\s+(.+)/i)))
    return { acao: 'criar_grupo', nome: m[1].trim() };

  if (/convidar\s+grupo/i.test(msg))
    return { acao: 'convidar_grupo' };

  if ((m = msg.match(/entrar\s+grupo\s+([A-Z0-9]{4,8})/i)))
    return { acao: 'entrar_grupo', codigo: m[1].toUpperCase() };

  if (/meus\s+grupos/i.test(msg))
    return { acao: 'meus_grupos' };

  if ((m = msg.match(/trocar\s+grupo\s+(.+)/i)))
    return { acao: 'trocar_grupo', nome: m[1].trim() };

  if (/\bmembros\b/i.test(msg))
    return { acao: 'listar_membros' };

  if ((m = msg.match(/remover\s+membro\s+(.+)/i)))
    return { acao: 'remover_membro', nome: m[1].trim() };

  // --- RECORRÊNCIA ---
  if ((m = msg.match(/todo\s+m[eê]s\s+(\d[\d.,]*)\s+(.+?)\s+dia\s+(\d{1,2})/i)))
    return { acao: 'set_recorrente', valor: parseValor(m[1]), descricao: m[2].trim(), dia: parseInt(m[3]) };

  if ((m = msg.match(/(cancelar|parar)\s+recorr[eê]ncia\s+(.+)/i)))
    return { acao: 'cancelar_recorrencia', descricao: m[2].trim() };

  // --- PARCELAS ---
  if ((m = msg.match(/(?:comprei|fiz uma compra de)\s+(.+?)\s+(?:no|na|pelo)\s+([\w\s]+?(?:\s+cr[eé]dito)?)\s+em\s+(\d+)x\s+de\s+(\d[\d.,]*)/i))) {
    const numParcelas  = parseInt(m[3]);
    const valorParcela = parseValor(m[4]);
    return {
      acao: 'compra_parcelada',
      descricao:    m[1].trim(),
      carteira:     m[2].trim(),
      numParcelas,
      valorParcela,
      valorTotal:   numParcelas * valorParcela,
      categoria:    detectarCategoria(m[1])
    };
  }

  if ((m = msg.match(/pagar\s+parcela\s+d[ao]\s+(.+)/i)))
    return { acao: 'pagar_parcela', descricao: m[1].trim() };

  if ((m = msg.match(/parcela\s+paga\s+(.+)/i)))
    return { acao: 'confirmar_pagamento_parcela', descricao: m[1].trim() };

  if ((m = msg.match(/definir\s+fatura\s+dia\s+(\d{1,2})/i)))
    return { acao: 'set_fatura_dia', dia: parseInt(m[1]) };

  // --- CONTAS BANCÁRIAS ---
  // "deletar conta nubank"
  if ((m = msg.match(/deletar\s+conta\s+(.+)/i)))
    return { acao: 'deletar_conta', nome: m[1].trim() };

  // "adicionar 200 no inter"  ← bug corrigido
  if ((m = msg.match(/adicionar\s+(\d[\d.,]*)\s+(?:no|na)\s+(.+)/i)))
    return { acao: 'adicionar_saldo', nome: m[2].trim(), valor: parseValor(m[1]) };

  // "mude meu saldo do nubank pra 2000"  ← bug corrigido
  if ((m = msg.match(/(?:mude|altere|muda|muda)\s+(?:meu\s+)?saldo\s+d[oa]\s+(.+?)\s+(?:pra|para)\s+(\d[\d.,]*)/i)))
    return { acao: 'alterar_saldo', nome: m[1].trim(), valor: parseValor(m[2]) };

  // "transferir 200 do nubank pro inter"  ← bug corrigido
  if ((m = msg.match(/transferir\s+(\d[\d.,]*)\s+do\s+(.+?)\s+(?:pro|para|pra)\s+(.+)/i)))
    return { acao: 'transferir', valor: parseValor(m[1]), origem: m[2].trim(), destino: m[3].trim() };

  // --- GASTOS ---
  if ((m = msg.match(/(gastei|paguei|comprei)\s+(\d[\d.,]*)\s+(?:em\s+|no\s+|na\s+|de\s+)?(.+?)(?:\s+(?:no|na|pelo|pela|com)\s+(.+))?$/i))) {
    const descricao  = m[3].trim();
    const carteira   = m[4] ? m[4].trim() : null;
    return {
      acao: 'salvar', tipo: 'Gasto',
      valor: parseValor(m[2]),
      categoria: detectarCategoria(descricao),
      observacao: message,
      carteira_nome: carteira || 'Dinheiro'
    };
  }

  // --- RECEITAS ---
  if ((m = msg.match(/(ganhei|recebi|caiu|depositaram|entrou)\s+(\d[\d.,]*)(?:\s+(?:no|na|pelo|de)\s+(.+))?/i)))
    return {
      acao: 'salvar', tipo: 'Recebimento',
      valor: parseValor(m[2]),
      categoria: 'Recebimento',
      observacao: message,
      carteira_nome: m[3] ? m[3].trim() : 'Dinheiro'
    };

  // --- CRIAR CONTA BANCÁRIA: "nubank 1000" ---
  if ((m = msg.match(/^(nubank|inter|ita[uú]|bradesco|santander|caixa|c6\s*bank|mercado\s*pago|picpay|banco\s*do\s*brasil|safra)(\s+cr[eé]dito)?\s+(\d[\d.,]*)$/i)))
    return { acao: 'set_wallet', nome: m[1].trim() + (m[2] ? ' Crédito' : ''), valor: parseValor(m[3]) };

  // --- LIMITES ---
  if ((m = msg.match(/^limite\s+(?:geral\s+)?(\d[\d.,]*)$/i)))
    return { acao: 'set_meta', valor: parseValor(m[1]) };

  if ((m = msg.match(/limite\s+([a-zà-ú\s]+?)\s+(\d[\d.,]*)$/i)))
    return { acao: 'set_limite', categoria: m[1].trim(), valor: parseValor(m[2]) };

  if (/meus\s+limites/i.test(msg))
    return { acao: 'meus_limites' };

  // --- LEMBRETES ---
  if ((m = msg.match(/(lembrar|lembrete)\s+(pagar|receber)\s+(.+?)\s+dia\s+(\d{1,2})\/(\d{1,2})(?:\s+valor\s+(\d[\d.,]*))?/i)))
    return {
      acao: 'criar_lembrete',
      tipo: m[2], descricao: m[3].trim(),
      dia: parseInt(m[4]), mes: parseInt(m[5]) - 1,
      valor: m[6] ? parseValor(m[6]) : 0
    };

  // --- COMANDOS SIMPLES ---
  if (/\bpainel\b/i.test(msg))         return { acao: 'painel' };
  if (/\bsaldo\b/i.test(msg))          return { acao: 'ver_saldos' };
  if (/\b(resumo|relat[oó]rio)\b/i.test(msg)) return { acao: 'resumo' };
  if (/\banalisar\b/i.test(msg))       return { acao: 'analisar' };
  if (/\b(ajuda|help|menu)\b/i.test(msg)) return { acao: 'ajuda' };
  if (/\bdividendos\b|\bproventos\b/i.test(msg)) return { acao: 'ver_dividendos' };

  if (/\b(excluir|apagar|deletar)\b/i.test(msg)) {
    if (/\b(ultima|última)\b/i.test(msg)) return { acao: 'apagar' };
    const id = msg.match(/([A-Z0-9]{6})/i);
    return { acao: 'apagar', idCurto: id ? id[1].toUpperCase() : null };
  }

  if (/\bgastos?\b/i.test(msg)) {
    const termo = msg.replace(/gastos?/i, '').trim();
    return { acao: 'buscar', termo: termo || 'TUDO' };
  }

  // Não reconheceu → vai para a IA
  return null;
}

module.exports = { interpretarRapido, detectarCategoria };