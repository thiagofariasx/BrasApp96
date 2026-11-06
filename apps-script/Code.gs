const BRASERO_CONFIG = Object.freeze({
  PLANILHA_ID: '1zO1I7Us_9ZNjmHXJoIeN38ikDTNuFQ13-dBLYItPz9c',
  TIMEZONE: 'America/Fortaleza'
});

// V6: a página é um template para incluir a logo (arquivo Logo.html).
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Brasero 96 | Gestão')
    .addMetaTag('viewport', 'width=device-width,initial-scale=1,viewport-fit=cover');
}

function incluirLogo_() {
  try { return HtmlService.createHtmlOutputFromFile('Logo').getContent(); }
  catch (_) { return '<span class="marca-texto">BRASERO <b>96</b></span>'; }
}

let planilhaBraseroCache_;
function brasero_(nome) {
  const ss = planilhaBraseroCache_ || (planilhaBraseroCache_ = SpreadsheetApp.openById(BRASERO_CONFIG.PLANILHA_ID));
  const aba = ss.getSheetByName(nome);
  if (!aba) throw new Error('Aba não encontrada: ' + nome + '. Execute prepararEstruturaBraseroV6.');
  return aba;
}

function nomeMesa_(valor) {
  const nome = String(valor || '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (nome.length < 2 || nome.length > 80 || /^[=+@]/.test(nome))
    throw new Error('Informe uma mesa/cliente válido.');
  return nome;
}
function textoSeguro_(texto, limite) {
  const valor = String(texto ?? '').trim().slice(0, limite);
  return /^[=+@-]/.test(valor) ? "'" + valor : valor;
}
function dataIso_(valor) {
  const texto = String(valor || '');
  const data = /^\d{4}-\d{2}-\d{2}T/.test(texto) ? new Date(texto) : null;
  return data && Number.isFinite(data.getTime()) ? data.toISOString() : new Date().toISOString();
}

function dinheiro_(valor) {
  if (typeof valor === 'number') return valor;
  const texto = String(valor ?? '').replace(/R\$|\s/g, '');
  const comVirgula = texto.includes(',');
  const normal = comVirgula ? texto.replace(/\./g, '').replace(',', '.') : texto;
  const n = Number(normal);
  if (!Number.isFinite(n) || n < 0) throw new Error('Preço inválido no cardápio: ' + valor);
  return n;
}

function agora_() {
  return Utilities.formatDate(new Date(), BRASERO_CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm:ss');
}

function hojeIso_() {
  return Utilities.formatDate(new Date(), BRASERO_CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function rev_() {
  return new Date().toISOString() + '|' + Utilities.getUuid();
}

function retornoErro_(erro) {
  return { ok: false, code: erro.code || 'ERRO', mensagem: erro.message || String(erro) };
}

function falha_(code, mensagem, outros) {
  return Object.assign({ok: false, code, mensagem}, outros || {});
}

function comTrava_(operacao) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(6000)) return falha_('OCUPADO', 'Servidor ocupado. Tente novamente.');
  try { return operacao(); } catch (e) { if (!e.code) console.error(e); return retornoErro_(e); }
  finally { lock.releaseLock(); }
}

function linhas_(sheet, colunas) {
  const last = sheet.getLastRow();
  return last > 1 ? sheet.getRange(2, 1, last - 1, colunas).getValues() : [];
}

function localizarMesa_(sheet, nome) {
  const dados = linhas_(sheet, 8);
  const idx = dados.findIndex(r => String(r[0]).trim().toUpperCase() === nome);
  if (idx < 0) return null;
  const r = dados[idx];
  let itens = {}, observacoes = {};
  try { itens = JSON.parse(String(r[1] || '{}')); } catch (_) {}
  try { observacoes = JSON.parse(String(r[5] || '{}')); } catch (_) {}
  return {linha:idx + 2, clienteMesa:nome, itens, observacoes,
    revision:String(r[2] || ''), atendente:String(r[4] || 'Atendente'),
    criadoEm:String(r[6] || ''), atualizadoEm:String(r[7] || '')};
}
function menuBrasero(dados) {
  try {
    exigirSessao_(dados);
    return {ok:true, cardapio:linhas_(brasero_('cardapio'), 6)
      .filter(r => String(r[0]).trim())
      .map((r, i) => {
        const status = String(r[4] || 'Ativo').trim().toLowerCase();
        return {id:String(r[0]), nome:String(r[1] || ''), categoria:String(r[2] || 'Geral'),
          preco:dinheiro_(r[3]), ativo:status !== 'inativo' && status !== 'esgotado',
          esgotado:status === 'esgotado', ordem:Number(r[5]) || i + 1,
          revision:revisaoProduto_(r)};
      }).sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome,'pt-BR'))};
  } catch (e) {return retornoErro_(e);}
}
function rascunhosBrasero(dados) {
  try {
    exigirSessao_(dados);
    const linhas = linhas_(brasero_('rascunhos_abertos'), 8);
    return {ok:true, rascunhos:linhas.map(r => {
      if (!r[0]) return null;
      try {
        return {clienteMesa:String(r[0]), itens:JSON.parse(String(r[1] || '{}')),
          observacoes:JSON.parse(String(r[5] || '{}')), revision:String(r[2] || ''),
          atendente:String(r[4] || 'Atendente'), criadoEm:String(r[6] || ''),
          atualizadoEm:String(r[7] || '')};
      } catch (_) {
        try {return {clienteMesa:String(r[0]), itens:JSON.parse(String(r[1] || '{}')),
          observacoes:{}, revision:String(r[2] || ''), atendente:String(r[4] || 'Atendente'),
          criadoEm:String(r[6] || ''), atualizadoEm:String(r[7] || '')};} catch (_) {return null;}
      }
    }).filter(Boolean)};
  } catch (e) {return retornoErro_(e);}
}

