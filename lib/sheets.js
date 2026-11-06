'use strict';
const fs = require('fs');
const {GoogleAuth} = require('google-auth-library');

function lerCredenciais() {
  let bruto = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!bruto && process.env.GOOGLE_APPLICATION_CREDENTIALS)
    bruto = fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
  if (!bruto) throw new Error('Defina GOOGLE_SERVICE_ACCOUNT_JSON (conteúdo do JSON da Service Account) ou GOOGLE_APPLICATION_CREDENTIALS.');
  bruto = bruto.trim();
  if (!bruto.startsWith('{')) bruto = Buffer.from(bruto, 'base64').toString('utf8');
  const cred = JSON.parse(bruto);
  if (cred.private_key) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return cred;
}

// Cliente mínimo da Sheets API v4 (interface usada pelo runtime: metadados, lerAbas, batchUpdate).
function criarClienteSheets(planilhaId, credenciais = lerCredenciais()) {
  const auth = new GoogleAuth({credentials: credenciais, scopes: ['https://www.googleapis.com/auth/spreadsheets']});
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(planilhaId);

  async function chamar(method, url, data) {
    const client = await auth.getClient();
    for (let tentativa = 0; ; tentativa++) {
      try {
        return (await client.request({method, url, data, timeout: 25000, retry: false})).data;
      } catch (e) {
        const status = e.response?.status;
        // POST só é repetido em 429 (garantido que não foi aplicado); GET também em 5xx.
        const repetir = status === 429 || (method === 'GET' && status >= 500);
        if (!repetir || tentativa >= 4) {
          const msg = e.response?.data?.error?.message || e.message;
          throw new Error('Google Sheets: ' + msg);
        }
        await new Promise(r => setTimeout(r, 500 * 2 ** tentativa + Math.random() * 300));
      }
    }
  }

  return {
    async metadados() {
      const d = await chamar('GET', base + '?fields=' + encodeURIComponent(
        'properties.timeZone,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'));
      return {timeZone: d.properties.timeZone, abas: d.sheets.map(s => ({
        sheetId: s.properties.sheetId, title: s.properties.title,
        rowCount: s.properties.gridProperties.rowCount, colCount: s.properties.gridProperties.columnCount}))};
    },
    async lerAbas(titulos) {
      const ranges = titulos.map(t => 'ranges=' + encodeURIComponent("'" + t.replace(/'/g, "''") + "'")).join('&');
      const d = await chamar('GET', base + '/values:batchGet?' + ranges +
        '&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING');
      return (d.valueRanges || []).map(v => v.values || []);
    },
    async batchUpdate(requests) {
      return chamar('POST', base + ':batchUpdate', {requests});
    }
  };
}

module.exports = {criarClienteSheets, lerCredenciais};
