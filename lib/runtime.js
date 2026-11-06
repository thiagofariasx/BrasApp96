'use strict';
// Executa os arquivos .gs originais no Node, emulando os serviços do Apps Script usados pelo projeto.
// Planilha: cada chamada roda sobre uma cópia em memória das abas (carregadas sob demanda) e as
// escritas viram UM batchUpdate atômico na Sheets API. Chamadas são serializadas (substitui o LockService).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const BLOQUEADAS = new Set(['doGet', 'prepararEstruturaBraseroV5', 'prepararEstruturaBraseroV6', 'emergenciaNovaSenhaAdmin']);
const FORMATO_DATA_HORA = 'dd/MM/yyyy HH:mm:ss';
const RE_DATA_BR = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const EPOCA_SHEETS = Date.UTC(1899, 11, 30);

class AbaNaoCarregada extends Error { constructor(m) { super(m); this.code = 'CARREGANDO'; } }

// ---------------- datas ----------------
function partesData(d, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'})
    .formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return p;
}
function formatarData(d, tz, padrao) {
  const p = partesData(d, tz);
  const mapa = {yyyy: p.year, yy: p.year.slice(-2), MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second};
  return String(padrao).replace(/yyyy|yy|MM|dd|HH|mm|ss/g, t => mapa[t]);
}
const dois = n => String(n).padStart(2, '0');
// "6/11/2026 9:05" → "06/11/2026 09:05:00" (como o Apps Script formataria a data lida da célula).
function normalizarDataBr(texto) {
  const m = RE_DATA_BR.exec(texto);
  if (!m || +m[2] > 12 || +m[1] > 31) return null;
  const data = `${dois(m[1])}/${dois(m[2])}/${m[3]}`;
  return m[4] == null ? data : `${data} ${dois(m[4])}:${m[5]}:${m[6] || '00'}`;
}
function serialDataBr(texto) {
  const m = RE_DATA_BR.exec(texto);
  return (Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - EPOCA_SHEETS) / 864e5;
}
const ehData = v => Object.prototype.toString.call(v) === '[object Date]';

// prepararEstruturaBraseroV6 grava BRASERO_FIN_INICIO = hoje na MESMA execução em que cria o primeiro usuário.
// Sem a variável no ambiente, usa a data de criação mais antiga da aba usuarios (mesmo valor do Apps Script).
function inicioFinanceiroPadrao(tx) {
  const w = tx.aba('usuarios');
  if (!w) return null;
  const datas = w.linhas.slice(1).map(l => /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(l[7] ?? '')))
    .filter(Boolean).map(m => `${m[3]}-${m[2]}-${m[1]}`).sort();
  return datas[0] || null;
}

// ---------------- bytes (Apps Script usa byte[] com sinal) ----------------
const paraBuffer = x => typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x);
const paraBytes = b => Array.from(b, x => (x > 127 ? x - 256 : x));

