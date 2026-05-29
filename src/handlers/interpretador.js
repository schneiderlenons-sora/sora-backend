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

  // Antecipar/pagar parcela: "antecipar parcela do fone", "pagar parcela fone",
  // "quitar parcelas da tv" (quitar/todas = marca todas as parcelas em aberto).
  if ((m = msg.match(/(antecipar|pagar|quitar)\s+(?:as\s+|a\s+)?parcelas?\s+(?:d[aeo]s?\s+)?(.+)/i))) {
    const todas = /\b(quitar|todas)\b/i.test(msg);
    return { acao: 'antecipar_parcela', termo: m[2].trim(), todas };
  }

  if ((m = msg.match(/definir\s+fatura\s+dia\s+(\d{1,2})/i)))
    return { acao: 'set_fatura_dia', dia: parseInt(m[1]) };

  // --- DÍVIDAS ---
  // "minhas dividas" / "listar dividas" / "dividas"
  if (/^(minhas\s+d[ií]vidas|listar\s+d[ií]vidas|d[ií]vidas)$/i.test(msg))
    return { acao: 'listar_dividas' };

  // "criar divida [tipo opcional] [nome/credor] [valor] em [N]x dia [D]"
  // Ex: "criar divida emprestimo nubank 5000 em 10x dia 15"
  if ((m = msg.match(/(?:criar|nova|adicionar)\s+d[ií]vida\s+(?:(emprestimo|empr[eé]stimo|financiamento|crediario|crediário|consignado|fies|rotativo|cheque\s+especial)\s+)?(.+?)\s+(\d[\d.,]*)(?:\s+em\s+(\d+)\s*x)?(?:\s+dia\s+(\d{1,2}))?$/i))) {
    const tipo = m[1]
      ? (/financiamento/i.test(m[1]) ? 'financiamento'
       : /crediario|crediário/i.test(m[1]) ? 'crediario'
       : /consignado/i.test(m[1]) ? 'consignado'
       : /fies/i.test(m[1]) ? 'fies'
       : /rotativo/i.test(m[1]) ? 'cartao_rotativo'
       : /cheque/i.test(m[1]) ? 'cheque_especial'
       : 'emprestimo')
      : 'emprestimo';
    const nome = m[2].trim();
    return {
      acao: 'criar_divida',
      titulo: nome, credor: nome, tipo,
      valor_total: parseValor(m[3]),
      parcelas_total: m[4] ? parseInt(m[4]) : null,
      dia_vencimento: m[5] ? parseInt(m[5]) : null,
    };
  }

  // "pagar divida nubank 250" / "pagar parcela divida nubank 250"
  if ((m = msg.match(/pagar\s+(?:parcela\s+)?d[ií]vida\s+(.+?)(?:\s+(\d[\d.,]*))?$/i))) {
    return { acao: 'pagar_divida', termo: m[1].trim(), valor: m[2] ? parseValor(m[2]) : null, tipo: 'parcela' };
  }

  // "antecipar divida nubank 500"
  if ((m = msg.match(/antecipar\s+d[ií]vida\s+(.+?)(?:\s+(\d[\d.,]*))?$/i))) {
    return { acao: 'pagar_divida', termo: m[1].trim(), valor: m[2] ? parseValor(m[2]) : null, tipo: 'antecipacao' };
  }

  // "quitar divida nubank" / "quitar divida nubank 1500"
  if ((m = msg.match(/quitar\s+d[ií]vida\s+(.+?)(?:\s+(\d[\d.,]*))?$/i))) {
    return { acao: 'quitar_divida', termo: m[1].trim(), valor: m[2] ? parseValor(m[2]) : null };
  }

  // "cancelar lembrete dividas" (global) / "cancelar lembrete divida nubank"
  // "parar lembrete(s) divida(s)" / "desativar lembrete divida nubank"
  if ((m = msg.match(/(?:cancelar|parar|desativar|desligar)\s+lembretes?\s+(?:d[ae]s?\s+)?d[ií]vidas?(?:\s+(.+))?$/i))) {
    return { acao: 'cancelar_lembrete_divida', termo: m[1]?.trim() || null };
  }

  // "ativar lembrete divida nubank" / "ativar lembretes dividas"
  if ((m = msg.match(/(?:ativar|reativar|ligar)\s+lembretes?\s+(?:d[ae]s?\s+)?d[ií]vidas?(?:\s+(.+))?$/i))) {
    return { acao: 'ativar_lembrete_divida', termo: m[1]?.trim() || null };
  }

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
  // carteira_nome fica NULL quando o usuário não cita banco — assim o handler
  // roda a lógica inteligente (wallet padrão / conta única / perguntar qual).
  if ((m = msg.match(/(gastei|paguei|comprei)\s+(\d[\d.,]*)\s+(?:em\s+|no\s+|na\s+|de\s+)?(.+?)(?:\s+(?:no|na|pelo|pela|com)\s+(.+))?$/i))) {
    const descricao  = m[3].trim();
    const carteira   = m[4] ? m[4].trim() : null;
    return {
      acao: 'salvar', tipo: 'Gasto',
      valor: parseValor(m[2]),
      categoria: detectarCategoria(descricao),
      observacao: descricao,   // só a descrição (ex: "padaria"), não a frase inteira
      carteira_nome: carteira || null
    };
  }

  // --- RECEITAS ---
  if ((m = msg.match(/(ganhei|recebi|caiu|depositaram|entrou)\s+(\d[\d.,]*)(?:\s+(?:no|na|pelo|de)\s+(.+))?/i)))
    return {
      acao: 'salvar', tipo: 'Recebimento',
      valor: parseValor(m[2]),
      categoria: 'Recebimento',
      observacao: m[3] ? m[3].trim() : '',   // descrição curta, não a frase inteira
      carteira_nome: null
    };

  // --- CRIAR CONTA BANCÁRIA / CARTÃO: "nubank 1000" ou "nubank crédito 5000" ---
  if ((m = msg.match(/^(nubank|inter|ita[uú]|bradesco|santander|caixa|c6\s*bank|mercado\s*pago|picpay|banco\s*do\s*brasil|safra)(\s+cr[eé]dito)?\s+(\d[\d.,]*)$/i))) {
    // Com "crédito" → cartão (set_cartao dispara o wizard de fechamento/vencimento/bandeira)
    if (m[2]) {
      return { acao: 'set_cartao', nome: m[1].trim(), limite: parseValor(m[3]),
               dia_fechamento: null, dia_vencimento: null, bandeira: null };
    }
    // Sem "crédito" → conta bancária comum (saldo)
    return { acao: 'set_wallet', nome: m[1].trim(), valor: parseValor(m[3]) };
  }

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

  // --- OFX / IMPORTAR EXTRATO → orienta usar o painel ---
  // Importação de OFX/CSV só existe no painel web; se o usuário pedir
  // pelo WhatsApp, orienta sem gastar IA.
  if (/\b(ofx|importar?\s+(extrato|ofx|csv|planilha)|extrato\s+(banc|ofx)|sincroniz\w*\s+extrato)\b/i.test(msg)) {
    return {
      acao: 'conversa',
      resposta:
        '📄 A importação de extrato (OFX/CSV) é feita pelo painel web, que mostra um preview pra você revisar antes de importar:\n\n' +
        '👉 forsora.com/transacoes → botão *Importar*\n\n' +
        'No app do seu banco: abra o extrato → *Exportar/Compartilhar* → escolha *OFX*.\n\n' +
        '💡 Aqui no WhatsApp você pode mandar *foto da nota/comprovante* que eu registro na hora!',
    };
  }

  // --- COMANDOS SIMPLES ---
  if (/\bpainel\b/i.test(msg))         return { acao: 'painel' };
  if (/\bsaldo\b/i.test(msg))          return { acao: 'ver_saldos' };
  if (/\b(resumo|relat[oó]rio)\b/i.test(msg)) return { acao: 'resumo' };
  if (/\banalisar\b/i.test(msg))       return { acao: 'analisar' };
  if (/\b(ajuda|help|menu)\b/i.test(msg)) return { acao: 'ajuda' };
  if (/\bdividendos\b|\bproventos\b/i.test(msg)) return { acao: 'ver_dividendos' };

  // Normaliza sem acento — o \b do regex não casa antes de "última" (ú não
  // é word char ASCII), então testamos no texto sem acento.
  const semAcento = msg.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/(excluir|apagar|deletar|desfazer)/i.test(semAcento)) {
    // "última"/"último"/"desfazer último lançamento" → apaga a última
    if (/(ultim|desfaz)/i.test(semAcento)) return { acao: 'apagar' };
    // Pega o ÚLTIMO trecho de 6 alfanuméricos — o id fica no fim da frase.
    // Evita capturar "exclui" (de "excluir") como id.
    const ids = semAcento.match(/[a-z0-9]{6}/gi);
    const idCurto = ids && ids.length ? ids[ids.length - 1].toUpperCase() : null;
    return { acao: 'apagar', idCurto };
  }

  if (/\bgastos?\b/i.test(msg)) {
    const termo = msg.replace(/gastos?/i, '').trim();
    return { acao: 'buscar', termo: termo || 'TUDO' };
  }

  // Não reconheceu → vai para a IA
  return null;
}

module.exports = { interpretarRapido, detectarCategoria };