/**
 * Registro de Consumos — Apps Script backend
 *
 * Este script vive dentro del Google Spreadsheet y expone un endpoint HTTP
 * público que la app web usa para leer/escribir registros y subir archivos
 * a Drive. Permite que cualquier usuario use la app SIN iniciar sesión con
 * su cuenta Google: las operaciones se ejecutan con TU cuenta (la que
 * desplegó el script).
 *
 * --- CÓMO DESPLEGAR ---
 *
 * 1. Abre la planilla de destino (la de Level):
 *    https://docs.google.com/spreadsheets/d/1ERuuOcBr6cLdRrrlOxraR-KJLWj1zzVgxEsMROkh5Qo
 *
 * 2. Menú: Extensiones > Apps Script
 *
 * 3. Borra el contenido del archivo `Código.gs` y pega ESTE archivo completo.
 *
 * 4. Guarda (Ctrl+S). Pon un nombre al proyecto (ej: "Registro de Consumos API").
 *
 * 5. Botón "Implementar" (arriba a la derecha) > "Nueva implementación".
 *    - Tipo: "Aplicación web"
 *    - Descripción: lo que quieras
 *    - Ejecutar como: "Yo" (tu cuenta)
 *    - Quién tiene acceso: "Cualquier usuario"
 *    - Click "Implementar"
 *
 * 6. La primera vez te pedirá autorizar. Acepta los permisos
 *    (Sheets + Drive). Si aparece "Esta app no está verificada" haz click en
 *    "Avanzado" > "Ir a [nombre] (no seguro)" y continúa. Es seguro: es tu
 *    propio script con tu propia cuenta.
 *
 * 7. Copia la URL que aparece bajo "URL de la app web". Termina en /exec.
 *
 * 8. Pega esa URL en `proto/sync.jsx`, en la constante APPS_SCRIPT_URL.
 *
 * --- ACTUALIZACIONES ---
 *
 * Si modificas este script: Implementar > "Administrar implementaciones"
 * > edita la existente (ícono de lápiz) > Versión "Nueva versión" >
 * Implementar. La URL no cambia.
 */

// Versión del script desplegado. Subir en cada cambio; se devuelve en `ping`
// para verificar por curl qué versión corre en el /exec (evita pegar un
// archivo viejo). Snapshot congelado en appscripts/vN_fecha.gs.
const SCRIPT_VERSION = "v5";