class Runtime {
  constructor({sheets, planilhaId, snapshotTtlMs = 2000, dirCodigo, padroes = {}}) {
    this.sheets = sheets;
    // Valores usados quando a propriedade não existe no ambiente (valor fixo ou função(tx)).
    this.padroes = {BRASERO_FIN_INICIO: inicioFinanceiroPadrao, ...padroes};
    this.planilhaId = planilhaId;
    this.ttl = snapshotTtlMs;
    this.meta = null; this.metaEm = 0;
    this.dados = new Map();      // título → {linhas, em}
    this.cache = new Map();      // CacheService
    this.props = new Map();      // PropertiesService (valores definidos em execução; env tem prioridade de leitura inicial)
    this.propsDefinidas = new Map();
    this.tx = null;
    this.fila = Promise.resolve();

    const dir = dirCodigo || path.join(__dirname, '..', 'apps-script');
    const arquivos = fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort();
    this.ctx = vm.createContext(this._globais());
    for (const f of arquivos) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), this.ctx, {filename: f});
    this.publicas = new Set(Object.keys(this.ctx).filter(n =>
      typeof this.ctx[n] === 'function' && !n.endsWith('_') && !BLOQUEADAS.has(n) && !(n in this._globaisNomes)));
    if (!this.planilhaId) this.planilhaId = vm.runInContext('BRASERO_CONFIG.PLANILHA_ID', this.ctx);
  }

  // Executa uma função .gs. Serializado: nenhuma outra chamada roda ao mesmo tempo.
  executar(nome, args = []) {
    const job = this.fila.then(() => this._executar(nome, args));
    this.fila = job.catch(() => {});
    return job;
  }

  async _executar(nome, args) {
    if (typeof this.ctx[nome] !== 'function') throw new Error('Função inexistente: ' + nome);
    if (!this.meta || Date.now() - this.metaEm > 300000) await this._carregarMeta();
    const agora = Date.now();
    for (const [t, d] of this.dados) if (agora - d.em > this.ttl) this.dados.delete(t);
    let metaRecarregada = false;
    for (let tentativa = 0; tentativa < 10; tentativa++) {
      const tx = this.tx = new Transacao(this);
      let resultado, erro;
      try { resultado = this.ctx[nome](...args); } catch (e) { erro = e; } finally { this.tx = null; }
      if (tx.precisaMeta && !metaRecarregada && Date.now() - this.metaEm > 10000) {
        metaRecarregada = true; await this._carregarMeta(); continue;
      }
      if (tx.faltando.size) { await this._carregarAbas([...tx.faltando]); continue; }
      if (tx.requests.length) {
        try { await this.sheets.batchUpdate(tx.requests); }
        catch (e) { this._invalidar(); throw e; }
      }
      tx.confirmar();
      if (erro) throw erro;
      return resultado;
    }
    throw new Error('Não foi possível carregar as abas da planilha.');
  }

  async _carregarMeta() {
    const m = await this.sheets.metadados();
    this.meta = {timeZone: m.timeZone, abas: new Map(m.abas.map(a => [a.title, a]))};
    this.metaEm = Date.now();
  }
  async _carregarAbas(titulos) {
    const valores = await this.sheets.lerAbas(titulos), em = Date.now();
    titulos.forEach((t, i) => this.dados.set(t, {em, linhas: (valores[i] || []).map(l => l.map(v =>
      typeof v === 'string' ? (normalizarDataBr(v) ?? v) : v))}));
  }
  _invalidar() { this.dados.clear(); this.meta = null; }

  // ---------------- globais emulados ----------------
  _globais() {
    const rt = this;
    const planilha = {
      getId: () => rt.planilhaId,
      getSpreadsheetTimeZone: () => rt.meta.timeZone,
      getSheetByName: nome => (rt._tx().aba(String(nome)) ? new Aba(rt, String(nome)) : null),
      insertSheet: nome => { rt._tx().inserirAba(String(nome)); return new Aba(rt, String(nome)); }
    };
    const cache = {
      get: k => rt._tx().cacheGet(String(k)),
      getAll: ks => Object.fromEntries(ks.map(k => [k, rt._tx().cacheGet(String(k))]).filter(([, v]) => v != null)),
      put: (k, v, s = 600) => rt._tx().cacheOps.push(['put', String(k), String(v), Math.min(+s || 600, 21600)]),
      remove: k => rt._tx().cacheOps.push(['del', String(k)]),
      removeAll: ks => ks.forEach(k => rt._tx().cacheOps.push(['del', String(k)]))
    };
    const props = {
      getProperty: k => rt._tx().propGet(String(k)),
      setProperty: (k, v) => { rt._tx().propsOps.set(String(k), String(v)); return props; }
    };
    const trava = {tryLock: () => true, waitLock: () => {}, releaseLock: () => {}, hasLock: () => true};
    const blob = dados => ({getBytes: () => paraBytes(paraBuffer(dados)), getDataAsString: () => paraBuffer(dados).toString('utf8')});
    const g = {
      console,
      SpreadsheetApp: {openById: () => planilha, getActiveSpreadsheet: () => planilha},
      CacheService: {getScriptCache: () => cache},
      PropertiesService: {getScriptProperties: () => props},
      LockService: {getScriptLock: () => trava},
      HtmlService: {
        createHtmlOutputFromFile: nome => ({getContent: () => fs.readFileSync(path.join(__dirname, '..', 'public', nome + '.html'), 'utf8')}),
        createTemplateFromFile: () => { throw new Error('HtmlService não é usado no servidor Node.'); }
      },
      Utilities: {
        DigestAlgorithm: {MD5: 'md5', SHA_1: 'sha1', SHA_256: 'sha256', SHA_384: 'sha384', SHA_512: 'sha512'},
        formatDate: (d, tz, p) => formatarData(d, tz, p),
        getUuid: () => crypto.randomUUID(),
        sleep: () => {},
        newBlob: blob,
        base64Encode: d => paraBuffer(d).toString('base64'),
        base64EncodeWebSafe: d => paraBuffer(d).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
        base64Decode: s => paraBytes(Buffer.from(String(s), 'base64')),
        base64DecodeWebSafe: s => paraBytes(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
        computeDigest: (alg, v) => paraBytes(crypto.createHash(alg).update(paraBuffer(v)).digest()),
        computeHmacSha256Signature: (v, k) => paraBytes(crypto.createHmac('sha256', paraBuffer(k)).update(paraBuffer(v)).digest())
      }
    };
    this._globaisNomes = Object.fromEntries(Object.keys(g).map(k => [k, 1]));
    return g;
  }
  _tx() {
    if (!this.tx) throw new Error('Serviço do Apps Script usado fora de uma execução.');
    return this.tx;
  }
}

