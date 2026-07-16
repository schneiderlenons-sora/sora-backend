const { categorizarDescricao } = require('../services/categorizar');

// Detecta categoria pelo texto da mensagem
function detectarCategoria(msg) {
  // Tira acentos pra casar "farmácia"/"ração"/"água" com os keywords ASCII.
  const m = msg.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Marketplaces ANTES de "mercado" — senão "mercado livre" cairia em supermercado.
  if (m.match(/(shopee|shein|aliexpress|amazon|mercado\s*livre|mercadolivre|magalu|magazine\s*luiza|americanas|submarino|temu|tiktok\s*shop)/i)) return 'Encomendas';
  if (m.includes('mercado') || m.includes('supermercado')) return 'Mercado';
  // Combustível ANTES de Transporte (senão "gasolina" cairia em Transporte).
  // "posto" exclui "posto de saúde".
  if (m.match(/(gasolina|combustivel|etanol|diesel|\bposto\b(?!\s+de\s+sa)|ipiranga|petrobras|\bshell\b)/i)) return 'Combustível';
  if (m.match(/(uber|99|onibus|metro|cabify|taxi|pedagio|estacionamento)/i)) return 'Transporte';
  if (m.match(/(pizza|lanche|restaurante|janta|almoco|jantar|ifood|delivery|hamburguer|marmita)/i)) return 'Alimentação';
  if (m.match(/(netflix|spotify|prime|hbo|disney|globo|iptv)/i)) return 'Assinaturas';
  // SAÚDE — ordem importa (do mais específico pro geral):
  //   1. Autocuidado: dentista, dermato, estética/plástica (exceções pedidas)
  //   2. Plano de Saúde (subcategoria de Saúde): unimed, amil, hapvida…
  //   3. Nutricionista → Saúde geral (exceção pedida)
  //   4. Médico (subcategoria de Saúde): o restante dos médicos
  //   5. Saúde geral: farmácia, ótica, psicólogo…
  if (m.match(/(dentista|odonto|ortodontia|dermatolog|esteticista|estetica|cirurgia plastica|botox|harmoniza|preenchimento facial|depilacao|manicure|pedicure|salao|cabeleireiro|barbeiro|corte de cabelo|\bspa\b|massagem)/i)) return 'Autocuidado';
  if (m.match(/(unimed|amil|hapvida|notredame|paz eterna|sulamerica|sul america|golden cross|prevent senior|porto seguro saude|bradesco saude|plano de saude)/i)) return 'Plano de Saúde';
  if (m.match(/(nutricionista|nutrolog)/i)) return 'Saúde';
  if (m.match(/(medico|medica|otorrino|fisioterap|cardiolog|ortoped|pediatra|ginecolog|urolog|oftalmo|neurolog|psiquiatra|endocrino|reumatolog|clinico geral|consulta|exame|hospital|laboratorio)/i)) return 'Médico';
  if (m.match(/(farmacia|drogaria|remedio|clinica|psicolog|terapia|vacina|otica|oculos)/i)) return 'Saúde';
  // Categorias novas (072) — auto-categorização pedida.
  if (m.match(/(financiamento|consorcio)/i)) return 'Financiamento';
  if (m.match(/\bseguro\b/i)) return 'Seguro';
  if (m.match(/(presente|lembrancinha|\bgift\b)/i)) return 'Presente';
  if (m.match(/(fralda|creche|bercario|mesada|escolinha)/i)) return 'Filhos';
  if (m.includes('aluguel')) return 'Aluguel';
  if (m.match(/(padaria|pao|cafe da manha)/i)) return 'Padaria';
  if (m.match(/(internet|wifi|vivo|claro|tim|oi |banda larga)/i)) return 'Internet';
  // "cachorro quente" (hot dog) NÃO é Pet — deixa cair no motor de comida abaixo.
  if (m.match(/(\bpet\b|petshop|pet\s+shop|racao|veterinari|tosa|banho e tosa|cachorro(?![\s-]*quente)|\bcao\b|\bgato\b)/i)) return 'Pet';
  if (m.match(/(lazer|cerveja|breja|balada|cinema|show)/i)) return 'Lazer e Entretenimento';
  if (m.match(/(escola|faculdade|curso|livro|material)/i)) return 'Educação';
  if (m.match(/(luz|agua|gas|condominio|iptu)/i)) return 'Casa';
  if (m.match(/(roupa|tenis|calcado|camiseta|calca|vestido)/i)) return 'Vestuário';
  if (m.match(/(viagem|passagem|hotel|airbnb|hospedagem)/i)) return 'Viagem';
  if (m.includes('pix')) return 'Transferências';
  // Fallback: motor de descrição compartilhado (mesma engine do OFX/Pluggy) —
  // cobre centenas de itens do dia a dia (coxinha, pastel, suco, refri, etc.).
  const sug = categorizarDescricao(msg);
  if (sug) return sug;
  return 'Outros';
}