// WEB_CFG en vez de CONFIG porque el procesador de Combustible (archivo Código.gs
// en el proyecto Apps Script) ya declara `var CONFIG`. Si usáramos el mismo nombre
// Apps Script lanza "Identifier 'CONFIG' has already been declared". Convivimos.
const WEB_CFG = {
  // 👉 ID de la planilla de Level (el tramo de la URL entre /d/ y /edit).
  SPREADSHEET_ID: "1ERuuOcBr6cLdRrrlOxraR-KJLWj1zzVgxEsMROkh5Qo",
  FOLDERS: {
    ENEL_POR_PROCESAR:  "",
    ENEL_PROCESADOS:    "",
    AGUAS_POR_PROCESAR: "",
    AGUAS_PROCESADOS:   "",
    // Deben coincidir con RC_CONFIG.FOLDERS en proto/sync.jsx.
    FOTOS_POR_COMPLETAR:"17_LKh2_KbegUz0iiYUdp-xnIW93K3n_U",
    FOTOS_PROCESADOS:   "14pqRjjXTABR64zVKGDNj3iW0Qyq7MJlF",
  },
  HEADERS: {
    // "ID" va AL FINAL a propósito: agregarla no corre ninguna columna, así
    // los índices que usan la app y los procesadores siguen siendo válidos.
    // Es la clave estable de cada registro: permite borrar, ordenar e insertar
    // filas a mano en la planilla sin que las ediciones de la app caigan en la
    // fila equivocada. La rellena ensureRecordIds() / appendRows().
    Combustible:    ["Link", "Fecha", "Consumo", "Costo", "Empresa", "Sucursal", "Tipo", "Proveedor", "Estado", "Origen", "ID"],
    Electricidad:   ["Link PDF", "Número de cliente", "Fecha", "Consumo total", "Costo ($)", "Empresa", "Sucursal", "Tipo de consumo", "Proveedor", "Estado", "Origen", "ID"],
    Agua:           ["Link PDF", "Número de cliente", "Fecha emisión", "Consumo total", "Costo ($)", "Empresa", "Sucursal", "Tipo de consumo", "Proveedor", "Subcategoría", "Estado", "Origen", "ID"],
    "N° de cliente":["Número de cliente", "Empresa", "Sucursal", "Tipo de consumo", "Proveedor"],
    "Fill out":     ["Submission ID", "Submission time", "Nombre Usuario", "Nombre sucursal", "Mes de registro", "N° trabajadores", "N° trabajadoras", "m2 totales", "% Avance", "URL Excel Petróleo", "URL Excel Gas", "Procesado"],
    // Flujo "Tomar foto" — una fila por foto subida; pendiente hasta que se completen datos.
    Fotos:          ["File ID", "Drive URL", "Fecha subida", "Tipo", "Sucursal", "Subcategoría", "Período", "Status", "Fecha completado", "Consumo", "Unidad", "Costo", "Proveedor", "Notas"],
    // Módulo Medidores (lecturas físicas).
    "Medidores":        ["ID", "Sucursal", "Tipo", "Nombre", "Número", "Activo", "Facturable"],
    "Lecturas Medidor": ["ID", "Medidor ID", "Período", "Lectura", "Factura Link", "Factura Nombre", "Factura File ID", "Pago Link", "Pago Nombre", "Pago File ID", "Respaldo Link", "Respaldo Nombre", "Respaldo File ID"],
    "Precios Medidor":  ["Sucursal", "Tipo", "Período", "Precio"],
  },
};

// ----- HTTP entrypoints --------------------------------------------------

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || "read";
    if (action === "read") return jsonOut(readAll());
    if (action === "getConfig") return jsonOut(getConfigValue(e.parameter.key));
    if (action === "getConfigSucursales") return jsonOut(getConfigSucursales());
    if (action === "getEmissions") return jsonOut(getEmissions());
    if (action === "getFotos") return jsonOut(getFotos());
    if (action === "getMedidores")       return jsonOut(getSheetRows("Medidores"));
    if (action === "getLecturasMedidor") return jsonOut(getSheetRows("Lecturas Medidor"));
    if (action === "getPreciosMedidor")  return jsonOut(getSheetRows("Precios Medidor"));
    // Solo lectura: reporta si la columna ID de cada hoja de registros está
    // libre. Útil para revisar ANTES de correr el backfill (ensureRecordIds).
    if (action === "inspectRecordIds") return jsonOut(inspectRecordIdColumns());
    if (action === "ping") return jsonOut({ ok: true, pong: new Date().toISOString(), version: SCRIPT_VERSION });
    return jsonOut({ error: "unknown action: " + action });
  } catch (err) {
    return jsonOut({ error: String(err && err.message || err) });
  }
}

