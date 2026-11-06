// =====================================================================
// BRASERO 96 · EVENTOS FECHADOS (rodízio, por espetinho ou pacote fechado)
// A ficha do evento guarda o combinado: valor do serviço, custo do serviço,
// NMDO (nossa mão de obra, já inclusa no custo) e cortesia.
// O dinheiro que de fato entrou/saiu são lançamentos do financeiro com
// Evento_ID (sinal, restante = entradas · carne, carvão, equipe = saídas).
// =====================================================================

const COLS_EVENTOS_ = 18;
// 0 ID | 1 Nome | 2 Cliente | 3 Telefone | 4 Data | 5 Quantidade (pessoas ou espetinhos) | 6 Tipo_Cobranca
// 7 Valor_Pessoa (valor por pessoa/unidade) | 8 Valor_Total | 9 Status | 10 Observacao | 11 Usuario | 12 Criado_Em
// 13 Atualizado_Em | 14 Pacote | 15 Custo_Previsto | 16 NMDO | 17 Cortesia
const STATUS_EVENTO_ = ['Orçamento', 'Confirmado', 'Realizado', 'Cancelado'];
const TIPOS_EVENTO_ = ['Rodízio', 'Por espetinho', 'Pacote'];

function tipoEvento_(v) {
  const t = semAcentoServidor_(v);
  if (t.includes('espet')) return 'Por espetinho';
  if (t.includes('pacote')) return 'Pacote';
  return 'Rodízio';
}