function normalizarItens_(itens) {
  const obj = itens && typeof itens === 'object' && !Array.isArray(itens) ? itens : {};
  const saida = {};
  for (const id of Object.keys(obj)) {
    const qtd = Number(obj[id]);
    if (!/^[\w-]{1,60}$/.test(id) || !Number.isInteger(qtd) || qtd < 0 || qtd > 999) throw new Error('Quantidade inválida no pedido.');
    if (qtd) saida[id] = qtd;
  }
  if (Object.keys(saida).length > 150) throw new Error('Quantidade de produtos acima do limite.');
  return saida;
}

function normalizarObservacoes_(observacoes, itens) {
  const obj = observacoes && typeof observacoes === 'object' && !Array.isArray(observacoes) ? observacoes : {};
  const resultado = {};
  for (const [id, valor] of Object.entries(obj)) {
    if (!Object.prototype.hasOwnProperty.call(itens, id)) continue;
    const nota = String(valor ?? '').trim().replace(/\s+/g,' ');
    if (nota.length > 180) throw new Error('Observação do item excede 180 caracteres.');
    if (nota) resultado[id] = nota;
  }
  return resultado;
}
function salvarRascunhoBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    const sessao = exigirSessao_(dados);
    const nome = nomeMesa_(dados.clienteMesa), sheet = brasero_('rascunhos_abertos');
    const itens=normalizarItens_(dados.itens);
    const atual=localizarMesa_(sheet,nome), esperado=String(dados.revision||'');
    const observacoes=normalizarObservacoes_(dados.observacoes===undefined?atual?.observacoes:dados.observacoes,itens);
    if (atual && atual.revision !== esperado) {
      const servidorItens = normalizarItens_(atual.itens), servidorNotas = normalizarObservacoes_(atual.observacoes, servidorItens);
      if (JSON.stringify(servidorItens) === JSON.stringify(itens) &&
          JSON.stringify(servidorNotas) === JSON.stringify(observacoes))
        return {ok:true, revision:atual.revision, criadoEm:atual.criadoEm,
          atualizadoEm:atual.atualizadoEm, recuperado:true};
      return falha_('CONFLITO','A comanda foi alterada em outro aparelho.',{remoto:atual});
    }
    if (!atual && esperado) return falha_('REMOVIDA','A comanda não está mais aberta no servidor.');
    if (!Object.keys(itens).length && !dados.manterVazia) {
      if (atual) sheet.deleteRow(atual.linha);
      return {ok:true,revision:'',removido:true};
    }
    // V6: o atendente vem do login (quem abriu a comanda continua como responsável).
    const revision=rev_(), atualizadoEm=new Date().toISOString(),
      criadoEm=atual?.criadoEm || dataIso_(dados.criadoEm),
      atendente=textoSeguro_(atual?.atendente || sessao.nome,80);
    const valores=[nome,JSON.stringify(itens),revision,'Aberta',atendente,
      JSON.stringify(observacoes),criadoEm,atualizadoEm];
    if (atual) sheet.getRange(atual.linha,1,1,8).setValues([valores]);
    else sheet.appendRow(valores);
    return {ok:true,revision,criadoEm,atualizadoEm,atendente};
  });
}