// Normaliza valor: "50,90" → 50.90  |  "1.000,50" → 1000.50
function parseValor(str) {
  return parseFloat(str.replace(/\./g, '').replace(',', '.'));
}

// Detecta o período de uma pergunta de resumo ("quanto gastei HOJE / ESSA
// SEMANA / MÊS PASSADO"). Ordem importa: "semana passada" antes de "semana".
function detectarPeriodo(texto) {
  const t = ' ' + (texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') + ' ';
  if (/\bhoje\b/.test(t)) return 'hoje';
  if (/\bontem\b/.test(t)) return 'ontem';
  if (/\b(semana\s+passada|ultima\s+semana|semana\s+retrasada)\b/.test(t)) return 'semana_passada';
  if (/\bsemana\b/.test(t)) return 'semana';
  if (/\b(mes\s+passado|ultimo\s+mes|mes\s+anterior|mes\s+retrasado)\b/.test(t)) return 'mes_passado';
  if (/\bano\b/.test(t)) return 'ano';
  if (/\bmes\b/.test(t)) return 'mes';
  return null;
}

// Detecta a data de uma transação no texto (interpretação pro PASSADO).
// "ontem", "anteontem", "3 dias atrás", "dia 5", "15/06", "segunda".
// Retorna { iso:'YYYY-MM-DD', matched:'...' } ou null (= hoje).
function parseDataGasto(texto) {
  const t = ' ' + (texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') + ' ';
  // "hoje" no fuso de São Paulo (YYYY-MM-DD) → âncora ao meio-dia UTC pra
  // aritmética de data estável (sem off-by-one por fuso/DST).
  const [Y, M, D] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).split('-').map(Number);
  const base = new Date(Date.UTC(Y, M - 1, D, 12));
  const isoOf = d => d.toISOString().slice(0, 10);
  const menos = n => { const d = new Date(base); d.setUTCDate(d.getUTCDate() - n); return d; };
  let m;
  if (/\bhoje\b/.test(t)) return { iso: isoOf(base), matched: 'hoje' };
  if (/\b(anteontem|antes\s+de\s+ontem)\b/.test(t)) return { iso: isoOf(menos(2)), matched: (t.match(/anteontem|antes\s+de\s+ontem/) || [])[0] };
  if (/\bontem\b/.test(t)) return { iso: isoOf(menos(1)), matched: 'ontem' };
  if (m = t.match(/\b(\d{1,2})\s*dias?\s+atras\b/)) return { iso: isoOf(menos(+m[1])), matched: m[0].trim() };
  if (/\bsemana\s+passada\b/.test(t)) return { iso: isoOf(menos(7)), matched: 'semana passada' };
  // DD/MM ou DD/MM/AAAA
  if (m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)) {
    const dd = +m[1], mo = +m[2] - 1, yy = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : Y;
    let d = new Date(Date.UTC(yy, mo, dd, 12));
    if (!m[3] && d > base) d = new Date(Date.UTC(yy - 1, mo, dd, 12)); // futura sem ano → ano passado
    return { iso: isoOf(d), matched: m[0].trim() };
  }
  // "dia 5"
  if (m = t.match(/\bdia\s+(\d{1,2})\b/)) {
    const dd = +m[1]; let d = new Date(Date.UTC(Y, M - 1, dd, 12));
    if (d > base) d = new Date(Date.UTC(Y, M - 2, dd, 12)); // futura → mês passado
    return { iso: isoOf(d), matched: m[0].trim() };
  }
  // dia da semana → ocorrência passada mais recente
  const dias = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'], abbr = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  for (let i = 0; i < 7; i++) {
    const re = new RegExp(`\\b(${dias[i]}(?:-feira)?|${abbr[i]})\\b`);
    const mm = t.match(re);
    if (mm) { const delta = (base.getUTCDay() - i + 7) % 7 || 7; return { iso: isoOf(menos(delta)), matched: mm[0] }; }
  }
  return null;
}

