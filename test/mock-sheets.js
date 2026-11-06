'use strict';
// Planilha falsa que imita a Sheets API (validação de limites, batchUpdate atômico, datas formatadas).
const {formatarData} = require('../lib/runtime');
const EPOCA = Date.UTC(1899, 11, 30);

function criarMock(abasIniciais, tz = 'America/Fortaleza') {
  let abas = abasIniciais.map((a, i) => ({sheetId: i + 1, title: a.title, rowCount: 1000, colCount: 26, frozen: 0,
    cells: (a.linhas || []).map(l => l.map(v => (v && v.serial != null ? {v: v.serial, fmt: {type: 'DATE_TIME', pattern: 'dd/MM/yyyy HH:mm:ss'}} : {v})))}));
  const stats = {leituras: 0, escritas: 0, requests: []};
  const clonar = x => JSON.parse(JSON.stringify(x));
  const porId = (estado, id) => { const a = estado.find(s => s.sheetId === id); if (!a) throw new Error('sheetId inexistente ' + id); return a; };
  const dentro = (a, r) => {
    if (r.startRowIndex < 0 || r.endRowIndex > a.rowCount || r.startColumnIndex < 0 || r.endColumnIndex > a.colCount)
      throw new Error(`Range exceeds grid limits (${a.title} ${JSON.stringify(r)} grid ${a.rowCount}x${a.colCount})`);
  };
  const celula = (a, i, j) => { a.cells[i] = a.cells[i] || []; return a.cells[i][j] = a.cells[i][j] || {}; };

  return {
    stats,
    get abas() { return abas; },
    async metadados() {
      return {timeZone: tz, abas: abas.map(a => ({sheetId: a.sheetId, title: a.title, rowCount: a.rowCount, colCount: a.colCount}))};
    },
    async lerAbas(titulos) {
      stats.leituras++;
      return titulos.map(t => {
        const a = abas.find(s => s.title === t);
        if (!a) throw new Error('Unable to parse range: ' + t);
        const linhas = a.cells.map(l => {
          const out = (l || []).map(c => {
            if (!c || c.v == null || c.v === '') return '';
            if (typeof c.v === 'number' && c.fmt && /DATE/.test(c.fmt.type))
              return formatarData(new Date(EPOCA + Math.round(c.v * 864e5)), 'UTC', c.fmt.pattern);
            return c.v;
          });
          while (out.length && out[out.length - 1] === '') out.pop();
          return out;
        });
        while (linhas.length && !linhas[linhas.length - 1].length) linhas.pop();
        return linhas;
      });
    },
    async batchUpdate(requests) {
      stats.escritas++; stats.requests.push(...requests);
      const e = clonar(abas);
      for (const req of requests) {
        const [tipo, p] = Object.entries(req)[0];
        if (tipo === 'updateCells') {
          const a = porId(e, p.range.sheetId); dentro(a, p.range);
          p.rows.forEach((row, i) => row.values.forEach((val, j) => {
            const c = celula(a, p.range.startRowIndex + i, p.range.startColumnIndex + j);
            const ev = val.userEnteredValue;
            c.v = ev ? (ev.numberValue ?? ev.stringValue ?? ev.boolValue) : '';
          }));
        } else if (tipo === 'repeatCell') {
          const a = porId(e, p.range.sheetId); dentro(a, p.range);
          for (let i = p.range.startRowIndex; i < p.range.endRowIndex; i++)
            for (let j = p.range.startColumnIndex; j < p.range.endColumnIndex; j++) {
              const nf = p.cell.userEnteredFormat?.numberFormat;
              if (nf) celula(a, i, j).fmt = nf;
            }
        } else if (tipo === 'deleteDimension') {
          const a = porId(e, p.range.sheetId);
          if (p.range.endIndex > a.rowCount) throw new Error('delete fora da grade');
          a.cells.splice(p.range.startIndex, p.range.endIndex - p.range.startIndex);
          a.rowCount -= p.range.endIndex - p.range.startIndex;
        } else if (tipo === 'appendDimension') {
          const a = porId(e, p.sheetId);
          if (p.dimension === 'ROWS') a.rowCount += p.length; else a.colCount += p.length;
        } else if (tipo === 'addSheet') {
          if (e.some(s => s.title === p.properties.title)) throw new Error('aba duplicada');
          e.push({sheetId: p.properties.sheetId, title: p.properties.title, rowCount: p.properties.gridProperties.rowCount,
            colCount: p.properties.gridProperties.columnCount, frozen: 0, cells: []});
        } else if (tipo === 'updateSheetProperties') {
          porId(e, p.properties.sheetId).frozen = p.properties.gridProperties.frozenRowCount;
        } else throw new Error('request não suportado: ' + tipo);
      }
      abas = e;
      return {};
    }
  };
}
module.exports = {criarMock};
