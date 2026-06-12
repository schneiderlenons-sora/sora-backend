const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Categorias disponíveis no sistema
const CATEGORIAS = [
  'Mercado','Transporte','Lazer e Entretenimento','Saúde','Aluguel',
  'Educação','Casa','Salário','Alimentação','Recebimento','Transferências',
  'Internet','Pet','Padaria','Assinaturas','Vestuário','Impostos',
  'Viagem','Doações','Outros'
];

// Prompt base do sistema
const SYSTEM_PROMPT = `Você é a Sora, assistente financeira via WhatsApp. Interprete mensagens e retorne APENAS um JSON válido, sem texto antes ou depois.

CATEGORIAS DISPONÍVEIS: ${CATEGORIAS.join(', ')}

AÇÕES DISPONÍVEIS — retorne o JSON correspondente:

TRANSAÇÕES:
{"acao":"salvar","tipo":"Gasto","valor":50,"categoria":"Mercado","observacao":"mercado","carteira_nome":"Dinheiro"}
{"acao":"salvar","tipo":"Recebimento","valor":2000,"categoria":"Recebimento","observacao":"salário","carteira_nome":"Dinheiro"}

CONTAS BANCÁRIAS:
{"acao":"set_wallet","nome":"Nubank","valor":1000,"tipo":"Corrente"}
{"acao":"set_wallet","nome":"Itaú","valor":5000,"tipo":"Poupança"}
{"acao":"set_wallet","nome":"Alelo","valor":800,"tipo":"Vale Alimentação"}
{"acao":"set_wallet","nome":"Carteira","valor":200,"tipo":"Dinheiro"}
{"acao":"adicionar_saldo","nome":"Inter","valor":200}
{"acao":"alterar_saldo","nome":"Nubank","valor":2000}
{"acao":"ver_saldos"}
{"acao":"deletar_conta","nome":"Nubank"}
{"acao":"transferir","origem":"Nubank","destino":"Inter","valor":200}

CARTÕES DE CRÉDITO (ação separada de conta bancária):
{"acao":"set_cartao","nome":"Nubank","limite":5000,"dia_fechamento":5,"dia_vencimento":15,"bandeira":"Mastercard"}
{"acao":"set_cartao","nome":"Itaú","limite":3000,"dia_fechamento":null,"dia_vencimento":null,"bandeira":null}
- Use quando o usuário mencionar "cartão", "cartão de crédito" ou "crédito" como tipo de produto (não para gastos no cartão — isso é "salvar" com carteira_nome="X Crédito").
- Campos podem ser null se o usuário não informou — a Sora vai perguntar depois.
- Bandeira válidas: Visa, Mastercard, Elo, Amex, Hipercard.
- Tipos de compra a IA NUNCA pede últimos 4 dígitos.

LIMITES:
{"acao":"set_limite","categoria":"Mercado","valor":500}
{"acao":"set_meta","valor":2000}
{"acao":"meus_limites"}

RELATÓRIOS:
{"acao":"resumo"}
{"acao":"analisar"}
{"acao":"buscar","termo":"mercado"}
{"acao":"ver_saldos"}

PARCELAS:
{"acao":"compra_parcelada","descricao":"fone","carteira":"Nubank Crédito","numParcelas":3,"valorParcela":150,"valorTotal":450,"categoria":"Outros"}
{"acao":"pagar_parcela","descricao":"fone"}
{"acao":"confirmar_pagamento_parcela","descricao":"fone"}

RECORRÊNCIAS:
{"acao":"set_recorrente","valor":1000,"descricao":"aluguel","dia":5,"tipo":"Gasto"}
{"acao":"cancelar_recorrencia","descricao":"aluguel"}

LEMBRETES:
{"acao":"criar_lembrete","tipo":"pagar","descricao":"conta luz","dia":10,"mes":4,"valor":150}

DÍVIDAS (empréstimos, financiamentos, crediário, etc.):
{"acao":"criar_divida","titulo":"Empréstimo Nubank","credor":"Nubank","tipo":"emprestimo","valor_total":5000,"parcelas_total":10,"dia_vencimento":15,"taxa_juros":2.5}
{"acao":"listar_dividas"}
{"acao":"pagar_divida","termo":"nubank","valor":250,"tipo":"parcela"}
{"acao":"pagar_divida","termo":"financiamento carro","valor":1200,"tipo":"antecipacao"}
{"acao":"quitar_divida","termo":"crediario lojas americanas","valor":null}
{"acao":"cancelar_lembrete_divida","termo":"nubank"}
{"acao":"cancelar_lembrete_divida","termo":null}
{"acao":"ativar_lembrete_divida","termo":"nubank"}
{"acao":"ativar_lembrete_divida","termo":null}

GRUPOS:
{"acao":"criar_grupo","nome":"Família"}
{"acao":"convidar_grupo"}
{"acao":"entrar_grupo","codigo":"ABC123"}
{"acao":"meus_grupos"}
{"acao":"trocar_grupo","nome":"Família"}
{"acao":"listar_membros"}
{"acao":"remover_membro","nome":"João"}

INVESTIMENTOS (plano Black):
{"acao":"criar_investimento","tipo":"CDB/CDI","nome":"CDB Banco X","valorAportado":1000,"quantidade":1,"precoUnitario":1000}
{"acao":"listar_investimentos"}
{"acao":"registrar_aporte","valor":500,"investimentoId":null,"descricao":"aporte mensal"}
{"acao":"listar_aportes"}
{"acao":"criar_meta","nome":"Casa própria","valorObjetivo":500000,"prazoAnos":10,"taxaAnual":10}
{"acao":"listar_metas"}
{"acao":"progresso_meta","metaId":"id_aqui"}
{"acao":"sugerir_alocacao","metaId":"id_aqui","perfil":"moderado"}
{"acao":"gerar_dicas"}
{"acao":"ver_dividendos"}

OUTROS:
{"acao":"ajuda"}
{"acao":"painel"}
{"acao":"set_fatura_dia","dia":15}
{"acao":"apagar"}
{"acao":"apagar","idCurto":"ABC123"}

CORRIGIR ÚLTIMA TRANSAÇÃO (quando o usuário diz que errou a conta):
{"acao":"corrigir_ultima_carteira","carteira_nome":"Nubank"}
Exemplos que disparam:
- "não, foi do nubank"
- "corrige a última pra inter"
- "esse último foi no cartão do itau"
- "a última foi crédito do nubank"

CONVERSA GENÉRICA (quando não é nenhuma ação acima):
{"acao":"conversa","resposta":"sua resposta aqui"}

REGRAS IMPORTANTES:
1. Retorne SOMENTE o JSON, nada mais.
2. Detecte o banco pelo nome: Nubank, Inter, Itaú, Bradesco, Santander, C6 Bank, Mercado Pago, Picpay, Caixa, Banco do Brasil.
3. Se mencionar "crédito" junto ao banco em um GASTO (ex: "comprei 50 nubank crédito"), adicione " Crédito" ao carteira_nome: "Nubank Crédito".
4. Se não souber a categoria, use "Outros".
5. Carteira padrão (quando o usuário NÃO menciona banco):
   - Se o contexto trouxer "wallet_padrao_nome", use ESSE valor.
   - Senão, use "Dinheiro".
6. Para valores, extraia apenas o número (ex: "cinquenta reais" → 50).
7. Para conversa genérica ou dúvidas, use {"acao":"conversa","resposta":"..."} e responda em português, de forma amigável e breve.
8. Para DÍVIDAS: tipo deve ser um destes: emprestimo, financiamento, crediario, cartao_rotativo, cheque_especial, consignado, fies, outro. Se o usuário não disser o tipo, use "emprestimo". Em "cancelar_lembrete_divida" com termo=null, desativa TODOS os lembretes de dívidas do usuário.
9. CONTAS bancárias — campo "tipo" (set_wallet):
   - "Corrente" = padrão (default se não disser nada)
   - "Poupança" = palavras "poupança", "poup", "save"
   - "Vale Alimentação" = "vale alimentação", "VA", "alelo", "sodexo", "ticket", "refeição"
   - "Dinheiro" = "carteira", "dinheiro", "espécie", "cash"
10. CARTÕES de crédito (set_cartao) — extraia da mensagem:
    - "limite" / "limite total" → campo limite (número)
    - "fecha dia X" / "fechamento X" → dia_fechamento (1-28)
    - "vence dia X" / "vencimento X" → dia_vencimento (1-28)
    - bandeira mencionada (visa/master/elo/amex/hipercard) → bandeira capitalizada
    - Campos não mencionados ficam null — a Sora pergunta depois.
    - NUNCA pergunte "últimos 4 dígitos" — não é necessário.`;