function excluirRascunhoBrasero(dados) {
  return comTrava_(() => {
    dados = dados || {};
    exigirSessao_(dados);
    const nome = nomeMesa_(dados.clienteMesa), sheet = brasero_('rascunhos_abertos');
    const atual = localizarMesa_(sheet, nome), esperado = String(dados.revision || '');
    if (atual && atual.revision !== esperado)
      return falha_('CONFLITO', 'Outra pessoa atualizou essa comanda.', {remoto:atual});
    if (atual) sheet.deleteRow(atual.linha);
    return {ok:true};
  });
}

function totaliza_(itens, observacoes) {
  const mapa = new Map(menuBraseroDireto_().map(i => [i.id, i]));
  let qtd=0,totalCentavos=0;
  const itensValidos=normalizarItens_(itens), notas=normalizarObservacoes_(observacoes,itensValidos);
  const detalhamento=Object.entries(itensValidos).map(([id,quantidade]) => {
    const item=mapa.get(id);
    if (!item) throw new Error('Produto indisponível no cardápio: '+id);
    qtd+=quantidade;
    const subtotalCent=Math.round(quantidade*item.preco*100);
    totalCentavos+=subtotalCent;
    return {nome:item.nome,categoria:item.categoria,qtd:quantidade,
      preco:item.preco,subtotal:subtotalCent/100,observacao:notas[id]||''};
  });
  return {detalhamento,qtd,total:totalCentavos/100};
}
function menuBraseroDireto_() {
  return linhas_(brasero_('cardapio'), 5).filter(r => String(r[0]).trim()).map(r =>
    ({id:String(r[0]),nome:String(r[1] || ''),categoria:String(r[2] || 'Geral'),preco:dinheiro_(r[3])}));
}
const FORMAS_BRASERO_=['PIX','Cartão Crédito','Cartão Débito','Dinheiro'];
function centavosBrasero_(valor) {
  const n=Number(valor);
  if (!Number.isFinite(n) || n < 0 || Math.abs(n*100-Math.round(n*100))>0.00001)
    throw new Error('Valor de pagamento inválido.');
  return Math.round(n*100);
}
function pagamentosBrasero_(dados, subtotalCent) {
  const informado=Array.isArray(dados.pagamentos) && dados.pagamentos.length ? dados.pagamentos :
    [{forma:String(dados.formaPagamento||''),base:subtotalCent/100}];
  if (informado.length<1 || informado.length>4) throw new Error('Informe de uma a quatro formas de pagamento.');
  const vistos=new Set();let soma=0,taxaCent=0;
  const pagamentos=informado.map(p => {
    const forma=String(p.forma||'').trim();
    if (!FORMAS_BRASERO_.includes(forma) || vistos.has(forma)) throw new Error('Formas de pagamento inválidas ou repetidas.');
    vistos.add(forma);
    const baseCent=centavosBrasero_(p.base);
    if (!baseCent) throw new Error('Parcela de pagamento deve ser maior que zero.');
    soma+=baseCent;
    const acrescimo=forma==='Cartão Crédito'?Math.round(baseCent*0.05):0;
    taxaCent+=acrescimo;
    return {forma,base:baseCent/100,valor:(baseCent+acrescimo)/100};
  });
  if (soma!==subtotalCent) throw new Error('As parcelas não somam o valor dos produtos.');
  const formaPagamento=pagamentos.map(p=>p.forma).join(' + ');
  if (dados.formaPagamento && dados.formaPagamento!==formaPagamento &&
      !(dados.formaPagamento==='Misto' && pagamentos.length>1))
    throw new Error('Forma de pagamento incompatível com as parcelas.');
  return {pagamentos,taxaCent,formaPagamento,totalCent:subtotalCent+taxaCent};
}