// Estado de UMA tentativa de execução. Só é aplicado (confirmar) depois que o batchUpdate deu certo.
class Transacao {
  constructor(rt) {
    this.rt = rt; this.abas = new Map(); this.faltando = new Set(); this.requests = [];
    this.cacheOps = []; this.propsOps = new Map(); this.precisaMeta = false;
  }
  aba(titulo) {
    if (this.abas.has(titulo)) return this.abas.get(titulo);
    const meta = this.rt.meta.abas.get(titulo);
    if (!meta) { this.precisaMeta = true; return null; }
    const d = this.rt.dados.get(titulo);
    if (!d) { this.faltando.add(titulo); throw new AbaNaoCarregada('Carregando aba ' + titulo); }
    const w = {titulo, sheetId: meta.sheetId, rowCount: meta.rowCount, colCount: meta.colCount, linhas: d.linhas, em: d.em, copiada: false};
    this.abas.set(titulo, w);
    return w;
  }
  inserirAba(titulo) {
    if (this.rt.meta.abas.has(titulo) || this.abas.get(titulo)) throw new Error('Já existe uma aba chamada ' + titulo);
    const sheetId = crypto.randomInt(1e8, 2e9);
    this.requests.push({addSheet: {properties: {sheetId, title: titulo, gridProperties: {rowCount: 1000, columnCount: 26}}}});
    this.abas.set(titulo, {titulo, sheetId, rowCount: 1000, colCount: 26, linhas: [], em: Date.now(), copiada: true});
  }
  editavel(w) { if (!w.copiada) { w.linhas = w.linhas.map(l => l.slice()); w.copiada = true; } }
  garantirGrade(w, linhas, colunas) {
    if (linhas > w.rowCount) {
      this.requests.push({appendDimension: {sheetId: w.sheetId, dimension: 'ROWS', length: linhas - w.rowCount}});
      w.rowCount = linhas;
    }
    if (colunas > w.colCount) {
      this.requests.push({appendDimension: {sheetId: w.sheetId, dimension: 'COLUMNS', length: colunas - w.colCount}});
      w.colCount = colunas;
    }
  }
  intervalo(w, r, c, nr, nc) {
    return {sheetId: w.sheetId, startRowIndex: r - 1, endRowIndex: r - 1 + nr, startColumnIndex: c - 1, endColumnIndex: c - 1 + nc};
  }
  // Converte como o setValues do Apps Script: "'texto" vira texto puro e "dd/MM/yyyy HH:mm:ss" vira data.
  converter(v) {
    if (v === '' || v == null) return {ev: null, mem: ''};
    if (typeof v === 'number') return Number.isFinite(v) ? {ev: {numberValue: v}, mem: v} : {ev: {stringValue: String(v)}, mem: String(v)};
    if (typeof v === 'boolean') return {ev: {boolValue: v}, mem: v};
    if (ehData(v)) {
      const txt = formatarData(v, this.rt.meta.timeZone, FORMATO_DATA_HORA);
      return {ev: {numberValue: serialDataBr(txt)}, mem: txt, formato: FORMATO_DATA_HORA};
    }
    const s = String(v);
    if (s.startsWith("'")) return {ev: {stringValue: s.slice(1)}, mem: s.slice(1)};
    const data = normalizarDataBr(s);
    if (data && data === s) return {ev: {numberValue: serialDataBr(s)}, mem: s, formato: s.length > 10 ? FORMATO_DATA_HORA : 'dd/MM/yyyy'};
    return {ev: {stringValue: s}, mem: s};
  }
  escrever(w, r, c, matriz) {
    const nr = matriz.length, nc = matriz[0].length;
    this.editavel(w);
    this.garantirGrade(w, r + nr - 1, c + nc - 1);
    const conv = matriz.map(l => l.map(v => this.converter(v)));
    this.requests.push({updateCells: {range: this.intervalo(w, r, c, nr, nc), fields: 'userEnteredValue',
      rows: conv.map(l => ({values: l.map(x => (x.ev ? {userEnteredValue: x.ev} : {}))}))}});
    for (let j = 0; j < nc; j++) {
      for (let i = 0; i < nr; i++) {
        const f = conv[i][j].formato;
        if (!f) continue;
        let k = i;
        while (k + 1 < nr && conv[k + 1][j].formato === f) k++;
        this.requests.push({repeatCell: {range: this.intervalo(w, r + i, c + j, k - i + 1, 1),
          cell: {userEnteredFormat: {numberFormat: {type: f.length > 10 ? 'DATE_TIME' : 'DATE', pattern: f}}},
          fields: 'userEnteredFormat.numberFormat'}});
        i = k;
      }
    }
    while (w.linhas.length < r - 1 + nr) w.linhas.push([]);
    conv.forEach((l, i) => {
      const linha = w.linhas[r - 1 + i];
      while (linha.length < c - 1 + nc) linha.push('');
      l.forEach((x, j) => { linha[c - 1 + j] = x.mem; });
    });
  }
  formatar(w, r, c, nr, nc, cell, fields) {
    this.garantirGrade(w, r + nr - 1, c + nc - 1);
    this.requests.push({repeatCell: {range: this.intervalo(w, r, c, nr, nc), cell, fields}});
  }
  excluirLinha(w, r) {
    if (r < 1 || r > w.rowCount) throw new Error('Linha fora dos limites: ' + r);
    this.editavel(w);
    this.requests.push({deleteDimension: {range: {sheetId: w.sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r}}});
    if (r <= w.linhas.length) w.linhas.splice(r - 1, 1);
    w.rowCount--;
  }
  cacheGet(k) {
    for (let i = this.cacheOps.length - 1; i >= 0; i--)
      if (this.cacheOps[i][1] === k) return this.cacheOps[i][0] === 'put' ? this.cacheOps[i][2] : null;
    const e = this.rt.cache.get(k);
    if (!e) return null;
    if (e.exp < Date.now()) { this.rt.cache.delete(k); return null; }
    return e.v;
  }
  propGet(k) {
    if (this.propsOps.has(k)) return this.propsOps.get(k);
    if (this.rt.props.has(k)) return this.rt.props.get(k);
    if (process.env[k]) return process.env[k];
    const padrao = this.rt.padroes[k];
    return (typeof padrao === 'function' ? padrao(this) : padrao) ?? null;
  }
  confirmar() {
    const rt = this.rt;
    for (const w of this.abas.values()) {
      rt.meta.abas.set(w.titulo, {sheetId: w.sheetId, title: w.titulo, rowCount: w.rowCount, colCount: w.colCount});
      if (w.copiada) rt.dados.set(w.titulo, {linhas: w.linhas, em: w.em});
    }
    for (const [op, k, v, s] of this.cacheOps)
      op === 'put' ? rt.cache.set(k, {v, exp: Date.now() + s * 1000}) : rt.cache.delete(k);
    if (rt.cache.size > 5000) for (const [k, e] of rt.cache) if (e.exp < Date.now()) rt.cache.delete(k);
    for (const [k, v] of this.propsOps) { rt.props.set(k, v); rt.propsDefinidas.set(k, v); }
  }
}