// Função principal: interpreta qualquer mensagem
async function interpretarMensagem(mensagem, contexto = {}) {
  try {
    const userContent = contexto.resumo
      ? `Contexto do usuário:\n${contexto.resumo}\n\nMensagem: ${mensagem}`
      : mensagem;

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });

    const texto = response.choices[0].message.content.trim();

    // Remove possíveis ```json ``` que o modelo possa adicionar
    const limpo = texto.replace(/```json|```/g, '').trim();

    return JSON.parse(limpo);
  } catch (err) {
    console.error('❌ Erro na IA:', err.message);
    return { acao: 'conversa', resposta: 'Não entendi muito bem. Pode reformular? 😊' };
  }
}

// Gera dicas financeiras personalizadas (plano Black)
async function gerarDicas(resumoGastos) {
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Você é especialista em finanças pessoais. Com base nesses gastos dos últimos 30 dias, dê 3 dicas práticas e específicas para economizar. Seja direto e use emojis.\n\n${resumoGastos}`
      }],
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error('❌ Erro ao gerar dicas:', err.message);
    return 'Não consegui gerar dicas no momento. Tente novamente mais tarde.';
  }
}

// Analisa gastos da semana (plano básico)
async function analisarGastos(resumoSemana) {
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Você é um conselheiro financeiro bem-humorado. Analise esses gastos da última semana e dê um comentário curto e engraçado com uma dica prática. Use no máximo 3 linhas.\n\nGastos: ${resumoSemana}`
      }],
    });
    return response.choices[0].message.content;
  } catch (err) {
    return 'Não consegui analisar agora. Tente mais tarde!';
  }
}

