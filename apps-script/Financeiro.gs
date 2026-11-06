// =====================================================================
// BRASERO 96 · FINANCEIRO
// Entradas, saídas, saldo (Caixa × Banco), transferências, estorno,
// fechamento de caixa e contas a pagar.
// As vendas das comandas entram automaticamente (lidas de resumo_fechamentos),
// sem serem copiadas para a aba financeiro → nunca duplicam.
// =====================================================================

const FIN_FORMAS_ = ['Dinheiro', 'PIX', 'Cartão Débito', 'Cartão Crédito', 'Transferência', 'Boleto'];
const COLS_FIN_ = 17;
// 0 ID | 1 Data | 2 Tipo | 3 Conta | 4 Categoria | 5 Descricao | 6 Valor | 7 Forma | 8 Evento_ID
// 9 Conta_Pagar_ID | 10 Origem | 11 Status | 12 Usuario | 13 Criado_Em | 14 Estornado_Por | 15 Estornado_Em | 16 Motivo
const COLS_CONTAS_ = 12;
// 0 ID | 1 Descricao | 2 Categoria | 3 Valor | 4 Vencimento | 5 Status | 6 Pago_Em | 7 Lancamento_ID
// 8 Usuario | 9 Criado_Em | 10 Observacao | 11 Forma_Pagamento
const ORIGENS_FORA_RESULTADO_ = ['Transferência', 'Saldo inicial'];

// ---------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------
function isoData_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, BRASERO_CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const t = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function validarDataIso_(texto, campo) {
  texto = String(texto || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    const [a, m, d] = texto.split('-').map(Number);
    if (new Date(Date.UTC(a, m - 1, d)).toISOString().slice(0, 10) === texto) return texto;
  }
  throw erroBrasero_('DATA_INVALIDA', (campo || 'Data') + ' inválida.');
}

function somarMeses_(iso, meses) {
  const [a, m, d] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

function valorFin_(v, permitirZero) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!permitirZero && n === 0) || n > 9999999 ||
      Math.abs(n * 100 - Math.round(n * 100)) > 0.00001)
    throw erroBrasero_('VALOR_INVALIDO', 'Informe um valor válido em reais (até 2 casas decimais).');
  return Math.round(n * 100) / 100;
}

function numeroPlanilha_(v) {
  try { return Number(dinheiro_(v)) || 0; } catch (_) { return 0; }
}

function contaDaForma_(forma) {
  return forma === 'Dinheiro' ? 'Caixa' : 'Banco';
}

function novoId_(prefixo) {
  return prefixo + '-' + Utilities.formatDate(new Date(), BRASERO_CONFIG.TIMEZONE, 'yyMMddHHmmss') + '-' +
    Utilities.getUuid().replace(/-/g, '').slice(0, 5).toUpperCase();
}

function inicioFinanceiro_() {
  return PropertiesService.getScriptProperties().getProperty('BRASERO_FIN_INICIO') || '2000-01-01';
}

function cent_(v) { return Math.round(Number(v || 0) * 100); }

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------
function lerLancamentos_() {
  return linhas_(brasero_('financeiro'), COLS_FIN_)
    .map((r, i) => ({
      linha: i + 2, id: String(r[0] || '').trim(), data: isoData_(r[1]),
      tipo: String(r[2]).trim() === 'Entrada' ? 'Entrada' : 'Saída',
      conta: String(r[3]).trim() === 'Caixa' ? 'Caixa' : 'Banco',
      categoria: String(r[4] || 'Outros'), descricao: String(r[5] || ''),
      valor: numeroPlanilha_(r[6]), forma: String(r[7] || ''), eventoId: String(r[8] || ''),
      contaPagarId: String(r[9] || ''), origem: String(r[10] || 'Manual'),
      status: String(r[11] || 'Ativo').trim() === 'Estornado' ? 'Estornado' : 'Ativo',
      usuario: String(r[12] || ''), criadoEm: String(r[13] || ''),
      estornadoPor: String(r[14] || ''), estornadoEm: String(r[15] || ''), motivoEstorno: String(r[16] || '')
    }))
    .filter(l => l.id);
}