// Deixa só o ITEM na descrição. A frase natural traz a LOJA/lugar ("uma resistência
// NO MERCADO LIVRE") e prefixos/artigos ("UMA resistência", "COMPRA DE coberta") que
// não devem virar descrição. A categoria é detectada ANTES, com a frase inteira —
// então tirar a loja daqui NÃO perde o "Mercado Livre".
//   "uma resistência no mercado livre" → "resistência"
//   "compra de coberta no mercado livre" → "coberta"
function limparDescricao(txt) {
  let d = (txt || '').trim();
  // 1) corta o lugar/loja: primeiro "no/na/nos/nas/em" seguido de algo.
  const lugar = d.match(/^(.*?)\s+(?:n[oa]s?|em)\s+.+$/i);
  if (lugar && lugar[1].trim()) d = lugar[1].trim();
  // 2) tira prefixo "compra/gasto/pagamento/despesa de|com".
  d = d.replace(/^(?:compra|gasto|pagamento|despesa)\s+(?:de|do|da|com)\s+/i, '').trim();
  // 3) tira artigo/quantificador do começo.
  d = d.replace(/^(?:um|uma|uns|umas|o|a|os|as)\s+/i, '').trim();
  // 4) sobrou só o lugar ("no mercado") → tira a preposição.
  d = d.replace(/^(?:n[oa]s?|em)\s+/i, '').trim();
  return d || (txt || '').trim();
}