function contarId_(sheet, id) {
  const ultima = sheet.getLastRow();
  if (ultima < 2) return 0;
  return sheet.getRange(2, 1, ultima - 1, 1).createTextFinder(id)
    .useRegularExpression(false).matchEntireCell(true).findAll().length;
}


function fecharComandaBrasero(dados) {
  return comTrava_(() => {
    dados=dados||{};
    const sessao=exigirSessao_(dados);
    const id=String(dados.idFechamento||'');
    if (!/^CMD-[\w-]{8,75}$/.test(id)) return falha_('ID_INVALIDO','Identificador de fechamento inválido.');
    const fechadas=brasero_('comandas_fechadas'), resumo=brasero_('resumo_fechamentos');
    if (contarId_(resumo,id)) {
      const nomeAntigo=nomeMesa_(dados.clienteMesa), abertos=brasero_('rascunhos_abertos');
      const antigo=localizarMesa_(abertos,nomeAntigo);
      if (antigo && antigo.revision===String(dados.revision||'')) abertos.deleteRow(antigo.linha);
      return {ok:true,idComanda:id,jaGravada:true};
    }
    const nome=nomeMesa_(dados.clienteMesa), sheet=brasero_('rascunhos_abertos');
    const atual=localizarMesa_(sheet,nome), esperado=String(dados.revision||'');
    if (!atual) return falha_('AGUARDE_SALVAR','Confirme o registro da comanda no servidor antes de fechar.');
    if (atual.revision!==esperado)
      return falha_('CONFLITO','Outra pessoa alterou essa comanda antes do fechamento.',{remoto:atual});
    const itens=dados.itens==null?atual?.itens:normalizarItens_(dados.itens);
    if (!itens) return falha_('REMOVIDA','Não há dados da comanda para fechar.');
    const {detalhamento,qtd,total}=totaliza_(itens,dados.observacoes??atual?.observacoes);
    if (!detalhamento.length) return falha_('SEM_ITENS','Adicione um produto antes de fechar.');
    let pagamento;
    try {pagamento=pagamentosBrasero_(dados,Math.round(total*100));}
    catch(e) {return falha_('PAGAMENTO_INVALIDO',e.message);}
    const {pagamentos,taxaCent,formaPagamento,totalCent}=pagamento;
    const informado=Number(dados.totalExibido);
    if (!Number.isFinite(informado) || Math.abs(informado-totalCent/100)>0.009)
      return falha_('PRECO_ALTERADO','O valor da comanda mudou. Confira os itens e as taxas antes de fechar.');
    const existentes=contarId_(fechadas,id);
    const quantidadeLinhas=detalhamento.length+(taxaCent>0?1:0);
    if (existentes && existentes!==quantidadeLinhas)
      return falha_('RECUPERACAO','Fechamento parcialmente gravado. Confira a aba comandas_fechadas antes de tentar novamente.');
    const dataHora=agora_(), atendente=textoSeguro_(atual?.atendente||sessao.nome,80);
    if (!existentes) {
      const linhas=detalhamento.map(item => [id,dataHora,nome,textoSeguro_(item.nome,100),
        textoSeguro_(item.categoria,60),item.qtd,item.preco,item.subtotal,formaPagamento,atendente,
        textoSeguro_(item.observacao,180)]);
      if (taxaCent>0) linhas.push([id,dataHora,nome,'Acréscimo cartão crédito (5%)',
        'Taxas',1,taxaCent/100,taxaCent/100,formaPagamento,atendente,'']);
      fechadas.getRange(fechadas.getLastRow()+1,1,linhas.length,11).setValues(linhas);
    }
    resumo.appendRow([id,dataHora,nome,qtd,totalCent/100,formaPagamento,
      textoSeguro_(dados.observacao,1000),atendente,JSON.stringify(pagamentos)]);
    const cache=CacheService.getScriptCache();
    cache.removeAll(['brasero_dia_v5_'+hojeIso_(),'brasero_top_v1','brasero_fin_vendas_v1']);
    if (atual) sheet.deleteRow(atual.linha);
    return {ok:true,idComanda:id,subtotal:total,acrescimo:taxaCent/100,total:totalCent/100,qtd,pagamentos};
  });
}