// Vendas das comandas agrupadas por dia e forma (em centavos). Cache de 5 min, limpo a cada fechamento.
function vendasPorDia_() {
  const cache = CacheService.getScriptCache();
  const salvo = cache.get('brasero_fin_vendas_v1');
  if (salvo) try { return JSON.parse(salvo); } catch (_) {}
  const inicio = inicioFinanceiro_(), mapa = {};
  const aba = brasero_('resumo_fechamentos'), ultima = aba.getLastRow();
  if (ultima > 1) {
    const vistos = new Set();
    aba.getRange(2, 1, ultima - 1, 9).getValues().forEach(r => {
      const id = String(r[0] || '').trim();
      if (!id || vistos.has(id)) return;
      vistos.add(id);
      const dia = isoData_(dataFechamento_(r[1]));
      if (!dia || dia < inicio) return;
      let pagamentos = [];
      try { pagamentos = JSON.parse(String(r[8] || '[]')); } catch (_) {}
      if (!Array.isArray(pagamentos) || !pagamentos.length)
        pagamentos = [{forma: String(r[5] || 'Não informado'), valor: numeroPlanilha_(r[4])}];
      const d = mapa[dia] || (mapa[dia] = {qtd: 0, porForma: {}});
      d.qtd++;
      pagamentos.forEach(p => {
        const forma = String(p.forma || 'Não informado');
        d.porForma[forma] = (d.porForma[forma] || 0) + cent_(p.valor);
      });
    });
  }
  const json = JSON.stringify(mapa);
  if (json.length < 90000) cache.put('brasero_fin_vendas_v1', json, 300);
  return mapa;
}

function saldosCentavos_(lancamentos, vendas) {
  const s = {Caixa: 0, Banco: 0};
  lancamentos.forEach(l => {
    if (l.status === 'Ativo') s[l.conta] += (l.tipo === 'Entrada' ? 1 : -1) * cent_(l.valor);
  });
  Object.values(vendas).forEach(v => Object.entries(v.porForma).forEach(([forma, c]) => {
    s[contaDaForma_(forma)] += c;
  }));
  return s;
}

function saldosPublicos_(s) {
  return {caixa: s.Caixa / 100, banco: s.Banco / 100, total: (s.Caixa + s.Banco) / 100};
}

function lancamentoPublico_(l) {
  const copia = Object.assign({}, l);
  delete copia.linha;
  return copia;
}

// Linhas automáticas (uma por dia e conta) para mostrar as vendas no extrato.
function linhasVendas_(vendas, filtro) {
  const saida = [];
  Object.keys(vendas).filter(filtro).sort().forEach(dia => {
    const porConta = {Caixa: {c: 0, formas: []}, Banco: {c: 0, formas: []}};
    Object.entries(vendas[dia].porForma).forEach(([forma, c]) => {
      const g = porConta[contaDaForma_(forma)];
      g.c += c; g.formas.push(forma + ' ' + (c / 100).toFixed(2).replace('.', ','));
    });
    ['Caixa', 'Banco'].forEach(conta => {
      if (!porConta[conta].c) return;
      saida.push({id: 'VENDAS-' + dia + '-' + conta, data: dia, tipo: 'Entrada', conta,
        categoria: 'Vendas (comandas)', descricao: vendas[dia].qtd + ' comanda(s) no dia · ' + porConta[conta].formas.join(' · '),
        valor: porConta[conta].c / 100, forma: '', origem: 'Vendas', status: 'Ativo', automatico: true,
        usuario: 'Sistema', criadoEm: ''});
    });
  });
  return saida;
}