// Serializa mutaciones al Spreadsheet. Apps Script corre ejecuciones en
// paralelo: sin lock, dos `append` simultáneos leen el mismo getLastRow() y se
// pisan. waitLock espera hasta 30s a que el otro termine.
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    const action = body.action;
    // --- Mutaciones al Sheet: bajo lock (serializadas) ---
    if (action === "setConfig") {
      withLock(function () { setConfigValue(body.key, body.value); });
      return jsonOut({ ok: true });
    }
    if (action === "upsertSucursal") {
      withLock(function () { upsertSucursal(body.id, body.rows || []); });
      return jsonOut({ ok: true });
    }
    if (action === "deleteSucursal") {
      withLock(function () { deleteSucursalRows(body.id); });
      return jsonOut({ ok: true });
    }
    // Upsert por clave: toca SOLO las filas enviadas. Las de otros usuarios
    // quedan intactas. Reemplaza a los antiguos set* (clear + rewrite total),
    // que borraban el trabajo de quien tuviera la app abierta en paralelo.
    if (action === "syncKeyed") {
      var res = withLock(function () {
        return syncKeyedRows(body.sheet, body.upserts || [], body.deletes || []);
      });
      return jsonOut({ ok: true, upserted: res.upserted, deleted: res.deleted });
    }
    if (action === "append") {
      withLock(function () { appendRows(body.sheet, body.values || []); });
      return jsonOut({ ok: true, appended: (body.values || []).length });
    }
    if (action === "update") {
      withLock(function () { updateCell(body.sheet, body.row, body.col, body.value); });
      return jsonOut({ ok: true });
    }
    // Edición por clave estable. Falla explícito si la fila ya no existe, en vez
    // de escribir en la que quedó en esa posición.
    if (action === "updateById") {
      var upd = withLock(function () {
        return updateCellById(body.sheet, body.id, body.col, body.value);
      });
      return jsonOut({ ok: true, row: upd.row });
    }
    if (action === "ensureRecordIds") {
      return jsonOut(withLock(function () { return ensureRecordIds(); }));
    }
    if (action === "init") {
      withLock(function () { ensureSheets(); });
      return jsonOut({ ok: true });
    }
    // --- Drive / mail: sin lock (cada archivo es independiente, no hay carrera) ---
    if (action === "upload") {
      return jsonOut(uploadFile(body.name, body.mimeType, body.base64, body.folderId, body.subfolders));
    }
    if (action === "move") {
      moveFile(body.fileId, body.fromFolderId, body.toFolderId);
      return jsonOut({ ok: true });
    }
    if (action === "deleteFile") {
      deleteFile(body.fileId);
      return jsonOut({ ok: true });
    }
    if (action === "notifyFotoPending") {
      return jsonOut(notifyFotoPending(body));
    }
    // setMedidores / setLecturasMedidor / setPreciosMedidor / setConfigSucursales
    // / setEmissions se eliminaron: hacían sheet.clear() + reescritura completa
    // desde el estado en memoria de UN cliente, borrando lo que otro usuario
    // hubiera guardado mientras tanto. Usar "syncKeyed".
    return jsonOut({ error: "unknown action: " + action });
  } catch (err) {
    return jsonOut({ error: String(err && err.message || err) });
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----- Operations --------------------------------------------------------

function readAll() {
  const ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  const result = {};
  ["Combustible", "Electricidad", "Agua"].forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) { result[name] = []; return; }
    result[name] = sheet.getDataRange().getDisplayValues();
  });
  return result;
}

function appendRows(sheetName, values) {
  if (!sheetName) throw new Error("sheet name missing");
  if (!values || !values.length) return;
  const ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    const headers = WEB_CFG.HEADERS[sheetName];
    if (headers) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  const start = sheet.getLastRow() + 1;
  // Las filas nuevas nacen con su ID: quedan editables desde la app en cuanto
  // el dashboard se recarga, sin esperar un ensureRecordIds().
  const idCol = RECORD_ID_COL[sheetName];
  const rows = values.map(function (r) { return r.slice(); });
  if (idCol) {
    rows.forEach(function (r, i) {
      while (r.length < idCol) r.push("");
      if (String(r[idCol - 1] || "").trim() === "") r[idCol - 1] = newRecordId(i);
    });
  }
  const width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
  rows.forEach(function (r) { while (r.length < width) r.push(""); });
  sheet.getRange(start, 1, rows.length, width).setValues(rows);
}

function updateCell(sheetName, row, col, value) {
  if (!sheetName) throw new Error("sheet name missing");
  if (!row || !col) throw new Error("row/col missing");
  const ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error("sheet not found: " + sheetName);
  sheet.getRange(row, col).setValue(value);
}