// Tenta interpretar a mensagem sem chamar a IA (mais rápido e grátis)
function interpretarRapido(message) {
  // Remove a unidade de moeda logo após o número ("10 reais" → "10"), pra
  // não virar descrição. Ajuda especialmente áudios ("gastei 10 reais na...").
  const msg = message.toLowerCase().trim()
    .replace(/(\d)\s+(?:reais|real|conto|contos|pila|pilas|mango|mangos|pau|paus|prata|pratas|din[\s-]?din|dinheiro)\b/gi, '$1');

  let m;

  // --- CANCELAR PLANO / ASSINATURA (orienta a cancelar pela Stripe) ---
  // Específico de plano/assinatura — não conflita com "cancelar recorrência X"
  // nem "cancelar lembrete", que têm keywords próprias mais abaixo.
  if (/\b(cancelar|cancela|encerrar|desativar|suspender|parar(?:\s+de\s+pagar)?)\s+(?:o\s+|a\s+|meu\s+|minha\s+)?(plano|assinatura|inscri[cç][aã]o|mensalidade|premium|black|b[aá]sico|sora)\b/i.test(msg)
      || /\b(quero|gostaria de|preciso|como (?:fa[cç]o|posso|que faz)|posso)\s+(?:para\s+)?cancelar\b/i.test(msg)
      || /\bn[aã]o\s+quero\s+mais\s+(?:pagar|assinar|a\s+sora|o\s+plano|continuar)\b/i.test(msg)
      || /\b(cancelar|encerrar)\s+pagamento\b/i.test(msg))
    return { acao: 'cancelar_plano' };

  // --- RESUMOS PROATIVOS (liga/desliga) ---
  if (/\b(desativar|desligar|parar|cancelar|silenciar)\s+(os\s+)?resumos?\b/i.test(msg)
      || /\bn[aã]o\s+quero\s+(mais\s+)?(receber\s+)?(os\s+)?resumos?\b/i.test(msg)
      || /\bchega\s+de\s+resumos?\b/i.test(msg))
    return { acao: 'config_resumos', valor: false };
  if (/\b(ativar|ligar|reativar|quero)\s+(os\s+)?resumos?\b/i.test(msg))
    return { acao: 'config_resumos', valor: true };

  // --- SUPORTE / BUG / FALAR COM HUMANO ---
  if (/\b(suporte|atendente|atendimento|central de ajuda|fal[ae]r?\s+com\s+(?:o\s+|a\s+|um\s+|uma\s+)?(?:algu[eé]m|humano|pessoa|atendente|voc[eê]s|time|equipe|respons[aá]vel))\b/i.test(msg)
      || /\b(relatar|reportar|achei|encontrei|tem|t[aá]\s+com|deu)\s+(?:um\s+)?(bug|erro|problema|falha)\b/i.test(msg)
      || /\b(n[aã]o\s+(?:est[aá]\s+|ta\s+|t[aá]\s+)?(?:funciona|funcionando)|parou\s+de\s+funcionar|n[aã]o\s+abre|n[aã]o\s+carrega)\b/i.test(msg)
      || /\b(reclama[cç][aã]o|reclamar|quero\s+falar\s+com\s+algu[eé]m)\b/i.test(msg))
    return { acao: 'suporte' };

  // --- GRUPOS ---
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

  // --- CONFIRMAR PREVISTO (conta variável): "confirmar luz 243" / "confirma agua 89,90" ---
  // A conta variável vira um "previsto" pendente no dia do vencimento; o usuário
  // confirma o valor real por aqui (por nome ou pelo ID: "confirmar A1B2C3 243").
  if ((m = msg.match(/^confirm\w*\s+(.+?)\s+(?:r?\$?\s*)?(\d[\d.,]*)$/i)))
    return { acao: 'confirmar_previsto', termo: m[1].trim(), valor: parseValor(m[2]) };

  // --- RECORRÊNCIA ---
  if ((m = msg.match(/todo\s+m[eê]s\s+(\d[\d.,]*)\s+(.+?)\s+dia\s+(\d{1,2})/i)))
    return { acao: 'set_recorrente', valor: parseValor(m[1]), descricao: m[2].trim(), dia: parseInt(m[3]) };

  if ((m = msg.match(/(cancelar|parar)\s+recorr[eê]ncia\s+(.+)/i)))
    return { acao: 'cancelar_recorrencia', descricao: m[2].trim() };

  // --- PARCELAS ---
  if ((m = msg.match(/(?:comprei|fiz uma compra de)\s+(.+?)\s+(?:no|na|pelo)\s+([\w\s]+?(?:\s+cr[eé]dito)?)\s+em\s+(\d+)x\s+de\s+(\d[\d.,]*)/i))) {
    const numParcelas  = parseInt(m[3]);
    const valorParcela = parseValor(m[4]);
    let descricao = m[1].trim();
    // Data da compra (ontem/dia 5/15-06) → base da 1ª parcela; limpa da descrição.
    const dInfo = parseDataGasto(msg);
    if (dInfo) descricao = descricao.replace(new RegExp(`\\b${dInfo.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '').replace(/\s+/g, ' ').trim();
    return {
      acao: 'compra_parcelada',
      descricao,
      carteira:     m[2].trim(),
      numParcelas,
      valorParcela,
      valorTotal:   numParcelas * valorParcela,
      dataTx:       dInfo ? dInfo.iso : null,
      categoria:    detectarCategoria(descricao)
    };
  }

  // Antecipar/pagar parcela: "antecipar parcela do fone", "pagar parcela fone",
  // "quitar parcelas da tv" (quitar/todas = marca todas as parcelas em aberto).
  if ((m = msg.match(/(antecipar|pagar|quitar)\s+(?:as\s+|a\s+)?parcelas?\s+(?:d[aeo]s?\s+)?(.+)/i))) {
    const todas = /\b(quitar|todas)\b/i.test(msg);
    return { acao: 'antecipar_parcela', termo: m[2].trim(), todas };
  }

  // LISTAR compras parceladas em aberto: "parcelas", "minhas parcelas",
  // "como estão minhas parcelas", "quantas parcelas tenho pra pagar",
  // "compras parceladas", "parcelas em aberto". (Registro "em 3x" e
  // pagar/antecipar parcela já retornaram acima.)
  if (/^(?:minhas\s+|as\s+|ver\s+|listar\s+|mostrar\s+)?parcelas?(?:\s+(?:em\s+)?abert[oa]s?|\s+a\s+pagar|\s+pendentes?)?$/i.test(msg)
      || /\bcompras?\s+parcelad(?:a|as|o|os)\b/i.test(msg)
      || /\bparcelamentos?\b/i.test(msg)
      || /\bcomo\s+(?:est[ãa]o|t[ãa]o)\s+(?:as\s+|minhas\s+)?parcelas?\b/i.test(msg)
      || /\bquantas?\s+parcelas?\b/i.test(msg)
      || /\bparcelas?\s+(?:eu\s+)?(?:tenho|falta|faltam|restam?|devo)\b/i.test(msg)) {
    return { acao: 'listar_parcelas' };
  }

  if ((m = msg.match(/definir\s+fatura\s+dia\s+(\d{1,2})/i)))
    return { acao: 'set_fatura_dia', dia: parseInt(m[1]) };

  // "pagar fatura" (aberta) / "pagar fatura fechada/anterior" (a que vence agora).
  // Cartão é OPCIONAL — sem ele, o handler usa o único cartão ou pergunta qual.
  if ((m = msg.match(/^(?:pagar|quitar)\s+(?:a\s+|minha\s+)?fatura(?:\s+(?:d[oae]\s+)?(.+))?$/i))) {
    let termo = (m[1] || '').trim();
    const fechada = /\b(fechada|anterior|passada|vencida|vencendo|atrasada)\b/i.test(termo) || /\bm[êe]s\s+passado\b/i.test(termo);
    if (fechada) termo = termo
      .replace(/\b(fechada|anterior|passada|vencida|vencendo|atrasada|do\s+m[êe]s\s+passado|m[êe]s\s+passado)\b/gi, '')
      .replace(/^\s*d[oae]\s+/i, '').replace(/\s+/g, ' ').trim();
    return { acao: 'pagar_fatura', termo, fechada };
  }

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

  // "ajustar nubank 850" / "ajustar mercado pago para 700" / "ajusta o saldo do inter pra 300"
  // AJUSTAR = conta que JÁ existe → alterar_saldo (com rastro de Ajuste). Sem essa
  // regra a frase caía na IA, que respondia set_wallet ("conta criada") e o saldo
  // mudava sem transação nenhuma. O "saldo"/"o"/"do" são opcionais.
  if ((m = msg.match(/^(?:ajustar|ajusta|corrigir|corrige)\s+(?:o\s+)?(?:saldo\s+(?:d[oa]\s+)?)?(.+?)\s+(?:pra|para|em|=)?\s*(\d[\d.,]*)\s*$/i)))
    return { acao: 'alterar_saldo', nome: m[1].trim(), valor: parseValor(m[2]) };

  // "transferir 200 do nubank pro inter"  ← bug corrigido
  if ((m = msg.match(/transferir\s+(\d[\d.,]*)\s+do\s+(.+?)\s+(?:pro|para|pra)\s+(.+)/i)))
    return { acao: 'transferir', valor: parseValor(m[1]), origem: m[2].trim(), destino: m[3].trim() };

  // --- REFEIÇÃO (nutrição/macros) → roteia pro Grow/Saúde ---
  // "comi 2 ovos e pão", "almocei arroz feijão e frango", "jantei...".
  // O cálculo (multi-alimentos, sem pontuação) é feito no handler via IA.
  if (/^(?:comi|almocei|jantei|lanchei|caf[eé]\s+da\s+manh[ãa])\s+\S/i.test(msg))
    return { acao: 'grow_refeicao' };

  // --- GASTOS ---
  // carteira_nome fica NULL quando o usuário não cita banco — assim o handler
  // roda a lógica inteligente (wallet padrão / conta única / perguntar qual).
  if ((m = msg.match(/(gastei|paguei|comprei)\s+(\d[\d.,]*)\s+(?:em\s+|no\s+|na\s+|de\s+|com\s+|pra\s+|para\s+|pelo\s+|pela\s+)?(.+?)(?:\s+(?:no|na|pelo|pela|com)\s+(.+))?$/i))) {
    let descricao  = m[3].trim();
    let carteira   = m[4] ? m[4].trim() : null;
    // "loja, banco" — vírgula separa descrição do banco quando o usuário não
    // disse "no/na/com" (comum em áudio: "gastei 10 na Shopee, Nubank Crédito").
    if (!carteira && descricao.includes(',')) {
      const partes = descricao.split(',');
      descricao = partes[0].trim();
      carteira  = partes.slice(1).join(',').trim() || null;
    }
    descricao = descricao.replace(/[,;]+$/, '').trim();
    // Data da transação (ontem/dia 5/15-06/segunda) → remove da descrição e conta.
    const dInfo = parseDataGasto(msg);
    if (dInfo) {
      const re = new RegExp(`\\b${dInfo.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      descricao = descricao.replace(re, '').replace(/\s+/g, ' ').replace(/[,;]+$/, '').trim();
      if (carteira) carteira = (carteira.replace(re, '').replace(/\s+/g, ' ').trim() || null);
    }
    return {
      acao: 'salvar', tipo: 'Gasto',
      valor: parseValor(m[2]),
      dataTx: dInfo ? dInfo.iso : null,
      categoria: detectarCategoria(descricao),
      observacao: limparDescricao(descricao),   // só o item (ex: "padaria"), sem artigo/loja
      carteira_nome: carteira || null
    };
  }

  // Gasto com o VALOR NO FIM (introduzido por "por/de"): a forma natural
  // "comprei um hambúrguer no ifood POR 8,29", "paguei o almoço DE 25".
  // (o padrão acima só pega valor logo após o verbo: "gastei 50 no mercado").
  // Só casa se o "por/de" for seguido de número → não pega "paguei a conta de luz".
  if ((m = msg.match(/(gastei|paguei|comprei)\s+(.+?)\s+(?:por|de)\s+(?:r\$\s*)?(\d[\d.,]*)\s*$/i))) {
    let trecho = m[2].trim().replace(/[,;]+$/, '');
    const dInfo = parseDataGasto(msg);
    if (dInfo) {
      const re = new RegExp(`\\b${dInfo.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      trecho = trecho.replace(re, '').replace(/\s+/g, ' ').replace(/[,;]+$/, '').trim();
    }
    return {
      acao: 'salvar', tipo: 'Gasto',
      valor: parseValor(m[3]),
      dataTx: dInfo ? dInfo.iso : null,
      // Categoria pela frase TODA (a loja é quem define: "no mercado livre");
      // descrição só com o item ("uma resistência no mercado livre" → "resistência").
      categoria: detectarCategoria(trecho),
      observacao: limparDescricao(trecho),
      carteira_nome: null,   // valor no fim → sem banco citado; handler usa a conta padrão
    };
  }

  // --- RECEITAS ---
  if ((m = msg.match(/(ganhei|recebi|caiu|depositaram|entrou)\s+(\d[\d.,]*)(?:\s+(?:no|na|pelo|de)\s+(.+))?/i))) {
    const dInfo = parseDataGasto(msg);
    let obs = m[3] ? m[3].trim() : '';
    if (dInfo && obs) obs = obs.replace(new RegExp(`\\b${dInfo.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '').replace(/\s+/g, ' ').trim();
    return {
      acao: 'salvar', tipo: 'Recebimento',
      valor: parseValor(m[2]),
      dataTx: dInfo ? dInfo.iso : null,
      categoria: 'Recebimento',
      observacao: obs,   // descrição curta, não a frase inteira
      carteira_nome: null
    };
  }

  // --- APORTE EM META (poupança): "guardar 500 na meta viagem" ---
  if ((m = msg.match(/^(?:guardar|aplicar|aportar|colocar|poupar|separar|depositar|juntar)\s+(\d[\d.,]*)\s+(?:n[ao]\s+|pra\s+|para\s+(?:a\s+|o\s+)?|em\s+|d[ao]\s+)?meta\s+(.+)$/i)))
    return { acao: 'aporte_meta', valor: parseValor(m[1]), termo: m[2].trim() };

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

  // Pedido de LEMBRETE com data ("me lembra que amanhã tenho que X") NÃO pode
  // cair nos comandos simples só porque a frase menciona "painel/saldo/resumo".
  // Retorna null → o webhook roteia pro parser de agenda (cria o compromisso).
  if (/\b(me\s+)?lembr\w+\b/i.test(msg)
      && /\b(amanh[ãa]|hoje|depois\s+de\s+amanh|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|semana|m[êe]s|dia\s+\d|\d{1,2}\/\d{1,2}|[àa]s?\s+\d{1,2}|\d{1,2}\s*h|daqui)\b/i.test(msg))
    return null;

  // --- COMANDOS SIMPLES ---
  // "painel" só vira comando em mensagem curta (ex.: "painel", "abrir painel") —
  // não quando a palavra aparece no meio de uma frase ("...da aba de estudos do painel").
  if (/\bpainel\b/i.test(msg) && msg.trim().split(/\s+/).length <= 5) return { acao: 'painel' };
  if (/\bsaldo\b/i.test(msg))          return { acao: 'ver_saldos' };
  if (/\b(resumo|relat[oó]rio)\b/i.test(msg)) return { acao: 'resumo', periodo: detectarPeriodo(msg) || 'mes' };
  if (/\banalisar\b/i.test(msg))       return { acao: 'analisar' };
  if (/\b(ajuda|help|menu)\b/i.test(msg)) return { acao: 'ajuda' };
  if (/\bdividendos\b|\bproventos\b/i.test(msg)) return { acao: 'ver_dividendos' };

  // Normaliza sem acento — o \b do regex não casa antes de "última" (ú não
  // é word char ASCII), então testamos no texto sem acento.
  const semAcento = msg.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // "cancela" / "cancelar" SOZINHO (ou "cancela isso/esse gasto/o último") = DESFAZER
  // o último lançamento — é o que a pessoa quer logo depois de lançar errado.
  // NÃO é cancelar plano/assinatura/recorrência/lembrete/resumo: essas têm regras
  // próprias ACIMA (exigem a palavra-chave) e já retornaram. A lista abaixo é trava
  // extra pra nunca virar "apagar" quando o alvo do cancelamento é outra coisa.
  if (/^\s*cancela(r)?\b/i.test(semAcento)
      && msg.trim().split(/\s+/).length <= 4
      && !/\b(plano|assinatura|mensalidade|inscricao|premium|black|basico|sora|recorren|lembrete|divida|fatura|resumo|conta|cartao|cartoes)/i.test(semAcento))
    return { acao: 'apagar' };

  if (/(excluir|apagar|deletar|desfazer)/i.test(semAcento)) {
    // "última"/"último"/"desfazer último lançamento" → apaga a última
    if (/(ultim|desfaz)/i.test(semAcento)) return { acao: 'apagar' };
    // Pega o ÚLTIMO trecho de 6 alfanuméricos — o id fica no fim da frase.
    // Evita capturar "exclui" (de "excluir") como id.
    const ids = semAcento.match(/[a-z0-9]{6}/gi);
    const idCurto = ids && ids.length ? ids[ids.length - 1].toUpperCase() : null;
    return { acao: 'apagar', idCurto };
  }

  // Consultas de gasto: "gastos com alimentação" (assunto) vs "quanto gastei esse
  // mês / hoje" (total). Só vira BUSCA quando há um assunto EXPLÍCITO depois de
  // preposição (com/de/em/no/na/sobre); senão é RESUMO do período. Frases de
  // análise ("no que gasto mais", "onde tô gastando demais") caem no resumo, que
  // já mostra o ranking por categoria — e o que fugir do padrão vai pra IA.
  // (Registros "gastei 50 no mercado" já retornaram lá em cima.)
  // GASTOS POR CARTÃO / CONTA (visão agregada): "gastos dos meus cartões",
  // "quanto gastei nas contas", "gastos por cartão e conta". Registro de gasto
  // ("gastei 50 no cartão nubank") já retornou lá em cima (tem valor). Só entra
  // aqui a PERGUNTA genérica sobre cartões/contas (não "conta de luz").
  if (/\bgast\w+/i.test(msg)
      && (/\bcart[ãa]o\b|\bcart[õo]es\b|\bcontas\b|\bconta\s+banc\w*/i.test(msg))) {
    return { acao: 'gastos_carteiras' };
  }

  if (/\bgast(?:o|os|ei|ar|ando|amos|aria)\b/i.test(msg)) {
    const mm = msg.match(/\bgast\w+\b[^?!.]*?\b(?:com|de|d[oa]s?|em|n[oa]s?|sobre)\s+(.+)$/i);
    if (mm) {
      // Sobra a categoria/lugar: filtro por PALAVRA INTEIRA (não usa \b, que em JS
      // corta vogal acentuada — "alimentação" viraria "alimentaçã").
      const STOP = new Set(['o','a','os','as','um','uma','meu','minha','meus','minhas',
        'esse','essa','este','esta','mes','mês','semana','hoje','ontem','ano','dia',
        'passado','passada','atual','geral']);
      const termo = mm[1].replace(/[?!.,;:]+/g, ' ').trim()
        .split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase())).join(' ').trim();
      if (termo) return { acao: 'buscar', termo, periodo: detectarPeriodo(msg) || undefined };
    }
    return { acao: 'resumo', periodo: detectarPeriodo(msg) || 'mes' };
  }

  // Não reconheceu → vai para a IA (linguagem natural / perguntas soltas)
  return null;
}

module.exports = { interpretarRapido, detectarCategoria, detectarPeriodo };