// Consulta uma única vez as datas de cada aba, lendo apenas as faixas com vendas no período.
function linhasDoPeriodoBrasero_(aba, inicio, fim, colunas) {
  const ultima=aba.getLastRow();
  if (ultima<2) return [];
  const datas=aba.getRange(2,2,ultima-1,1).getValues();
  const intervalos=[];
  for (let i=0;i<datas.length;i++) {
    const data=dataFechamento_(datas[i][0]).slice(0,10);
    const chave=/^\d{2}\/\d{2}\/\d{4}$/.test(data) ? data.slice(6)+'-'+data.slice(3,5)+'-'+data.slice(0,2) : '';
    if (chave<inicio||chave>fim) continue;
    const linha=i+2,anterior=intervalos[intervalos.length-1];
    if (anterior&&anterior[1]===linha-1) anterior[1]=linha;
    else intervalos.push([linha,linha]);
  }
  return intervalos.flatMap(([a,b])=>aba.getRange(a,1,b-a+1,colunas).getValues());
}
function validarPeriodoBrasero_(filtros) {
  const hoje=hojeIso_();
  const inicio=String(filtros.inicio||filtros.data||hoje),fim=String(filtros.fim||filtros.data||inicio);
  const validar=texto=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(texto))throw Error('Data inválida.');
    const [a,m,d]=texto.split('-').map(Number),data=new Date(Date.UTC(a,m-1,d));
    if(data.toISOString().slice(0,10)!==texto)throw Error('Data inválida.');
    return data;
  };
  const a=validar(inicio),b=validar(fim);
  if(a>b)throw Error('A data inicial deve ser anterior ou igual à final.');
  if((b-a)/86400000>89)throw Error('Selecione um período de até 90 dias.');
  return {inicio,fim};
}
function consolidarBrasero_(resumos,linhasItens) {
  const mapa=new Map();
  resumos.forEach(r=>{
    const id=String(r[0]||'').trim();
    if (!id || mapa.has(id)) return;
    let pagamentos=[];
    try {pagamentos=JSON.parse(String(r[8]||'[]'));}catch(_){}
    const total=dinheiro_(r[4]);
    if (!Array.isArray(pagamentos)||!pagamentos.length)
      pagamentos=[{forma:String(r[5]||'Não informado')==='Misto'?'Não discriminado (legado)':String(r[5]||'Não informado'),base:total,valor:total}];
    mapa.set(id,{id,dataHora:dataFechamento_(r[1]),clienteMesa:String(r[2]||''),
      qtd:Number(r[3])||0,total,pagamento:pagamentos.map(p=>p.forma).join(' + '),pagamentos,
      observacao:String(r[6]||''),atendente:String(r[7]||'Atendente'),
      itens:[],comResumo:true});
  });
  linhasItens.forEach(r=>{
    const id=String(r[0]||'').trim();if(!id)return;
    let c=mapa.get(id);
    if (!c) {
      c={id,dataHora:dataFechamento_(r[1]),clienteMesa:String(r[2]||''),
        qtd:0,total:0,pagamento:String(r[8]||''),observacao:'',
        atendente:String(r[9]||'Atendente'),pagamentos:[],itens:[],comResumo:false};
      mapa.set(id,c);
    }
    const qtd=Number(r[5])||0,preco=dinheiro_(r[6]);
    const subtotal=r[7]===''||r[7]==null?qtd*preco:dinheiro_(r[7]);
    c.itens.push({nome:String(r[3]||''),categoria:String(r[4]||''),
      qtd,preco,subtotal,observacao:String(r[10]||'')});
    if(!c.comResumo){if(String(r[4]||'')!=='Taxas')c.qtd+=qtd;c.total+=subtotal;}
  });
  const todas=[...mapa.values()].map(c=>{
    c.total=Math.round(c.total*100)/100;c.ordem=instanteFechamento_(c.dataHora);
    if(!c.pagamentos.length)c.pagamentos=[{forma:c.pagamento==='Misto'?'Não discriminado (legado)':c.pagamento||'Não informado',base:c.total,valor:c.total}];
    c.pagamento=c.pagamentos.map(p=>p.forma).join(' + ');
    delete c.comResumo;return c;
  }).sort((a,b)=>b.ordem-a.ordem||b.id.localeCompare(a.id));
  const porForma=new Map(),topProdutos=new Map(),porAtendente=new Map(),porDia=new Map();
  for(const c of todas){
    const d=c.dataHora.slice(0,10),dia=porDia.get(d)||{data:d,quantidade:0,centavos:0};
    dia.quantidade++;dia.centavos+=Math.round(c.total*100);porDia.set(d,dia);
    for(const p of c.pagamentos){
      const forma=String(p.forma||'Não informado'),valor=Number(p.valor)||0;
      porForma.set(forma,(porForma.get(forma)||0)+Math.round(valor*100));
    }
    const atendente=c.atendente||'Atendente', atual=porAtendente.get(atendente)||{nome:atendente,quantidade:0,centavos:0};
    atual.quantidade++;atual.centavos+=Math.round(c.total*100);porAtendente.set(atendente,atual);
    for(const i of c.itens){
      if(i.categoria==='Taxas'||String(i.nome).startsWith('Acréscimo cartão crédito'))continue;
      const chaveProduto=i.nome+'|'+i.categoria,t=topProdutos.get(chaveProduto)||{nome:i.nome,qtd:0,centavos:0};
      t.qtd+=i.qtd;t.centavos+=Math.round(i.subtotal*100);topProdutos.set(chaveProduto,t);
    }
  }
  const valorTotal=todas.reduce((s,c)=>s+Math.round(c.total*100),0)/100;
  const resultado={todas,quantidade:todas.length,totalPeriodo:valorTotal,
    ticketMedio:todas.length?Math.round(valorTotal*100/todas.length)/100:0,
    porForma:[...porForma].map(([forma,valor])=>({forma,total:valor/100})).sort((a,b)=>b.total-a.total),
    topProdutos:[...topProdutos.values()].map(x=>({nome:x.nome,qtd:x.qtd,total:x.centavos/100}))
      .sort((a,b)=>b.qtd-a.qtd),
    porAtendente:[...porAtendente.values()].map(x=>({nome:x.nome,quantidade:x.quantidade,total:x.centavos/100}))
      .sort((a,b)=>b.total-a.total),
    porDia:[...porDia.values()].map(x=>({data:x.data,quantidade:x.quantidade,total:x.centavos/100}))
      .sort((a,b)=>b.data.split('/').reverse().join('-').localeCompare(a.data.split('/').reverse().join('-')))};
  return resultado;
}
function historicoPeriodoBrasero_(inicio,fim) {
  const chave='brasero_periodo_v6_'+inicio+'_'+fim,cache=CacheService.getScriptCache();
  const salvo=cache.get(chave);
  if(salvo){try{return JSON.parse(salvo);}catch(_){}}
  const dados=consolidarBrasero_(
    linhasDoPeriodoBrasero_(brasero_('resumo_fechamentos'),inicio,fim,9),
    linhasDoPeriodoBrasero_(brasero_('comandas_fechadas'),inicio,fim,11));
  const json=JSON.stringify(dados);
  if(json.length<85000 && fim<hojeIso_())cache.put(chave,json,600);
  return dados;
}
function fechadasBrasero(filtros) {
  try {
    filtros=filtros||{};
    const sessao=exigirSessao_(filtros);
    // V6: atendente vê somente as vendas do dia.
    if (!sessao.admin) filtros={inicio:hojeIso_(),fim:hojeIso_(),pagina:filtros.pagina};
    const {inicio,fim}=validarPeriodoBrasero_(filtros);
    const pagina=Math.max(1,Math.min(9999,Math.floor(Number(filtros.pagina)||1)));
    const r=historicoPeriodoBrasero_(inicio,fim),porPagina=40;
    return {ok:true,inicio,fim,fechadas:r.todas.slice((pagina-1)*porPagina,pagina*porPagina),
      pagina,paginas:Math.max(1,Math.ceil(r.quantidade/porPagina)),quantidade:r.quantidade,
      totalPeriodo:r.totalPeriodo,ticketMedio:r.ticketMedio,porForma:r.porForma,
      topProdutos:r.topProdutos.slice(0,10),porAtendente:r.porAtendente,porDia:r.porDia};
  } catch(e){return retornoErro_(e);}
}
function relatorioCompletoBrasero(filtros) {
  try {
    exigirSessao_(filtros, SO_ADMIN_);
    const {inicio,fim}=validarPeriodoBrasero_(filtros||{});
    const r=historicoPeriodoBrasero_(inicio,fim);
    if(r.quantidade>1200)return falha_('RELATORIO_GRANDE','Há mais de 1.200 comandas. Divida o período para gerar PDFs menores.');
    return {ok:true,inicio,fim,...r,geradoEm:agora_()};
  }catch(e){return retornoErro_(e);}
}