// ----- Registros: clave estable por fila ----------------------------------
// Hasta v4 la app editaba celdas por NÚMERO DE FILA, calculado desde la
// posición del registro en la lectura. Si alguien borraba u ordenaba filas a
// mano en la planilla, todos los clientes abiertos quedaban con los índices
// corridos y la siguiente edición escribía en la fila equivocada, en silencio.
// Ahora cada fila lleva un ID en la última columna y se edita por ese ID.

// Columnas ID que este script genera y rellena (ensureRecordIds).
var RECORD_ID_COL = {
  "Combustible":  11,
  "Electricidad": 12,
  "Agua":         13,
};

// Columna clave para ubicar una fila en updateCellById. Incluye hojas que ya
// traían una clave natural y por lo tanto no necesitan backfill: en "Fotos" el
// "File ID" de Drive es único por foto.
var KEY_COL = {
  "Combustible":  11,
  "Electricidad": 12,
  "Agua":         13,
  "Fotos":        1,
};

var __recIdSeq = 0;
function newRecordId(extra) {
  __recIdSeq++;
  return "r" + new Date().getTime().toString(36) + "_" + __recIdSeq +
    (extra != null ? "_" + extra : "") +
    Math.random().toString(36).slice(2, 6);
}

// Un ID generado por este script. Sirve para distinguir "la columna ya es de
// IDs" de "la columna tiene datos de otra cosa y no la podemos usar".
function _looksLikeRecordId(v) {
  return /^r[0-9a-z]+_\d+/.test(String(v == null ? "" : v).trim());
}

// Revisa, sin escribir nada, si la columna ID de cada hoja de registros está
// libre. Si alguien tenía datos propios en esa columna hay que moverlos antes:
// el backfill se niega a tocar esa hoja.
function inspectRecordIdColumns() {
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var out = {};
  Object.keys(RECORD_ID_COL).forEach(function (name) {
    var idCol = RECORD_ID_COL[name];
    var info = {
      columna: _colLetter(idCol),
      encabezado: "",
      filasConDatos: 0,
      ajenos: 0,
      muestras: [],
      libre: true,
    };
    out[name] = info;
    var sheet = ss.getSheetByName(name);
    if (!sheet) { info.existe = false; return; }
    info.existe = true;
    info.encabezado = String(sheet.getRange(1, idCol).getValue() || "").trim();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var v = String(ids[i][0] == null ? "" : ids[i][0]).trim();
      if (v === "") continue;
      info.filasConDatos++;
      if (_looksLikeRecordId(v)) continue;
      info.ajenos++;
      if (info.muestras.length < 3) info.muestras.push({ fila: i + 2, valor: v });
    }
    info.libre = info.ajenos === 0;
  });
  return { ok: true, columnas: out };
}

function _colLetter(n) {
  var s = "";
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Rellena los ID vacíos de las hojas de registros. Idempotente: si no hay
// huecos no escribe nada. Cubre las filas que existían antes de esta versión y
// las que agregues a mano en la planilla.
//
// Si la columna ID de una hoja tiene datos que NO son IDs generados por este
// script, esa hoja se salta por completo y se reporta en `bloqueadas`. Nunca
// sobreescribe contenido ajeno.
function ensureRecordIds() {
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var inspection = inspectRecordIdColumns().columnas;
  var filled = {};
  var blocked = {};
  Object.keys(RECORD_ID_COL).forEach(function (name) {
    filled[name] = 0;
    var info = inspection[name];
    if (!info || !info.existe) return;
    if (!info.libre) {
      blocked[name] = {
        columna: info.columna,
        ajenos: info.ajenos,
        muestras: info.muestras,
        motivo: "la columna " + info.columna + " de \"" + name + "\" tiene datos que no son IDs; muévelos antes",
      };
      return;
    }
    var sheet = ss.getSheetByName(name);
    var idCol = RECORD_ID_COL[name];
    var headers = WEB_CFG.HEADERS[name];

    // Encabezados en blanco: se rellenan desde WEB_CFG.HEADERS. Solo los
    // vacíos — un encabezado renombrado a mano se respeta. Ayuda a quien edita
    // la planilla directamente (p. ej. "Estado" de Electricidad estaba vacío).
    var hdr = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    var hdrChanged = false;
    for (var h = 0; h < headers.length; h++) {
      if (String(hdr[h] == null ? "" : hdr[h]).trim() === "") { hdr[h] = headers[h]; hdrChanged = true; }
    }
    if (hdrChanged) sheet.getRange(1, 1, 1, headers.length).setValues([hdr]);

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var range = sheet.getRange(2, idCol, lastRow - 1, 1);
    var ids = range.getValues();
    var changed = false;
    // Solo se rellenan filas con contenido real: las vacías se dejan como están
    // para no ensuciar la hoja con IDs sueltos.
    var body = sheet.getRange(2, 1, lastRow - 1, Math.max(idCol - 1, 1)).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || "").trim() !== "") continue;
      var hasContent = body[i].some(function (c) { return String(c == null ? "" : c).trim() !== ""; });
      if (!hasContent) continue;
      ids[i][0] = newRecordId(i);
      changed = true;
      filled[name]++;
    }
    if (changed) range.setValues(ids);
  });
  return { ok: true, filled: filled, blocked: blocked };
}

