// Prueba de `apps-script.gs` sin abrir Google: carga el backend en un `vm` con un
// SpreadsheetApp falso en memoria. Sin dependencias — el repo no tiene bundler ni
// package.json a propósito.
//
//   node test-apps-script.js
//
// Cubre ensureSheets(): que cree las 12 hojas con sus encabezados, que sea
// idempotente (una segunda corrida no duplica ni pisa datos) y que la acción
// "init" de doPost las reporte. Es la lógica que decide si una planilla nueva
// queda completa, y falla en silencio si se rompe: la app iría creando hojas
// a medida que se usa, con encabezados solo si acierta el camino de escritura.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const assert = require("assert");

const GS = process.argv[2] || path.join(__dirname, "apps-script.gs");

// ----- SpreadsheetApp falso (solo lo que este test ejercita) ---------------

function makeRange(sheet, row, col, nRows, nCols) {
  return {
    setValues(vals) {
      for (let r = 0; r < vals.length; r++) {
        const rr = row - 1 + r;
        sheet._rows[rr] = sheet._rows[rr] || [];
        for (let c = 0; c < vals[r].length; c++) sheet._rows[rr][col - 1 + c] = vals[r][c];
      }
      return this;
    },
    getValues() {
      const out = [];
      for (let r = 0; r < nRows; r++) {
        const src = sheet._rows[row - 1 + r] || [];
        const line = [];
        for (let c = 0; c < nCols; c++) line.push(src[col - 1 + c] == null ? "" : src[col - 1 + c]);
        out.push(line);
      }
      return out;
    },
    getValue() { return this.getValues()[0][0]; },
    setValue(v) { return this.setValues([[v]]); },
    clearContent() {
      for (let r = 0; r < nRows; r++) {
        const rr = row - 1 + r;
        if (!sheet._rows[rr]) continue;
        for (let c = 0; c < nCols; c++) sheet._rows[rr][col - 1 + c] = "";
      }
    },
  };
}

function makeSheet(name) {
  const sheet = {
    _rows: [],
    getName: () => name,
    getLastRow() {
      let last = 0;
      this._rows.forEach((r, i) => {
        if (r && r.some((c) => String(c == null ? "" : c).trim() !== "")) last = i + 1;
      });
      return last;
    },
    getRange(row, col, nRows, nCols) {
      return makeRange(sheet, row, col, nRows == null ? 1 : nRows, nCols == null ? 1 : nCols);
    },
    getDataRange() {
      const width = sheet._rows.reduce((w, r) => Math.max(w, (r || []).length), 0);
      return makeRange(sheet, 1, 1, Math.max(sheet.getLastRow(), 1), Math.max(width, 1));
    },
    appendRow(vals) { sheet._rows[sheet.getLastRow()] = vals.slice(); },
  };
  return sheet;
}

function makeSpreadsheet() {
  const sheets = [];
  return {
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    getSheets: () => sheets.slice(),
    insertSheet(n) { const s = makeSheet(n); sheets.push(s); return s; },
  };
}

const ss = makeSpreadsheet();
const sandbox = {
  SpreadsheetApp: { openById: () => ss, flush() {} },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: {
    MimeType: { JSON: "json" },
    createTextOutput(t) {
      const o = { setMimeType() { return o; }, getContent: () => t };
      return o;
    },
  },
  DriveApp: {}, Utilities: {}, MailApp: {}, Session: {},
  console,
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(GS, "utf8"), sandbox, { filename: path.basename(GS) });

// Nota: las `function` de nivel superior quedan como propiedades del contexto y
// se pueden invocar; los `const` (WEB_CFG, EMISSIONS_SHEET…) no — hay que
// llegar a ellos a través de funciones.

// ----- 1) primera corrida: las 12 hojas -----------------------------------

const res = sandbox.ensureSheets();
const HOJAS = [
  "Agua", "Combustible", "Config", "Config Sucursales", "Electricidad",
  "Emisiones", "Fill out", "Fotos", "Lecturas Medidor", "Medidores",
  "N° de cliente", "Precios Medidor",
];
assert.strictEqual(res.ok, true);
assert.deepStrictEqual(
  res.hojas.slice().sort(), HOJAS.slice().sort(),
  "hojas creadas != esperadas\n  got:  " + res.hojas.join(" | "),
);

// ----- 2) encabezados ------------------------------------------------------

const hdr = (n, len) => ss.getSheetByName(n).getRange(1, 1, 1, len).getValues()[0];
// La columna ID va al final de cada hoja de registros: K / L / M.
assert.strictEqual(hdr("Combustible", 11)[10], "ID", "Combustible: ID en K");
assert.strictEqual(hdr("Electricidad", 12)[11], "ID", "Electricidad: ID en L");
assert.strictEqual(hdr("Agua", 13)[12], "ID", "Agua: ID en M");
assert.deepStrictEqual(hdr("Config", 2), ["key", "value"]);
assert.strictEqual(hdr("Config Sucursales", 1)[0], "Sucursal ID");
assert.strictEqual(hdr("Emisiones", 3)[2], "Key");
assert.strictEqual(hdr("Fotos", 1)[0], "File ID");

// ----- 3) idempotente ------------------------------------------------------

ss.getSheetByName("Config").getRange(2, 1, 1, 2).setValues([["fotoNotifEmails", '["a@b.cl"]']]);
const res2 = sandbox.ensureSheets();
assert.strictEqual(res2.hojas.length, 12, "segunda corrida duplicó hojas: " + res2.hojas.join(" | "));
assert.deepStrictEqual(
  ss.getSheetByName("Config").getRange(2, 1, 1, 2).getValues()[0],
  ["fotoNotifEmails", '["a@b.cl"]'],
  "segunda corrida borró datos existentes",
);

// ----- 4) por la acción "init", como la llamaría un curl -------------------

const out = JSON.parse(
  sandbox.doPost({ postData: { contents: JSON.stringify({ action: "init" }) } }).getContent(),
);
assert.strictEqual(out.ok, true, "init no devolvió ok: " + JSON.stringify(out));
assert.strictEqual(out.hojas.length, 12, "init reportó " + out.hojas.length + " hojas");

console.log("OK — 12 hojas, encabezados correctos, idempotente, y action:init las reporta");
console.log("   " + res.hojas.join(" | "));