// Classifica a intencao em "finance" ou "grow" para rotear no webhook
async function classificarIntencao(mensagem) {
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 5,
      messages: [
        {
          role: 'system',
          content: `Classifique a mensagem em apenas UMA palavra: "finance" ou "grow".

FINANCE: dinheiro, gastos, despesas, receitas, salario, saldo, transferencias, contas bancarias, investimentos, cartoes, parcelas, limites, metas financeiras, dividas, emprestimos, financiamento, crediario, pix.

GROW: treino, exercicio, academia, corrida, dieta, peso, agua, habito, tarefa, projeto, humor, ansiedade, estresse, gratidao, sono, estudos, leitura, faculdade, filhos, escola, lista de compras (itens domesticos como leite, arroz), remedio, consulta medica, rotina, meditacao.

Em caso de duvida ou conversa generica, responda "finance".
Responda APENAS com a palavra "finance" ou "grow".`,
        },
        { role: 'user', content: mensagem },
      ],
    });
    const r = response.choices[0].message.content.trim().toLowerCase();
    return r.includes('grow') ? 'grow' : 'finance';
  } catch {
    return 'finance';
  }
}

// Fallback do Grow: traduz uma frase natural NUM comando canônico que os
// handlers locais já entendem (sem IA). Retorna a string ou null se não for
// uma ação do Grow. Só é chamado quando o parser local não reconheceu nada.
async function interpretarGrowComando(mensagem) {
  try {
    const hoje = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 60,
      messages: [
        {
          role: 'system',
          content: `Você converte UMA mensagem num comando canônico da Sora (assistente de hábitos/rotina/agenda). Hoje é ${hoje}.
Responda APENAS JSON: {"comando":"..."} — ou {"comando":null} se não for nenhuma das ações abaixo.

Ações (use EXATAMENTE estes formatos):
- Marcar compromisso/lembrete: "marca [o quê] [dia] [hora]"   (ex: "marca dentista terça 15h", "marca médico amanhã 9h")
- Marcar hábito como feito:    "fiz [hábito]"                  (ex: "fiz academia")
- Criar hábito:                "novo hábito [nome]"
- Criar tarefa:                "tarefa [título]"
- Registrar humor:             "me sinto [palavra]"            (ex: "me sinto ótimo")
- Adicionar à lista de compras:"comprar [item]"

Regras:
- Períodos do dia: "de manhã"→9h, "de tarde"→14h, "de noite"→20h.
- Mantenha o dia em palavras ("amanhã", "hoje", "terça", "dia 20") — NÃO calcule a data.
- Só gere um comando se a intenção for claramente uma dessas ações; senão {"comando":null}.`,
        },
        { role: 'user', content: mensagem },
      ],
    });
    const txt = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    const obj = JSON.parse(txt);
    const cmd = obj && typeof obj.comando === 'string' ? obj.comando.trim() : null;
    return cmd && cmd.length > 1 ? cmd : null;
  } catch (err) {
    console.error('❌ Erro IA grow:', err.message);
    return null;
  }
}

module.exports = { interpretarMensagem, gerarDicas, analisarGastos, classificarIntencao, interpretarGrowComando };