// Edita una celda ubicando la fila por su ID. Si el ID no está, NO escribe:
// lanza error para que la app avise en vez de corromper otra fila.
function updateCellById(sheetName, id, col, value) {
  if (!sheetName) throw new Error("sheet name missing");
  if (!id) throw new Error("record id missing");
  if (!col) throw new Error("col missing");
  var idCol = KEY_COL[sheetName];
  if (!idCol) throw new Error("hoja sin columna clave: " + sheetName);
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error("sheet not found: " + sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("registro no encontrado: " + id);
  var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(id).trim()) {
      sheet.getRange(i + 2, col).setValue(value);
      return { ok: true, row: i + 2 };
    }
  }
  throw new Error("registro no encontrado: " + id);
}

// `subfolders` (opcional): ruta de subcarpetas bajo folderId, ej ["Medidor 1 (N° 123)", "2026-07"].
// Se navegan por nombre y se crean las que falten (con lock para no duplicar
// carpetas en subidas concurrentes).
function uploadFile(name, mimeType, base64, folderId, subfolders) {
  if (!folderId) throw new Error("folderId missing");
  const bytes = Utilities.base64Decode(base64 || "");
  const blob = Utilities.newBlob(bytes, mimeType || "application/octet-stream", name || "archivo");
  let folder = DriveApp.getFolderById(folderId);
  const path = (subfolders || []).map(function (s) { return String(s || "").trim(); }).filter(String);
  if (path.length) {
    withLock(function () {
      path.forEach(function (nm) {
        const it = folder.getFoldersByName(nm);
        folder = it.hasNext() ? it.next() : folder.createFolder(nm);
      });
    });
  }
  const file = folder.createFile(blob);
  return { id: file.getId(), link: file.getUrl() };
}

function moveFile(fileId, fromFolderId, toFolderId) {
  const file = DriveApp.getFileById(fileId);
  if (toFolderId) DriveApp.getFolderById(toFolderId).addFile(file);
  if (fromFolderId) DriveApp.getFolderById(fromFolderId).removeFile(file);
}

// Envía un archivo a la papelera de Drive (recuperable 30 días por el dueño;
// desde la app la acción no tiene deshacer).
function deleteFile(fileId) {
  if (!fileId) throw new Error("fileId missing");
  DriveApp.getFileById(fileId).setTrashed(true);
}

function ensureSheets() {
  const ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  Object.keys(WEB_CFG.HEADERS).forEach(function (name) {
    if (!ss.getSheetByName(name)) {
      const sh = ss.insertSheet(name);
      const headers = WEB_CFG.HEADERS[name];
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  });
}

// ----- Config key/value store (hoja "Config") ----------------------------

function getConfigValue(key) {
  if (!key) return { value: null };
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName("Config");
  if (!sheet) return { value: null };
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      try { return { value: JSON.parse(data[i][1]) }; } catch (e) { return { value: null }; }
    }
  }
  return { value: null };
}