class Aba {
  constructor(rt, titulo) { this.rt = rt; this.titulo = titulo; }
  get w() {
    const w = this.rt._tx().aba(this.titulo);
    if (!w) throw new Error('Aba removida: ' + this.titulo);
    return w;
  }
  getName() { return this.titulo; }
  getMaxRows() { return this.w.rowCount; }
  getMaxColumns() { return this.w.colCount; }
  getLastRow() {
    const l = this.w.linhas;
    let n = l.length;
    while (n > 0 && !l[n - 1].some(v => v !== '' && v != null)) n--;
    return n;
  }
  getLastColumn() { return this.w.linhas.reduce((m, l) => Math.max(m, l.length), 0); }
  getRange(r, c, nr = 1, nc = 1) {
    if (![r, c, nr, nc].every(Number.isInteger) || r < 1 || c < 1)
      throw new Error('Intervalo inválido.');
    if (nr < 1) throw new Error('O número de linhas no intervalo precisa ser pelo menos 1.');
    if (nc < 1) throw new Error('O número de colunas no intervalo precisa ser pelo menos 1.');
    return new Intervalo(this, r, c, nr, nc);
  }
  appendRow(valores) {
    this.getRange(this.getLastRow() + 1, 1, 1, valores.length).setValues([valores]);
    return this;
  }
  deleteRow(r) { this.rt._tx().excluirLinha(this.w, r); return this; }
  setFrozenRows(n) {
    this.rt._tx().requests.push({updateSheetProperties: {properties: {sheetId: this.w.sheetId, gridProperties: {frozenRowCount: n}},
      fields: 'gridProperties.frozenRowCount'}});
    return this;
  }
}