// Ranking recalculado sob demanda; cache invalidado após cada venda.
function maisVendidosBrasero(dados) {
  try {
    exigirSessao_(dados);
    const cache = CacheService.getScriptCache();
    const salvo = cache.get('brasero_top_v1');
    if (salvo) return {ok:true, ids:JSON.parse(salvo)};
    const aba = brasero_('comandas_fechadas'), ultima = aba.getLastRow();
    const ranking = new Map();
    if (ultima > 1) {
      aba.getRange(2, 4, ultima - 1, 3).getValues().forEach(r => {
        const chave = String(r[0]).trim().toLowerCase() + '|' + String(r[1]).trim().toLowerCase();
        if (chave && !chave.startsWith('acréscimo cartão crédito'))
          ranking.set(chave, (ranking.get(chave) || 0) + (Number(r[2]) || 0));
      });
    }
    const ids = menuBraseroDireto_().map(p => ({id:p.id,
      qtd:ranking.get(p.nome.trim().toLowerCase() + '|' + p.categoria.trim().toLowerCase()) || 0}))
      .filter(p => p.qtd > 0).sort((a,b) => b.qtd - a.qtd).slice(0, 6).map(p => p.id);
    cache.put('brasero_top_v1', JSON.stringify(ids), 21600);
    return {ok:true, ids};
  } catch (e) {return retornoErro_(e);}
}

