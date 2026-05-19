const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
{"acao":"set_wallet","nome":"Nubank","valor":1000}
{"acao":"adicionar_saldo","nome":"Inter","valor":200}
{"acao":"alterar_saldo","nome":"Nubank","valor":2000}
{"acao":"ver_saldos"}
{"acao":"deletar_conta","nome":"Nubank"}
{"acao":"transferir","origem":"Nubank","destino":"Inter","valor":200}

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

CONVERSA GENÉRICA (quando não é nenhuma ação acima):
{"acao":"conversa","resposta":"sua resposta aqui"}

REGRAS IMPORTANTES:
1. Retorne SOMENTE o JSON, nada mais.
2. Detecte o banco pelo nome: Nubank, Inter, Itaú, Bradesco, Santander, C6 Bank, Mercado Pago, Picpay, Caixa, Banco do Brasil.
3. Se mencionar "crédito" junto ao banco, adicione " Crédito" ao nome: "Nubank Crédito".
4. Se não souber a categoria, use "Outros".
5. Se não mencionar carteira/banco, use "Dinheiro".
6. Para valores, extraia apenas o número (ex: "cinquenta reais" → 50).
7. Para conversa genérica ou dúvidas, use {"acao":"conversa","resposta":"..."} e responda em português, de forma amigável e breve.
8. Para DÍVIDAS: tipo deve ser um destes: emprestimo, financiamento, crediario, cartao_rotativo, cheque_especial, consignado, fies, outro. Se o usuário não disser o tipo, use "emprestimo". Em "cancelar_lembrete_divida" com termo=null, desativa TODOS os lembretes de dívidas do usuário.`;

// Função principal: interpreta qualquer mensagem
async function interpretarMensagem(mensagem, contexto = {}) {
  try {
    const userContent = contexto.resumo
      ? `Contexto do usuário:\n${contexto.resumo}\n\nMensagem: ${mensagem}`
      : mensagem;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    });

    const texto = response.content[0].text.trim();

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
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Você é especialista em finanças pessoais. Com base nesses gastos dos últimos 30 dias, dê 3 dicas práticas e específicas para economizar. Seja direto e use emojis.\n\n${resumoGastos}`
      }]
    });
    return response.content[0].text;
  } catch (err) {
    console.error('❌ Erro ao gerar dicas:', err.message);
    return 'Não consegui gerar dicas no momento. Tente novamente mais tarde.';
  }
}

// Analisa gastos da semana (plano básico)
async function analisarGastos(resumoSemana) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Você é um conselheiro financeiro bem-humorado. Analise esses gastos da última semana e dê um comentário curto e engraçado com uma dica prática. Use no máximo 3 linhas.\n\nGastos: ${resumoSemana}`
      }]
    });
    return response.content[0].text;
  } catch (err) {
    return 'Não consegui analisar agora. Tente mais tarde!';
  }
}

// Classifica a intencao em "finance" ou "grow" para rotear no webhook
async function classificarIntencao(mensagem) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 5,
      system: `Classifique a mensagem em apenas UMA palavra: "finance" ou "grow".

FINANCE: dinheiro, gastos, despesas, receitas, salario, saldo, transferencias, contas bancarias, investimentos, cartoes, parcelas, limites, metas financeiras, dividas, emprestimos, financiamento, crediario, pix.

GROW: treino, exercicio, academia, corrida, dieta, peso, agua, habito, tarefa, projeto, humor, ansiedade, estresse, gratidao, sono, estudos, leitura, faculdade, filhos, escola, lista de compras (itens domesticos como leite, arroz), remedio, consulta medica, rotina, meditacao.

Em caso de duvida ou conversa generica, responda "finance".
Responda APENAS com a palavra "finance" ou "grow".`,
      messages: [{ role: 'user', content: mensagem }],
    });
    const r = response.content[0].text.trim().toLowerCase();
    return r.includes('grow') ? 'grow' : 'finance';
  } catch {
    return 'finance';
  }
}

module.exports = { interpretarMensagem, gerarDicas, analisarGastos, classificarIntencao };