class Intervalo {
  constructor(aba, r, c, nr, nc) { Object.assign(this, {aba, r, c, nr, nc}); }
  getValues() {
    const l = this.aba.w.linhas, saida = [];
    for (let i = 0; i < this.nr; i++) {
      const linha = l[this.r - 1 + i] || [], out = [];
      for (let j = 0; j < this.nc; j++) { const v = linha[this.c - 1 + j]; out.push(v == null ? '' : v); }
      saida.push(out);
    }
    return saida;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(m) {
    if (!Array.isArray(m) || m.length !== this.nr || m.some(l => !Array.isArray(l) || l.length !== this.nc))
      throw new Error(`Os dados têm ${m.length} linhas, mas o intervalo tem ${this.nr} linhas x ${this.nc} colunas.`);
    this.aba.rt._tx().escrever(this.aba.w, this.r, this.c, m);
    return this;
  }
  setValue(v) { return this.aba.getRange(this.r, this.c).setValues([[v]]) && this; }
  setNumberFormat(f) {
    const nf = f === '@' ? {type: 'TEXT'} : {type: 'NUMBER', pattern: f};
    this.aba.rt._tx().formatar(this.aba.w, this.r, this.c, this.nr, this.nc, {userEnteredFormat: {numberFormat: nf}}, 'userEnteredFormat.numberFormat');
    return this;
  }
  setFontWeight(p) {
    this.aba.rt._tx().formatar(this.aba.w, this.r, this.c, this.nr, this.nc,
      {userEnteredFormat: {textFormat: {bold: p === 'bold'}}}, 'userEnteredFormat.textFormat.bold');
    return this;
  }
  createTextFinder(texto) {
    const opc = {inteira: false, caixa: false, regex: false}, self = this;
    const finder = {
      matchEntireCell(b) { opc.inteira = !!b; return finder; },
      matchCase(b) { opc.caixa = !!b; return finder; },
      useRegularExpression(b) { opc.regex = !!b; return finder; },
      findAll() {
        const alvo = opc.caixa ? String(texto) : String(texto).toLowerCase();
        const re = opc.regex ? new RegExp(opc.inteira ? '^(?:' + texto + ')$' : texto, opc.caixa ? '' : 'i') : null;
        const achados = [];
        self.getValues().forEach((l, i) => l.forEach((v, j) => {
          const s = opc.caixa ? String(v) : String(v).toLowerCase();
          if (re ? re.test(String(v)) : opc.inteira ? s === alvo : s.includes(alvo))
            achados.push(self.aba.getRange(self.r + i, self.c + j));
        }));
        return achados;
      }
    };
    return finder;
  }
}

module.exports = {Runtime, formatarData, normalizarDataBr, serialDataBr};