function dataFechamento_(valor) {
  if (valor instanceof Date) return Utilities.formatDate(valor,BRASERO_CONFIG.TIMEZONE,'dd/MM/yyyy HH:mm:ss');
  return String(valor || '').replace(/,\s*/, ' ').trim();
}

function instanteFechamento_(texto) {
  const m = String(texto).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  return m ? new Date(Number(m[3]),Number(m[2])-1,Number(m[1]),Number(m[4]||0),Number(m[5]||0),Number(m[6]||0)).getTime() : 0;
}


// Gestão do cardápio: V6 exige login de administrador (o PIN não é mais usado).
function revisaoProduto_(linha) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(linha.map(v => String(v ?? ''))));
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function textoCardapio_(valor, campo, limite) {
  const texto = String(valor ?? '').trim().replace(/\s+/g, ' ');
  if (!texto || texto.length > limite || /^[=+@]/.test(texto))
    throw erroBrasero_('CAMPO_INVALIDO', campo + ' inválido (máximo ' + limite + ' caracteres).');
  return texto;
}


function salvarProdutoBrasero(dados) {
  return comTrava_(() => {
    dados=dados||{};
    exigirSessao_(dados, SO_ADMIN_);
    const sheet=brasero_('cardapio'),nome=textoCardapio_(dados.nome,'Nome',100),
      categoria=textoCardapio_(dados.categoria,'Categoria',60),preco=Number(dados.preco);
    if(!Number.isFinite(preco)||preco<0||preco>99999.99||Math.abs(preco*100-Math.round(preco*100))>0.00001)
      return falha_('PRECO_INVALIDO','Informe um preço válido em reais com até duas casas decimais.');
    const status=String(dados.status|| (dados.ativo===false?'Inativo':'Ativo'));
    if(!['Ativo','Esgotado','Inativo'].includes(status))return falha_('STATUS_INVALIDO','Selecione o status do produto.');
    const id=String(dados.id||'').trim();
    if(id&&!/^[\w-]{1,60}$/.test(id))return falha_('ID_INVALIDO','ID inválido.');
    const rows=linhas_(sheet,6),idx=id?rows.findIndex(r=>String(r[0]).trim()===id):-1;
    const ordem=dados.ordem==null ? Number(idx>=0?(rows[idx][5]||idx+1):rows.length+1) : Number(dados.ordem);
    if(!Number.isInteger(ordem)||ordem<1||ordem>9999)
      return falha_('ORDEM_INVALIDA','Informe uma posição entre 1 e 9999.');
    if(id&&idx<0)return falha_('REMOVIDO','Produto removido. Atualize o cardápio.');
    if(id&&revisaoProduto_(rows[idx])!==String(dados.revision||''))
      return falha_('CONFLITO_CARDAPIO','Produto alterado em outro aparelho. Atualize antes de editar.');
    if(rows.some((r,i)=>i!==idx&&String(r[1]).trim().toLowerCase()===nome.toLowerCase()&&
       String(r[2]).trim().toLowerCase()===categoria.toLowerCase()))
      return falha_('DUPLICADO','Já existe um produto com esse nome nesta categoria.');
    if(id&&(String(rows[idx][1]).trim()!==nome||Math.abs(dinheiro_(rows[idx][3])-preco)>0.00001)){
      const utilizado=linhas_(brasero_('rascunhos_abertos'),2).some(r=>{
        try{return Number(JSON.parse(String(r[1]||'{}'))[id])>0;}catch(_){return false;}
      });
      if(utilizado)return falha_('EM_USO','Produto em uma comanda aberta. Aguarde o fechamento antes de mudar nome/preço.');
    }
    let produtoId=id;
    if(!produtoId){
      const maior=rows.reduce((n,r)=>Math.max(n,Number(String(r[0]).match(/^PRD-(\d+)$/i)?.[1])||0),0);
      if(maior>=999999)return falha_('LIMITE_ID','Limite de códigos atingido.');
      produtoId='PRD-'+String(maior+1).padStart(3,'0');
    }
    const linha=id?idx+2:sheet.getLastRow()+1;
    sheet.getRange(linha,1,1,6).setValues([[produtoId,nome,categoria,preco,status,ordem]]);
    sheet.getRange(linha,4).setNumberFormat('"R$" #,##0.00');
    CacheService.getScriptCache().remove('brasero_top_v1');
    return {ok:true,id:produtoId,novo:!id};
  });
}

// Executar UMA vez, em cópia de teste primeiro; só acrescenta cabeçalhos nas novas colunas.
function prepararEstruturaBraseroV5() {
  const campos={
    cardapio:{6:'Ordem_Exibicao'},
    rascunhos_abertos:{6:'Observacoes_JSON',7:'Criado_Em_ISO',8:'Atualizado_Em_ISO'},
    comandas_fechadas:{11:'Observacao_Item'},
    resumo_fechamentos:{9:'Pagamentos_JSON'}
  };
  const alteradas=[];
  for(const [nome, colunas] of Object.entries(campos)){
    const aba=brasero_(nome);
    for(const [col, titulo] of Object.entries(colunas)){
      const celula=aba.getRange(1,Number(col));
      const valor=String(celula.getValue()||'').trim();
      if(valor&&valor!==titulo)throw Error(`Cabeçalho já utilizado em ${nome}, coluna ${col}: ${valor}`);
      if(!valor){celula.setValue(titulo);alteradas.push(nome+': '+titulo);}
    }
  }
  return 'Estrutura V5 conferida. Cabeçalhos novos: '+(alteradas.join(', ')||'nenhum');
}