function setConfigValue(key, value) {
  if (!key) throw new Error("key missing");
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName("Config");
  if (!sheet) {
    sheet = ss.insertSheet("Config");
    sheet.getRange(1, 1, 1, 2).setValues([["key", "value"]]);
  }
  var data = sheet.getDataRange().getValues();
  var json = JSON.stringify(value);
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(json);
      return;
    }
  }
  sheet.appendRow([key, json]);
}

// ----- Config sucursales (tabla relacional, una fila por subcategoría) ----

var CONFIG_SUC_SHEET = "Config Sucursales";
var CONFIG_SUC_HEADERS = [
  "Sucursal ID", "Nombre", "Dirección", "Activa", "Tipo consumo", "Subcat ID",
  "Sistema eléctrico", "Tipo", "Tipo (otro)", "Uso", "Unidad",
  "Proveedor", "Proveedor (otro)", "N° cliente",
];

function getConfigSucursales() {
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG_SUC_SHEET);
  if (!sheet) return { rows: [] };
  var data = sheet.getDataRange().getValues();
  return { rows: data.slice(1) }; // sin encabezado
}

// ----- Primitivas de escritura sin clobber -------------------------------
// Regla: NUNCA sheet.clear(). Se lee el cuerpo, se modifica en memoria y se
// reescribe en un solo setValues. Las filas que el cliente no envía quedan
// exactamente como estaban, así dos personas con la app abierta no se pisan.

// Normaliza el ancho de una fila al del encabezado.
function _normWidth(row, width) {
  var out = (row || []).slice(0, width);
  while (out.length < width) out.push("");
  return out;
}

// Clave compuesta a partir de índices de columna (0-based).
function _rowKey(row, keyCols) {
  return keyCols.map(function (c) { return String(row[c] == null ? "" : row[c]).trim(); }).join("\u0000");
}

// Escribe el cuerpo (sin encabezado) y limpia solo el excedente si quedaron
// menos filas que antes. Nunca deja la hoja vacía en el intermedio.
function _writeBody(sheet, body, width, prevCount) {
  if (body.length) {
    sheet.getRange(2, 1, body.length, width).setValues(body);
  }
  var surplus = prevCount - body.length;
  if (surplus > 0) {
    sheet.getRange(2 + body.length, 1, surplus, width).clearContent();
  }
}

// Config de cada hoja sincronizable: columnas que forman la clave natural.
var KEYED_SHEETS = {
  "Emisiones":         [0, 1, 2],  // Scope | Sucursal ID | Key
  "Medidores":         [0],        // ID
  "Lecturas Medidor":  [1, 2],     // Medidor ID | Período
  "Precios Medidor":   [0, 1, 2],  // Sucursal | Tipo | Período
};