// ---------------------------------------------------------------------
// Painel do financeiro (Admin)
// ---------------------------------------------------------------------
function financeiroPainelBrasero(dados) {
  try {
    dados = dados || {};
    exigirSessao_(dados, SO_ADMIN_);
    const hoje = hojeIso_();
    const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(dados.mes || '')) ? dados.mes : hoje.slice(0, 7);
    const lancamentos = lerLancamentos_(), vendas = vendasPorDia_();
    const saldos = saldosPublicos_(saldosCentavos_(lancamentos, vendas));

    const doMes = lancamentos.filter(l => l.data.startsWith(mes));
    const vendasMes = linhasVendas_(vendas, dia => dia.startsWith(mes));
    let entrou = 0, saiu = 0;
    const porCategoria = {}, porOrigem = {};
    doMes.concat(vendasMes).forEach(l => {
      if (l.status !== 'Ativo' || ORIGENS_FORA_RESULTADO_.includes(l.origem)) return;
      const c = cent_(l.valor);
      if (l.tipo === 'Entrada') {
        entrou += c;
        const origem = l.origem === 'Vendas' ? 'Vendas das comandas' : l.eventoId ? 'Eventos' : l.categoria || 'Outras entradas';
        porOrigem[origem] = (porOrigem[origem] || 0) + c;
      } else {
        saiu += c;
        porCategoria[l.categoria] = (porCategoria[l.categoria] || 0) + c;
      }
    });
    const ordenar = obj => Object.entries(obj).map(([nome, c]) => ({nome, total: c / 100})).sort((a, b) => b.total - a.total);
    const movimentos = doMes.map(lancamentoPublico_).concat(vendasMes)
      .sort((a, b) => b.data.localeCompare(a.data) || String(b.criadoEm).localeCompare(String(a.criadoEm)));

    return {ok: true, mes, hoje, saldos,
      mesResumo: {entrou: entrou / 100, saiu: saiu / 100, resultado: (entrou - saiu) / 100},
      saidasPorCategoria: ordenar(porCategoria), entradasPorOrigem: ordenar(porOrigem),
      movimentos, alertas: alertasContas_(hoje), eventos: resumoEventosAReceber_(lancamentos)};
  } catch (e) { return retornoErro_(e); }
}

// ---------------------------------------------------------------------
// Lançar entrada/saída
// Atendente: apenas SAÍDA, com data de hoje e sem evento.
// ---------------------------------------------------------------------
function lancarFinanceiroBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    const sessao = exigirSessao_(dados);
    const tipo = dados.tipo === 'Entrada' ? 'Entrada' : dados.tipo === 'Saída' ? 'Saída' : '';
    if (!tipo) return falha_('TIPO_INVALIDO', 'Escolha entrada ou saída.');
    if (!sessao.admin && tipo !== 'Saída') return falha_('PERMISSAO', 'Atendentes podem registrar apenas saídas.');
    const hoje = hojeIso_();
    const data = sessao.admin ? validarDataIso_(dados.data || hoje, 'Data') : hoje;
    if (data > hoje) return falha_('DATA_FUTURA', 'Não lance com data futura. Para pagamentos futuros use Contas a pagar.');
    const valor = valorFin_(dados.valor);
    const forma = FIN_FORMAS_.includes(dados.forma) ? dados.forma : null;
    if (!forma) return falha_('FORMA_INVALIDA', 'Selecione a forma (dinheiro, PIX, cartão...).');
    const categoria = textoCardapio_(dados.categoria, 'Categoria', 60);
    const descricao = textoSeguro_(dados.descricao, 200);
    let eventoId = '';
    if (dados.eventoId) {
      if (!sessao.admin) return falha_('PERMISSAO', 'Somente administradores lançam em eventos.');
      eventoId = String(dados.eventoId);
      if (!lerEventos_().some(ev => ev.id === eventoId)) return falha_('EVENTO_NAO_ENCONTRADO', 'Evento não encontrado.');
    }
    let origem = eventoId ? 'Evento' : 'Manual';
    if (categoria === 'Saldo inicial') {
      if (!sessao.admin || tipo !== 'Entrada') return falha_('PERMISSAO', 'Saldo inicial deve ser uma entrada lançada pelo administrador.');
      origem = 'Saldo inicial';
    }
    const id = novoId_('LAN');
    brasero_('financeiro').appendRow([id, data, tipo, contaDaForma_(forma), categoria, descricao, valor, forma,
      eventoId, '', origem, 'Ativo', sessao.nome, agora_(), '', '', '']);
    return {ok: true, id};
  });
}

function estornarLancamentoBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    const sessao = exigirSessao_(dados, SO_ADMIN_);
    const motivo = String(dados.motivo || '').trim();
    if (motivo.length < 3) return falha_('MOTIVO', 'Explique o motivo do estorno.');
    const lancamentos = lerLancamentos_();
    const alvo = lancamentos.find(l => l.id === String(dados.id || ''));
    if (!alvo) return falha_('NAO_ENCONTRADO', 'Lançamento não encontrado. Atualize a tela.');
    if (alvo.status === 'Estornado') return falha_('JA_ESTORNADO', 'Este lançamento já foi estornado.');
    // Transferência: estorna as duas pernas juntas.
    const base = alvo.origem === 'Transferência' ? alvo.id.replace(/-(S|E)$/, '') : null;
    const afetados = base ? lancamentos.filter(l => l.id === base + '-S' || l.id === base + '-E') : [alvo];
    const aba = brasero_('financeiro'), quando = agora_();
    afetados.forEach(l => {
      aba.getRange(l.linha, 12).setValue('Estornado');
      aba.getRange(l.linha, 15, 1, 3).setValues([[sessao.nome, quando, textoSeguro_(motivo, 200)]]);
    });
    // Pagamento de conta estornado → a conta volta a ficar em aberto.
    if (alvo.contaPagarId) {
      const conta = lerContas_().find(c => c.id === alvo.contaPagarId);
      if (conta && conta.status === 'Paga')
        brasero_('contas_pagar').getRange(conta.linha, 6, 1, 3).setValues([['Aberta', '', '']]);
    }
    return {ok: true, estornados: afetados.length};
  });
}

function transferirContaBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    const sessao = exigirSessao_(dados, SO_ADMIN_);
    const origem = dados.origem === 'Banco' ? 'Banco' : 'Caixa', destino = origem === 'Caixa' ? 'Banco' : 'Caixa';
    const valor = valorFin_(dados.valor);
    const descricao = textoSeguro_(dados.descricao || (origem === 'Caixa' ? 'Sangria / depósito' : 'Reforço de troco'), 200);
    const base = novoId_('TRF'), hoje = hojeIso_(), quando = agora_();
    const aba = brasero_('financeiro');
    aba.appendRow([base + '-S', hoje, 'Saída', origem, 'Transferência entre contas', descricao, valor,
      origem === 'Caixa' ? 'Dinheiro' : 'Transferência', '', '', 'Transferência', 'Ativo', sessao.nome, quando, '', '', '']);
    aba.appendRow([base + '-E', hoje, 'Entrada', destino, 'Transferência entre contas', descricao, valor,
      destino === 'Caixa' ? 'Dinheiro' : 'Transferência', '', '', 'Transferência', 'Ativo', sessao.nome, quando, '', '', '']);
    return {ok: true, id: base};
  });
}

// Atendente vê as saídas que lançou hoje; admin vê todas de hoje.
function saidasHojeBrasero(dados) {
  try {
    const sessao = exigirSessao_(dados);
    const hoje = hojeIso_();
    const lista = lerLancamentos_().filter(l => l.data === hoje && l.tipo === 'Saída' && l.origem === 'Manual' &&
      (sessao.admin || l.usuario === sessao.nome)).map(lancamentoPublico_).reverse();
    return {ok: true, saidas: lista};
  } catch (e) { return retornoErro_(e); }
}

// ---------------------------------------------------------------------
// Fechamento de caixa (dinheiro físico)
// ---------------------------------------------------------------------
function caixaBrasero(dados) {
  try {
    exigirSessao_(dados, SO_ADMIN_);
    const hoje = hojeIso_(), lancamentos = lerLancamentos_(), vendas = vendasPorDia_();
    const saldo = saldosCentavos_(lancamentos, vendas).Caixa;
    const vendasHoje = (vendas[hoje] && vendas[hoje].porForma['Dinheiro']) || 0;
    let entradasHoje = 0, saidasHoje = 0;
    lancamentos.forEach(l => {
      if (l.status !== 'Ativo' || l.conta !== 'Caixa' || l.data !== hoje) return;
      if (l.tipo === 'Entrada') entradasHoje += cent_(l.valor); else saidasHoje += cent_(l.valor);
    });
    const historico = linhas_(brasero_('fechamento_caixa'), 9).filter(r => String(r[0]).trim()).slice(-15).reverse()
      .map(r => ({id: String(r[0]), data: isoData_(r[1]), esperado: numeroPlanilha_(r[2]), contado: numeroPlanilha_(r[3]),
        diferenca: Number(r[4]) || 0, observacao: String(r[5] || ''), usuario: String(r[6] || ''), criadoEm: String(r[7] || '')}));
    return {ok: true, hoje, esperado: saldo / 100,
      hojeResumo: {vendasDinheiro: vendasHoje / 100, entradas: entradasHoje / 100, saidas: saidasHoje / 100},
      historico};
  } catch (e) { return retornoErro_(e); }
}

function registrarFechamentoCaixaBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    const sessao = exigirSessao_(dados, SO_ADMIN_);
    const contado = valorFin_(dados.contado, true);
    const esperadoCent = saldosCentavos_(lerLancamentos_(), vendasPorDia_()).Caixa;
    if (dados.esperadoVisto != null && Math.abs(cent_(dados.esperadoVisto) - esperadoCent) > 0)
      return falha_('CAIXA_MUDOU', 'O valor esperado mudou (nova venda ou lançamento). Confira e registre de novo.', {esperado: esperadoCent / 100});
    const diferencaCent = cent_(contado) - esperadoCent;
    const hoje = hojeIso_(), quando = agora_(), observacao = textoSeguro_(dados.observacao, 300);
    let lancamentoId = '';
    if (diferencaCent !== 0) {
      lancamentoId = novoId_('LAN');
      brasero_('financeiro').appendRow([lancamentoId, hoje, diferencaCent > 0 ? 'Entrada' : 'Saída', 'Caixa', 'Ajuste de caixa',
        (diferencaCent > 0 ? 'Sobra' : 'Falta') + ' no fechamento de caixa' + (observacao ? ' · ' + observacao : ''),
        Math.abs(diferencaCent) / 100, 'Dinheiro', '', '', 'Fechamento de caixa', 'Ativo', sessao.nome, quando, '', '', '']);
    }
    brasero_('fechamento_caixa').appendRow([novoId_('CX'), hoje, esperadoCent / 100, contado, diferencaCent / 100,
      observacao, sessao.nome, quando, lancamentoId]);
    return {ok: true, esperado: esperadoCent / 100, contado, diferenca: diferencaCent / 100};
  });
}

// ---------------------------------------------------------------------
// Contas a pagar
// ---------------------------------------------------------------------
function lerContas_() {
  return linhas_(brasero_('contas_pagar'), COLS_CONTAS_)
    .map((r, i) => ({linha: i + 2, id: String(r[0] || '').trim(), descricao: String(r[1] || ''),
      categoria: String(r[2] || 'Outros'), valor: numeroPlanilha_(r[3]), vencimento: isoData_(r[4]),
      status: ['Aberta', 'Paga', 'Cancelada'].includes(String(r[5]).trim()) ? String(r[5]).trim() : 'Aberta',
      pagoEm: isoData_(r[6]), lancamentoId: String(r[7] || ''), usuario: String(r[8] || ''),
      criadoEm: String(r[9] || ''), observacao: String(r[10] || ''), formaPagamento: String(r[11] || '')}))
    .filter(c => c.id);
}

function situacaoConta_(c, hoje) {
  if (c.status !== 'Aberta') return c.status.toLowerCase();
  if (c.vencimento < hoje) return 'vencida';
  if (c.vencimento === hoje) return 'hoje';
  if (c.vencimento === somarDias_(hoje, 1)) return 'amanha';
  return c.vencimento <= somarDias_(hoje, 7) ? 'semana' : 'futura';
}

function somarDias_(iso, dias) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

function alertasContas_(hoje) {
  const r = {vencidas: 0, valorVencidas: 0, hoje: 0, valorHoje: 0, semana: 0, valorSemana: 0, abertas: 0, valorAbertas: 0};
  try {
    lerContas_().filter(c => c.status === 'Aberta').forEach(c => {
      const s = situacaoConta_(c, hoje), v = cent_(c.valor);
      r.abertas++; r.valorAbertas += v;
      if (s === 'vencida') { r.vencidas++; r.valorVencidas += v; }
      else if (s === 'hoje') { r.hoje++; r.valorHoje += v; }
      else if (s === 'amanha' || s === 'semana') { r.semana++; r.valorSemana += v; }
    });
  } catch (_) {}
  ['valorVencidas', 'valorHoje', 'valorSemana', 'valorAbertas'].forEach(k => r[k] /= 100);
  return r;
}