function semAcentoServidor_(v) {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function lerEventos_() {
  return linhas_(brasero_('eventos'), COLS_EVENTOS_)
    .map((r, i) => {
      const tipo = tipoEvento_(r[6]);
      const pessoas = Number(r[5]) || 0, valorPessoa = numeroPlanilha_(r[7]), valorTotal = numeroPlanilha_(r[8]);
      const contratado = valorTotal > 0 ? valorTotal : Math.round(pessoas * valorPessoa * 100) / 100;
      return {linha: i + 2, id: String(r[0] || '').trim(), nome: String(r[1] || ''), cliente: String(r[2] || ''),
        telefone: String(r[3] || ''), data: isoData_(r[4]), pessoas, tipo, valorPessoa, valorTotal: contratado, contratado,
        status: STATUS_EVENTO_.includes(String(r[9]).trim()) ? String(r[9]).trim() : 'Orçamento',
        observacao: String(r[10] || ''), usuario: String(r[11] || ''), criadoEm: String(r[12] || ''),
        atualizadoEm: String(r[13] || ''), pacote: String(r[14] || ''), custoPrevisto: numeroPlanilha_(r[15]),
        nmdo: numeroPlanilha_(r[16]), cortesia: String(r[17] || '')};
    })
    .filter(e => e.id);
}

function totaisEvento_(ev, lancamentos) {
  let recebido = 0, custo = 0;
  lancamentos.forEach(l => {
    if (l.eventoId !== ev.id || l.status !== 'Ativo') return;
    if (l.tipo === 'Entrada') recebido += cent_(l.valor); else custo += cent_(l.valor);
  });
  const contratado = cent_(ev.contratado), custoPrevisto = cent_(ev.custoPrevisto), nmdo = cent_(ev.nmdo);
  const publico = lancamentoPublico_(ev);
  return Object.assign(publico, {
    valorUnitario: ev.pessoas ? Math.round(contratado / ev.pessoas) / 100 : 0,
    unidade: ev.tipo === 'Por espetinho' ? 'espetinhos' : 'pessoas',
    // Combinado na ficha (igual à planilha de serviços)
    lucroPrevisto: (contratado - custoPrevisto) / 100,
    lucroMaisNmdo: (contratado - custoPrevisto + nmdo) / 100,
    // Dinheiro já lançado no financeiro
    recebido: recebido / 100, custo: custo / 100,
    aReceber: ev.status === 'Cancelado' ? 0 : Math.max(0, contratado - recebido) / 100,
    aPagar: ev.status === 'Cancelado' ? 0 : Math.max(0, custoPrevisto - custo) / 100,
    lucro: (recebido - custo) / 100,
    custoPorPessoa: ev.pessoas ? Math.round((custo || custoPrevisto) / ev.pessoas) / 100 : 0
  });
}

function resumoEventosAReceber_(lancamentos) {
  const r = {aReceber: 0, eventosAReceber: 0, proximos: 0};
  try {
    const hoje = hojeIso_();
    lerEventos_().forEach(ev => {
      if (ev.status === 'Cancelado' || ev.status === 'Orçamento') return;
      const t = totaisEvento_(ev, lancamentos);
      if (t.aReceber > 0) { r.aReceber += cent_(t.aReceber); r.eventosAReceber++; }
      if (ev.data >= hoje && ev.status === 'Confirmado') r.proximos++;
    });
  } catch (_) {}
  r.aReceber /= 100;
  return r;
}

function eventosBrasero(dados) {
  try {
    exigirSessao_(dados, SO_ADMIN_);
    const lancamentos = lerLancamentos_(), hoje = hojeIso_();
    const eventos = lerEventos_().map(ev => totaisEvento_(ev, lancamentos));
    // Próximos primeiro (data crescente), depois os passados (mais recentes antes).
    eventos.sort((a, b) => {
      const fa = a.data >= hoje, fb = b.data >= hoje;
      if (fa !== fb) return fa ? -1 : 1;
      return fa ? a.data.localeCompare(b.data) : b.data.localeCompare(a.data);
    });
    const resumo = {aReceber: 0, proximos: 0, valorTotal: 0, lucroPrevisto: 0, lucroMaisNmdo: 0, quantidade: 0};
    eventos.forEach(e => {
      if (e.status === 'Cancelado') return;
      resumo.aReceber += e.status === 'Orçamento' ? 0 : cent_(e.aReceber);
      if (e.status === 'Confirmado' && e.data >= hoje) resumo.proximos++;
      if (e.status === 'Orçamento') return;
      resumo.quantidade++;
      resumo.valorTotal += cent_(e.contratado);
      resumo.lucroPrevisto += cent_(e.lucroPrevisto);
      resumo.lucroMaisNmdo += cent_(e.lucroMaisNmdo);
    });
    ['aReceber', 'valorTotal', 'lucroPrevisto', 'lucroMaisNmdo'].forEach(k => resumo[k] /= 100);
    return {ok: true, hoje, eventos, resumo};
  } catch (e) { return retornoErro_(e); }
}

function eventoDetalheBrasero(dados) {
  try {
    exigirSessao_(dados, SO_ADMIN_);
    const ev = lerEventos_().find(e => e.id === String((dados || {}).id || ''));
    if (!ev) return falha_('NAO_ENCONTRADO', 'Evento não encontrado.');
    const lancamentos = lerLancamentos_();
    return {ok: true, evento: totaisEvento_(ev, lancamentos),
      lancamentos: lancamentos.filter(l => l.eventoId === ev.id).map(lancamentoPublico_)
        .sort((a, b) => b.data.localeCompare(a.data) || String(b.criadoEm).localeCompare(String(a.criadoEm)))};
  } catch (e) { return retornoErro_(e); }
}

function salvarEventoBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    const sessao = exigirSessao_(dados, SO_ADMIN_);
    const nome = textoCardapio_(dados.nome, 'Nome do evento', 100);
    const cliente = textoSeguro_(dados.cliente, 100);
    const telefone = textoSeguro_(String(dados.telefone || '').replace(/[^\d()+\s-]/g, ''), 30);
    const data = validarDataIso_(dados.data, 'Data do evento');
    const quantidade = Number(dados.pessoas);
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 100000)
      return falha_('QUANTIDADE', 'Informe a quantidade (pessoas ou espetinhos).');
    const tipo = TIPOS_EVENTO_.includes(dados.tipo) ? dados.tipo : '';
    if (!tipo) return falha_('TIPO', 'Escolha rodízio, por espetinho ou pacote fechado.');
    const valorTotal = valorFin_(dados.valorTotal);
    const valorUnitario = Math.round(valorTotal / quantidade * 100) / 100;
    const custoPrevisto = dados.custoPrevisto === '' || dados.custoPrevisto == null ? 0 : valorFin_(dados.custoPrevisto, true);
    const nmdo = dados.nmdo === '' || dados.nmdo == null ? 0 : valorFin_(dados.nmdo, true);
    if (custoPrevisto && nmdo > custoPrevisto) return falha_('NMDO', 'O NMDO faz parte do custo: não pode ser maior que o custo do serviço.');
    const pacote = textoSeguro_(dados.pacote, 40);
    const cortesia = textoSeguro_(dados.cortesia, 200);
    const status = STATUS_EVENTO_.includes(dados.status) ? dados.status : 'Orçamento';
    const observacao = textoSeguro_(dados.observacao, 500);
    const aba = brasero_('eventos'), quando = agora_();
    const extras = [pacote, custoPrevisto, nmdo, cortesia];
    if (dados.id) {
      const ev = lerEventos_().find(e => e.id === String(dados.id));
      if (!ev) return falha_('NAO_ENCONTRADO', 'Evento não encontrado.');
      aba.getRange(ev.linha, 2, 1, 10).setValues([[nome, cliente, telefone, data, quantidade, tipo, valorUnitario, valorTotal, status, observacao]]);
      aba.getRange(ev.linha, 14, 1, 5).setValues([[quando].concat(extras)]);
      return {ok: true, id: ev.id};
    }
    const id = novoId_('EVT');
    aba.appendRow([id, nome, cliente, telefone, data, quantidade, tipo, valorUnitario, valorTotal, status, observacao,
      sessao.nome, quando, quando].concat(extras));
    return {ok: true, id, novo: true};
  });
}