function _sheetWithHeaders(name) {
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  var headers = WEB_CFG.HEADERS[name] || (name === "Emisiones" ? EMISSIONS_HEADERS : null);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

// Upsert + delete por clave sobre una hoja. `upserts` son filas completas;
// `deletes` son arrays con solo los valores de las columnas clave.
function syncKeyedRows(name, upserts, deletes) {
  var keyCols = KEYED_SHEETS[name];
  if (!keyCols) throw new Error("hoja no sincronizable por clave: " + name);
  var sheet = _sheetWithHeaders(name);
  var headers = WEB_CFG.HEADERS[name] || EMISSIONS_HEADERS;
  var width = headers.length;
  var data = sheet.getDataRange().getValues();
  var body = data.length > 1 ? data.slice(1) : [];

  // Normaliza ancho y descarta filas totalmente vacías (residuo de clears viejos).
  body = body
    .map(function (r) { return _normWidth(r, width); })
    .filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
  var prevCount = Math.max(body.length, data.length - 1);

  var idx = {};
  for (var i = 0; i < body.length; i++) idx[_rowKey(body[i], keyCols)] = i;

  var deleted = 0;
  (deletes || []).forEach(function (keyVals) {
    var k = keyCols.map(function (_, j) {
      return String(keyVals[j] == null ? "" : keyVals[j]).trim();
    }).join("\u0000");
    if (idx[k] !== undefined) { body[idx[k]] = null; deleted++; }
  });
  if (deleted) {
    body = body.filter(function (r) { return r !== null; });
    idx = {};
    for (var j = 0; j < body.length; j++) idx[_rowKey(body[j], keyCols)] = j;
  }

  var upserted = 0;
  (upserts || []).forEach(function (row) {
    var norm = _normWidth(row, width);
    var k = _rowKey(norm, keyCols);
    if (idx[k] !== undefined) body[idx[k]] = norm;      // en su lugar, no salta
    else { body.push(norm); idx[k] = body.length - 1; }
    upserted++;
  });

  _writeBody(sheet, body, width, prevCount);
  return { upserted: upserted, deleted: deleted };
}

function _configSucSheet() {
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG_SUC_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG_SUC_SHEET);
    sheet.getRange(1, 1, 1, CONFIG_SUC_HEADERS.length).setValues([CONFIG_SUC_HEADERS]);
  }
  return sheet;
}

// Lee el cuerpo de "Config Sucursales" normalizado, sin encabezado ni filas
// vacías. Devuelve { body, prevCount } para reescribir con _writeBody.
function _configSucBody() {
  var sheet = _configSucSheet();
  var width = CONFIG_SUC_HEADERS.length;
  var data = sheet.getDataRange().getValues();
  var raw = data.length > 1 ? data.slice(1) : [];
  var body = raw
    .map(function (r) { return _normWidth(r, width); })
    .filter(function (r) { return String(r[0]).trim() !== ""; });
  return { sheet: sheet, width: width, body: body, prevCount: Math.max(raw.length, body.length) };
}

// Borra todas las filas de una sucursal (columna 1 === id).
// Reescribe el cuerpo completo en un setValues en vez de sheet.deleteRow():
// deleteRow desplaza filas y hace que la tabla "salte" para quien la mira.
function deleteSucursalRows(id) {
  if (!id) throw new Error("sucursal id missing");
  var c = _configSucBody();
  var kept = c.body.filter(function (r) { return String(r[0]) !== String(id); });
  _writeBody(c.sheet, kept, c.width, c.prevCount);
}

// Reemplaza SOLO las filas de una sucursal (por ID), sin tocar las demás y
// SIN moverlas de posición: las nuevas filas se escriben donde estaban las
// viejas. Antes era delete + append al final, y la sucursal desaparecía de su
// lugar para reaparecer abajo en cada guardado.
function upsertSucursal(id, rows) {
  if (!id) throw new Error("sucursal id missing");
  var c = _configSucBody();
  var at = -1;
  var kept = [];
  for (var i = 0; i < c.body.length; i++) {
    if (String(c.body[i][0]) === String(id)) {
      if (at < 0) at = kept.length;   // posición original del bloque
    } else {
      kept.push(c.body[i]);
    }
  }
  if (at < 0) at = kept.length;       // sucursal nueva → al final
  var incoming = (rows || []).map(function (r) { return _normWidth(r, c.width); });
  var out = kept.slice(0, at).concat(incoming, kept.slice(at));
  _writeBody(c.sheet, out, c.width, c.prevCount);
}

// ----- Factores de emisión (hoja "Emisiones") ----------------------------
// Una fila por entrada. Scopes: factor-empresa | factor-sucursal | refrigerante | meta-empresa | meta-sucursal.

var EMISSIONS_SHEET = "Emisiones";
var EMISSIONS_HEADERS = [
  "Scope", "Sucursal ID", "Key", "Value", "Pending Review", "Refrig Tipo", "Refrig Mes",
];