function contasPagarBrasero(dados) {
  try {
    exigirSessao_(dados, SO_ADMIN_);
    const hoje = hojeIso_(), limite = somarDias_(hoje, -60);
    const contas = lerContas_()
      .filter(c => c.status === 'Aberta' || (c.pagoEm || c.vencimento) >= limite)
      .map(c => { const p = lancamentoPublico_(c); p.situacao = situacaoConta_(c, hoje); return p; })
      .sort((a, b) => a.vencimento.localeCompare(b.vencimento));
    return {ok: true, hoje, contas, alertas: alertasContas_(hoje)};
  } catch (e) { return retornoErro_(e); }
}

function salvarContaPagarBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    const sessao = exigirSessao_(dados, SO_ADMIN_);
    const descricao = textoCardapio_(dados.descricao, 'Descrição', 120);
    const categoria = textoCardapio_(dados.categoria, 'Categoria', 60);
    const valor = valorFin_(dados.valor);
    const vencimento = validarDataIso_(dados.vencimento, 'Vencimento');
    const observacao = textoSeguro_(dados.observacao, 300);
    const aba = brasero_('contas_pagar');
    if (dados.id) {
      const conta = lerContas_().find(c => c.id === String(dados.id));
      if (!conta) return falha_('NAO_ENCONTRADO', 'Conta não encontrada.');
      if (conta.status !== 'Aberta') return falha_('NAO_EDITAVEL', 'Só é possível editar contas em aberto.');
      aba.getRange(conta.linha, 2, 1, 4).setValues([[descricao, categoria, valor, vencimento]]);
      aba.getRange(conta.linha, 11).setValue(observacao);
      return {ok: true, id: conta.id};
    }
    const repetir = Math.max(1, Math.min(12, Math.floor(Number(dados.repetirMeses) || 1)));
    const quando = agora_(), linhas = [];
    for (let i = 0; i < repetir; i++) {
      linhas.push([novoId_('CTA') + (repetir > 1 ? '-' + (i + 1) : ''),
        repetir > 1 ? `${descricao} (${i + 1}/${repetir})` : descricao, categoria, valor,
        somarMeses_(vencimento, i), 'Aberta', '', '', sessao.nome, quando, observacao, '']);
    }
    aba.getRange(aba.getLastRow() + 1, 1, linhas.length, COLS_CONTAS_).setValues(linhas);
    return {ok: true, criadas: linhas.length};
  });
}

function pagarContaBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    const sessao = exigirSessao_(dados, SO_ADMIN_);
    const conta = lerContas_().find(c => c.id === String(dados.id || ''));
    if (!conta) return falha_('NAO_ENCONTRADO', 'Conta não encontrada.');
    if (conta.status !== 'Aberta') return falha_('JA_PAGA', 'Esta conta não está mais em aberto.');
    const forma = FIN_FORMAS_.includes(dados.forma) ? dados.forma : null;
    if (!forma) return falha_('FORMA_INVALIDA', 'Selecione como foi pago.');
    const hoje = hojeIso_(), data = validarDataIso_(dados.data || hoje, 'Data do pagamento');
    if (data > hoje) return falha_('DATA_FUTURA', 'A data do pagamento não pode ser futura.');
    const valor = dados.valor != null && dados.valor !== '' ? valorFin_(dados.valor) : conta.valor;
    const id = novoId_('LAN');
    brasero_('financeiro').appendRow([id, data, 'Saída', contaDaForma_(forma), conta.categoria,
      textoSeguro_('Conta: ' + conta.descricao, 200), valor, forma, '', conta.id, 'Conta a pagar', 'Ativo', sessao.nome, agora_(), '', '', '']);
    const aba = brasero_('contas_pagar');
    aba.getRange(conta.linha, 6, 1, 3).setValues([['Paga', data, id]]);
    aba.getRange(conta.linha, 12).setValue(forma);
    return {ok: true, lancamentoId: id};
  });
}

function cancelarContaPagarBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    exigirSessao_(dados, SO_ADMIN_);
    const conta = lerContas_().find(c => c.id === String(dados.id || ''));
    if (!conta) return falha_('NAO_ENCONTRADO', 'Conta não encontrada.');
    if (conta.status !== 'Aberta') return falha_('NAO_EDITAVEL', 'Só é possível cancelar contas em aberto.');
    brasero_('contas_pagar').getRange(conta.linha, 6).setValue('Cancelada');
    return {ok: true};
  });
}