function getEmissions() {
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(EMISSIONS_SHEET);
  if (!sheet) return { rows: [] };
  var data = sheet.getDataRange().getValues();
  return { rows: data.slice(1) };
}

// setEmissions() se eliminó: hacía sheet.clear() + reescritura completa.
// Las emisiones ahora se guardan con syncKeyedRows("Emisiones", ...).

// Helper de autorización: forzar consent del scope MailApp.
// Correr desde el editor (Run ▶) — pide permiso la primera vez y manda
// un correo de prueba a tu propia cuenta.
function _authorizeMail() {
  var to = Session.getActiveUser().getEmail();
  MailApp.sendEmail({
    to: to,
    subject: "[Registro Consumos] Test autorización MailApp",
    body: "Si recibes esto, el scope MailApp quedó autorizado.",
  });
  return { ok: true, to: to, remaining: MailApp.getRemainingDailyQuota() };
}

// ----- Notificación cola Fotos -------------------------------------------
// Recibe { sucursal, tipo, periodo, link, total, fileName } y manda mail a
// los destinatarios configurados (key "fotoNotifEmails" en hoja Config).

function notifyFotoPending(body) {
  var cfg = getConfigValue("fotoNotifEmails");
  var emails = (cfg && Array.isArray(cfg.value)) ? cfg.value : [];
  emails = emails
    .map(function (e) { return String(e || "").trim(); })
    .filter(function (e) { return e && e.indexOf("@") !== -1; });
  if (!emails.length) return { ok: true, sent: 0, reason: "no recipients" };

  var sucursal = body.sucursal || "—";
  var tipo     = body.tipo     || "—";
  var periodo  = body.periodo  || "—";
  var link     = body.link     || "";
  var total    = body.total    != null ? body.total : "?";
  var fileName = body.fileName || "";

  var subject = "[Registro Consumos] Nueva foto pendiente · " + sucursal;
  var lines = [
    "Se subió una nueva foto al módulo Tomar foto. Queda pendiente de completar datos.",
    "",
    "Sucursal: " + sucursal,
    "Tipo: "     + tipo,
    "Período: "  + periodo,
    "Archivo: "  + (fileName || "—"),
    "Drive: "    + (link || "—"),
    "",
    "Total pendientes en cola: " + total,
    "",
    "Para completar los datos abre la app o edita la fila en la planilla.",
  ];
  var sent = 0;
  emails.forEach(function (to) {
    try {
      MailApp.sendEmail({ to: to, subject: subject, body: lines.join("\n") });
      sent++;
    } catch (e) {
      // continúa con los demás
    }
  });
  return { ok: true, sent: sent, recipients: emails.length };
}

// ----- Fotos (módulo "Tomar foto") --------------------------------------
// La hoja "Fotos" se crea automáticamente en el primer `append` usando
// WEB_CFG.HEADERS.Fotos. uploadFile / appendRows / updateCell / moveFile ya
// existen; sólo agregamos el getter de lectura de la cola.
function getFotos() {
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName("Fotos");
  if (!sheet) return { rows: [] };
  var data = sheet.getDataRange().getDisplayValues();
  return { rows: data.slice(1) };
}

// ----- Genérico: lectura de una hoja por nombre ------------------------------
// Usado por el módulo Medidores (hojas Medidores / Lecturas Medidor / Precios
// Medidor). getSheetRows devuelve las filas sin encabezado. Para escribir:
// syncKeyedRows(name, upserts, deletes) — ver KEYED_SHEETS.

function getSheetRows(name) {
  var ss = SpreadsheetApp.openById(WEB_CFG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) return { rows: [] };
  var data = sheet.getDataRange().getDisplayValues();
  return { rows: data.slice(1) };
}

// setSheetRows() se eliminó: hacía sheet.clear() + reescritura completa, y era
// la vía por la que un cliente con estado viejo borraba las lecturas/precios
// que otro acababa de guardar. Usar syncKeyedRows(name, upserts, deletes).
