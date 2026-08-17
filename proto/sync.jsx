// sync.jsx — Capa de integración con Google Sheets / Drive vía Apps Script.
// El acceso es PÚBLICO: la app no requiere login. Todas las operaciones se
// canalizan a través de un endpoint de Apps Script desplegado como "Aplicación
// web" con acceso "Cualquier usuario". Ese script corre con la cuenta del
// dueño y escribe en la planilla/Drive en su nombre.
//
// Para desplegar el backend ver `apps-script.gs` en la raíz del proyecto y
// pegar la URL resultante en APPS_SCRIPT_URL más abajo.

// === Instancia: LEVEL =====================================================
// Copia destinada a la empresa "Level". Backend des-asociado: reemplazar los
// placeholders PEGAR_*_LEVEL con los valores de la planilla / Apps Script /
// carpetas Drive de Level antes de desplegar a Pages.
//
// Mientras APPS_SCRIPT_URL no contenga "script.google.com" la app corre en modo
// local (sin sincronización a Sheets/Drive) — ver rcEndpointConfigured() abajo.
// Eso es a propósito: evita que esta copia escriba en la planilla de Base.
const RC_CONFIG = {
  // 👉 URL /exec del Apps Script desplegado sobre la planilla de Level.
  APPS_SCRIPT_URL: "PEGAR_APPS_SCRIPT_URL_LEVEL",

  // 👉 URL completa de la planilla de Level.
  SPREADSHEET_URL: "PEGAR_SPREADSHEET_URL_LEVEL",

  SHEETS: {
    COMBUSTIBLE: "Combustible",
    ELECTRICIDAD: "Electricidad",
    AGUA: "Agua",
    // Módulo Medidores (lecturas físicas).
    MED_MEDIDORES: "Medidores",
    MED_LECTURAS:  "Lecturas Medidor",
    MED_PRECIOS:   "Precios Medidor",
  },

  // 👉 Carpetas de Drive de Level. Las de Fotos y Medidores son obligatorias:
  // con un folderId vacío uploadFile lanza "folderId missing" (apps-script.gs).
  FOLDERS: {
    // Flujo "Tomar foto".
    FOTOS_POR_COMPLETAR: "PEGAR_FOTOS_POR_COMPLETAR_LEVEL",
    FOTOS_PROCESADOS:    "PEGAR_FOTOS_PROCESADOS_LEVEL",
    // Facturas adjuntas en registro manual.
    MANUAL_FACTURAS:     "PEGAR_MANUAL_FACTURAS_LEVEL",
    // Fallback para "Subir documento" cuando el proveedor no tiene folder propio.
    // Opcional: vacío hace caer todo a MANUAL_FACTURAS.
    UPLOAD_FACTURAS:     "",
    // Módulo Medidores — adjuntos por medidor/mes.
    MEDIDOR_FACTURAS:   "PEGAR_MEDIDOR_FACTURAS_LEVEL",
    MEDIDOR_PAGOS:      "PEGAR_MEDIDOR_PAGOS_LEVEL",
    // Fotos de respaldo de lecturas (registro móvil) — una carpeta por tipo.
    MEDIDOR_RESPALDOS: {
      agua:         "PEGAR_MEDIDOR_RESPALDO_AGUA_LEVEL",
      combustible:  "PEGAR_MEDIDOR_RESPALDO_COMBUSTIBLE_LEVEL",
      electricidad: "PEGAR_MEDIDOR_RESPALDO_ELECTRICIDAD_LEVEL",
    },
  },
  // Folders dedicados por proveedor para "Subir documento". Cada entrada:
  //   { porProcesar: "<id>", procesados: "<id>" }
  // Si una entrada falta o tiene IDs vacíos, ese proveedor usa MANUAL_FACTURAS /
  // UPLOAD_FACTURAS como fallback y NO mueve a "procesados".
  // Vacías por ahora: Level cae al fallback MANUAL_FACTURAS y no mueve nada a
  // "procesados". Llenar solo si Level quiere carpeta propia por proveedor.
  PROVIDER_FOLDERS: {
    "enel":            { porProcesar: "", procesados: "" },
    "cge":             { porProcesar: "", procesados: "" },
    "aguas-andinas":   { porProcesar: "", procesados: "" },
    "aguas-del-valle": { porProcesar: "", procesados: "" },
    "esval":           { porProcesar: "", procesados: "" },
    "iconstruye-pet":  { porProcesar: "", procesados: "" },
    "copec":           { porProcesar: "", procesados: "" },
    "shell":           { porProcesar: "", procesados: "" },
  },

  EMPRESA: "Level",
};

// ----- Endpoint helpers ---------------------------------------------------

function rcEndpointConfigured() {
  const u = RC_CONFIG.APPS_SCRIPT_URL;
  return typeof u === "string" && u.indexOf("script.google.com") !== -1;
}

async function rcApiGet(params) {
  const qs = Object.keys(params || {})
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
    .join("&");
  const url = RC_CONFIG.APPS_SCRIPT_URL + (qs ? "?" + qs : "");
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

// Apps Script GET-as-POST trick: usamos text/plain para evitar preflight CORS.
async function rcApiPost(body) {
  const r = await fetch(RC_CONFIG.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

// ----- Sincronización por clave (sin clobber entre usuarios) --------------
// Antes cada hoja se guardaba con clear + reescritura completa desde el estado
// en memoria de UN cliente: si otra persona tenía la app abierta y guardaba
// algo, la siguiente escritura de este cliente lo borraba sin aviso.
//
// Ahora se envían SOLO las filas que cambiaron respecto a la línea base (lo
// que realmente había en la hoja al leerla). Las filas de los demás no se
// tocan porque nunca viajan en el payload.
//
// Las columnas clave deben coincidir con KEYED_SHEETS en apps-script.gs.
const RC_KEYED = {
  "Emisiones":        [0, 1, 2],  // Scope | Sucursal ID | Key
  "Medidores":        [0],        // ID
  "Lecturas Medidor": [1, 2],     // Medidor ID | Período
  "Precios Medidor":  [0, 1, 2],  // Sucursal | Tipo | Período
};

const RC_SEP = "\u0000";   // separador imposible en un valor de celda

function rcRowKey(row, keyCols) {
  return keyCols.map((c) => String(row[c] == null ? "" : row[c]).trim()).join(RC_SEP);
}

// filas → Map(clave → fila).
function rcKeyRows(rows, keyCols) {
  const m = new Map();
  (rows || []).forEach((r) => m.set(rcRowKey(r, keyCols), r));
  return m;
}

// Línea base por hoja: lo que había en el Sheet la última vez que lo leímos o
// escribimos. Se arma con la MISMA función de aplanado que usa la escritura,
// así las diferencias de normalización del estado en memoria no producen
// escrituras espurias.
const RC_BASELINE = {};

function rcArmBaseline(sheet, rows) {
  RC_BASELINE[sheet] = rcKeyRows(rows, RC_KEYED[sheet] || [0]);
}

// Marca la hoja como "sin línea base": el próximo pase del effect la re-arma
// con el estado actual y no escribe nada. Se usa al recargar del Sheet.
function rcResetBaseline(sheet) { delete RC_BASELINE[sheet]; }

// Hojas con escritura pendiente. Bloquea el refresco automático para no
// descartar cambios locales que aún no llegaron al Sheet.
const RC_DIRTY = new Set();
function rcHasPendingWrites() { return RC_DIRTY.size > 0; }

// Diffea contra la línea base y envía solo altas/cambios/bajas. Devuelve
// { upserted, deleted } o null si no había nada que mandar.
async function rcSyncKeyedSheet(sheet, rows) {
  if (!rcEndpointConfigured()) return null;
  const keyCols = RC_KEYED[sheet];
  if (!keyCols) throw new Error("hoja no sincronizable por clave: " + sheet);
  const next = rcKeyRows(rows, keyCols);
  const prev = RC_BASELINE[sheet] || new Map();

  const upserts = [];
  next.forEach((row, k) => {
    const p = prev.get(k);
    if (p === undefined || JSON.stringify(p) !== JSON.stringify(row)) upserts.push(row);
  });
  const deletes = [];
  prev.forEach((row, k) => {
    if (!next.has(k)) deletes.push(keyCols.map((c) => row[c]));
  });

  if (!upserts.length && !deletes.length) {
    RC_BASELINE[sheet] = next;
    return null;
  }
  const res = await rcApiPost({ action: "syncKeyed", sheet, upserts, deletes });
  RC_BASELINE[sheet] = next;   // recién al confirmar: si falla, se reintenta
  return res;
}

// ----- Parsing utilities --------------------------------------------------

function rcParseDate(s) {
  if (s == null || s === "") return "";
  const str = String(s).trim();
  let m;
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;
  m = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;
  // DD-MM-YY (2 dígitos de año, usado por registros manuales)
  m = str.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
  if (m) return `20${m[3]}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;
  m = str.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`;
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = parseFloat(str);
    if (n > 25569 && n < 80000) {
      const ms = (n - 25569) * 86400000;
      const d = new Date(ms);
      return d.getUTCFullYear() + "-" +
        String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
        String(d.getUTCDate()).padStart(2, "0");
    }
  }
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }
  return str;
}
function rcCombSubcat(tipo) {
  const t = (tipo || "").toLowerCase();
  if (t.includes("petr")) return "diesel";
  if (t.includes("kerosene")) return "kerosene";
  if (t.includes("gas natural")) return "gas-natural";
  if (t.includes("gas") || t.includes("glp")) return "glp";
  return null;
}
// Map a human-readable agua subcat label (as stored in the Sheets column) back to a subcat id.
// Predefined: "Potable" → "potable", "Gris" → "gris", "Industrial" → "industrial".
// Anything else (custom tipos like "Riego") → "otro:<slug>" — matches getSubcatsFor().
function rcAguaSubcat(label) {
  if (!label) return null;
  const t = String(label).trim();
  if (!t) return null;
  const tl = t.toLowerCase();
  if (tl === "potable")    return "potable";
  if (tl === "gris")       return "gris";
  if (tl === "industrial") return "industrial";
  return "otro:" + tl.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}
function rcNum(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).replace(/\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(/,/g, ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ----- Config persistence (configSucursales ↔ "Config Sucursales" sheet) --
// Cada subcategoría es una fila; cada propiedad una columna. La app aplana al
// guardar y reconstruye la estructura anidada al leer.

const CONFIG_ITEM_TYPES = ["electricidad", "combustible", "agua", "refrigerantes"];

// configSucursales (anidado) → filas planas (sin encabezado).
function rcFlattenConfig(sucursales) {
  const rows = [];
  (sucursales || []).forEach((suc) => {
    let pushed = false;
    CONFIG_ITEM_TYPES.forEach((type) => {
      const item = suc.items && suc.items[type];
      if (!item || !item.activo) return;
      // Tipo activo SIN subcategorías: se escribe una fila con el tipo y el
      // resto vacío. Antes no se escribía nada y al recargar el tipo volvía
      // como inactivo — leer y escribir no daban el mismo resultado.
      if (!(item.subcats || []).length) {
        rows.push([
          suc.id, suc.nombre, suc.direccion || "", suc.activa ? "Sí" : "No",
          type, "", "", "", "", "", "", "", "", "",
        ]);
        pushed = true;
        return;
      }
      (item.subcats || []).forEach((sc) => {
        rows.push([
          suc.id, suc.nombre, suc.direccion || "", suc.activa ? "Sí" : "No",
          type, sc.id || "",
          sc.sistemaElectrico || "",
          sc.tipo || "",
          sc.tipoCustom || "",
          sc.uso || "",
          sc.unidad || "",
          sc.proveedor || "",
          sc.proveedorCustom || "",
          sc.numCliente || "",
        ]);
        pushed = true;
      });
    });
    // Sucursal sin subcats activas → fila base para que persista igual.
    if (!pushed) {
      rows.push([suc.id, suc.nombre, suc.direccion || "", suc.activa ? "Sí" : "No",
        "", "", "", "", "", "", "", "", "", ""]);
    }
  });
  return rows;
}

// Filas planas (sin encabezado) → configSucursales (anidado).
function rcUnflattenConfig(rows) {
  const byId = new Map();
  const order = [];
  (rows || []).forEach((r) => {
    const sucId = r[0];
    if (!sucId) return;
    if (!byId.has(sucId)) {
      byId.set(sucId, {
        id: sucId,
        nombre: r[1] || "",
        direccion: r[2] || "",
        activa: String(r[3]).trim().toLowerCase() !== "no",
        items: {
          electricidad:  { activo: false, subcats: [] },
          combustible:   { activo: false, subcats: [] },
          agua:          { activo: false, subcats: [] },
          refrigerantes: { activo: false, subcats: [] },
        },
      });
      order.push(sucId);
    }
    const type = r[4];
    if (!type) return; // fila base, sin subcat
    const item = byId.get(sucId).items[type];
    if (!item) return;
    item.activo = true;
    // Fila de "tipo activo sin subcategorías": marca el tipo como activo pero
    // no inventa una subcategoría vacía.
    const hasSubcatData = [5, 6, 7, 8, 9, 10, 11, 12, 13]
      .some((i) => String(r[i] == null ? "" : r[i]).trim() !== "");
    if (!hasSubcatData) return;
    const sc = { id: r[5] || ("sc" + item.subcats.length) };
    if (r[6])  sc.sistemaElectrico = r[6];
    if (r[7])  sc.tipo = r[7];
    if (r[8])  sc.tipoCustom = r[8];
    if (r[9])  sc.uso = r[9];
    if (r[10]) sc.unidad = r[10];
    if (r[11]) sc.proveedor = r[11];
    if (r[12]) sc.proveedorCustom = r[12];
    if (r[13]) sc.numCliente = r[13];
    item.subcats.push(sc);
  });
  return order.map((id) => byId.get(id));
}

async function rcReadConfigSucursales() {
  if (!rcEndpointConfigured()) return [];
  const data = await rcApiGet({ action: "getConfigSucursales" });
  return rcUnflattenConfig((data && data.rows) || []);
}

// rcWriteConfigSucursales() se eliminó: mandaba la lista completa a una acción
// que hacía clear + reescritura del Sheet. Cualquier pestaña con estado parcial
// borraba las sucursales de los demás. La acción tampoco existe ya en el
// backend. Se persiste por sucursal, con rcUpsertSucursal / rcDeleteSucursal.

// Inserta/actualiza SOLO una sucursal (por ID). No pisa las de otros usuarios.
async function rcUpsertSucursal(suc) {
  if (!rcEndpointConfigured() || !suc || !suc.id) return;
  await rcApiPost({ action: "upsertSucursal", id: suc.id, rows: rcFlattenConfig([suc]) });
}

// Borra una sucursal por ID.
async function rcDeleteSucursal(id) {
  if (!rcEndpointConfigured() || !id) return;
  await rcApiPost({ action: "deleteSucursal", id: id });
}

// ----- Persistencia de sucursales: se guarda en la ACCIÓN del usuario -------
// Antes StoreBridge observaba configSucursales y diffeaba contra una foto
// guardada en un ref. Esa foto se tomaba antes de que React aplicara el
// CONFIG/LOAD, así que salía vacía y CADA carga de la app concluía "todas las
// sucursales son nuevas" y reescribía la tabla entera sin que nadie tocara
// nada. Guardando en el punto donde el usuario confirma, una carga no puede
// disparar una escritura: cargar no es una acción de guardado.
//
// Llamar desde los componentes justo después de despachar la acción.
function rcSaveSucursal(suc) {
  if (!suc || !suc.id) return;
  RC_DIRTY.add("suc:" + suc.id);
  Promise.resolve(rcUpsertSucursal(suc))
    .then(() => console.log("[rc-sync] sucursal guardada", suc.id))
    .catch((e) => {
      console.error("[rc-sync] upsert suc failed", e);
      rcToast("error", "No se pudo guardar la sucursal", e && e.message);
    })
    .finally(() => RC_DIRTY.delete("suc:" + suc.id));
}

function rcRemoveSucursal(id) {
  if (!id) return;
  RC_DIRTY.add("suc:" + id);
  Promise.resolve(rcDeleteSucursal(id))
    .then(() => console.log("[rc-sync] sucursal borrada", id))
    .catch((e) => {
      console.error("[rc-sync] delete suc failed", e);
      rcToast("error", "No se pudo borrar la sucursal", e && e.message);
    })
    .finally(() => RC_DIRTY.delete("suc:" + id));
}

// Toast desde fuera de React (el store se expone en window.__rcStoreRef).
function rcToast(kind, title, body) {
  const { dispatch } = window.__rcStoreRef || {};
  if (dispatch) dispatch({ type: "TOAST/SHOW", toast: { kind, title, body: body || "" } });
}

// ----- Emisiones (hoja "Emisiones") -------------------------------------
// Scopes en columna 1:
//   factor-empresa  | ""    | key | value | "" | "" | ""
//   factor-sucursal | sucId | key | value | "Sí"/"No" pendingReview | "" | ""
//   refrigerante    | sucId | uid | cargaKg | "" | tipo | mes
//   meta-empresa    | ""    | absoluta|relativa|anioBase|baseEmissions | value | "" | "" | ""
//   meta-sucursal   | sucId | absoluta|relativa|anioBase|baseEmissions | value | "" | "" | ""

function rcFlattenEmissions(emissions) {
  const rows = [];
  const e = emissions || {};
  Object.entries(e.factoresEmpresa || {}).forEach(([k, v]) => {
    rows.push(["factor-empresa", "", k, v && v.value != null ? v.value : "", "", "", ""]);
  });
  Object.entries(e.factoresSucursal || {}).forEach(([sucId, byKey]) => {
    Object.entries(byKey || {}).forEach(([k, v]) => {
      rows.push([
        "factor-sucursal", sucId, k,
        v && v.value != null ? v.value : "",
        v && v.pendingReview ? "Sí" : "No",
        "", "",
      ]);
    });
  });
  Object.entries(e.refrigerantesSucursal || {}).forEach(([sucId, arr]) => {
    (arr || []).forEach(rf => {
      rows.push([
        "refrigerante", sucId,
        rf.uid || "",
        rf.cargaKg != null ? rf.cargaKg : "",
        "",
        rf.tipo || "",
        rf.mes || "",
      ]);
    });
  });
  const me = (e.metas && e.metas.empresa) || {};
  ["absoluta", "relativa", "anioBase", "baseEmissions", "baseMode"].forEach(k => {
    if (me[k] != null && me[k] !== "") rows.push(["meta-empresa", "", k, me[k], "", "", ""]);
  });
  Object.entries((e.metas && e.metas.sucursales) || {}).forEach(([sucId, m]) => {
    ["absoluta", "relativa", "anioBase", "baseEmissions", "baseMode"].forEach(k => {
      if (m && m[k] != null && m[k] !== "") rows.push(["meta-sucursal", sucId, k, m[k], "", "", ""]);
    });
  });
  return rows;
}

function rcUnflattenEmissions(rows) {
  const out = {
    factoresEmpresa: {},
    factoresSucursal: {},
    refrigerantesSucursal: {},
    metas: { empresa: {}, sucursales: {} },
  };
  (rows || []).forEach(r => {
    const scope = String(r[0] || "").trim();
    const sucId = String(r[1] || "").trim();
    const key   = String(r[2] || "").trim();
    const rawVal = r[3];
    if (scope === "factor-empresa" && key) {
      const n = parseFloat(rawVal);
      if (!isNaN(n)) out.factoresEmpresa[key] = { value: n };
    } else if (scope === "factor-sucursal" && key && sucId) {
      const n = parseFloat(rawVal);
      if (!isNaN(n)) {
        if (!out.factoresSucursal[sucId]) out.factoresSucursal[sucId] = {};
        const p = String(r[4] || "").trim().toLowerCase();
        out.factoresSucursal[sucId][key] = { value: n, pendingReview: p === "sí" || p === "si" };
      }
    } else if (scope === "refrigerante" && sucId) {
      if (!out.refrigerantesSucursal[sucId]) out.refrigerantesSucursal[sucId] = [];
      const carga = parseFloat(rawVal);
      out.refrigerantesSucursal[sucId].push({
        uid: key || "",
        tipo: String(r[5] || "").trim(),
        cargaKg: isNaN(carga) ? 0 : carga,
        mes: String(r[6] || "").trim(),
      });
    } else if (scope === "meta-empresa" && key) {
      const n = parseFloat(rawVal);
      out.metas.empresa[key] = isNaN(n) ? rawVal : n;
    } else if (scope === "meta-sucursal" && key && sucId) {
      if (!out.metas.sucursales[sucId]) out.metas.sucursales[sucId] = {};
      const n = parseFloat(rawVal);
      out.metas.sucursales[sucId][key] = isNaN(n) ? rawVal : n;
    }
  });
  return out;
}

function rcEmissionsHasContent(em) {
  if (!em) return false;
  if (Object.keys(em.factoresEmpresa || {}).length > 0) return true;
  if (Object.keys(em.factoresSucursal || {}).length > 0) return true;
  if (Object.keys(em.refrigerantesSucursal || {}).length > 0) return true;
  if (em.metas && Object.keys(em.metas.empresa || {}).length > 0) return true;
  if (em.metas && Object.keys(em.metas.sucursales || {}).length > 0) return true;
  return false;
}

async function rcReadEmissions() {
  if (!rcEndpointConfigured()) return null;
  const data = await rcApiGet({ action: "getEmissions" });
  const rows = (data && data.rows) || [];
  if (!rows.length) return null;
  return rcUnflattenEmissions(rows);
}

// Guarda solo los factores/metas/refrigerantes que cambiaron. Lo que otro
// usuario haya guardado en paralelo no viaja en el payload → no se pisa.
async function rcWriteEmissions(emissions) {
  if (!rcEndpointConfigured()) return;
  return await rcSyncKeyedSheet("Emisiones", rcFlattenEmissions(emissions));
}

// ----- Medidores (hojas "Medidores" / "Lecturas Medidor" / "Precios Medidor") --
// Mismo patrón clear+rewrite que emisiones/config. Los documentos (Factura/Pago)
// viajan dentro de las filas de lecturas: una fila por (medidor, mes) con lectura
// y/o links de Drive.

// Medidores: [id, sucursal, tipo, nombre, numero, activo, facturable]
// Facturable vacío = "Sí" (medidores creados antes de esta columna).
function rcFlattenMedidores(meters) {
  return (meters || []).map(m => [
    m.id, m.sucursal || "", m.type || "", m.nombre || "", m.numero || "", m.activo ? "Sí" : "No",
    m.facturable === false ? "No" : "Sí",
  ]);
}
function rcUnflattenMedidores(rows) {
  return (rows || []).filter(r => r[0]).map(r => ({
    id: r[0],
    sucursal: r[1] || "",
    type: r[2] || "",
    nombre: r[3] || "",
    numero: r[4] != null ? String(r[4]) : "",
    activo: String(r[5]).trim().toLowerCase() !== "no",
    facturable: String(r[6] == null ? "" : r[6]).trim().toLowerCase() !== "no",
  }));
}

// Lecturas + docs: [id, meterId, periodo, lectura, facturaLink, facturaNombre,
//                   facturaFileId, pagoLink, pagoNombre, pagoFileId,
//                   respaldoLink, respaldoNombre, respaldoFileId]
function rcFlattenMedLecturas(readings, docs) {
  const map = new Map();
  (readings || []).forEach(r => {
    map.set(r.meterId + "__" + r.month, { id: r.id || "", meterId: r.meterId, month: r.month, lectura: r.lectura });
  });
  Object.entries(docs || {}).forEach(([key, d]) => {
    const i = key.indexOf("__");
    const meterId = key.slice(0, i), month = key.slice(i + 2);
    const cur = map.get(key) || { id: "", meterId, month, lectura: "" };
    cur.factura  = (d && d.factura) || null;
    cur.pago     = (d && d.pago) || null;
    cur.respaldo = (d && d.respaldo) || null;
    map.set(key, cur);
  });
  return [...map.values()].map(r => [
    r.id || "", r.meterId, r.month, (r.lectura == null ? "" : r.lectura),
    r.factura ? (r.factura.link || "") : "", r.factura ? (r.factura.name || "") : "", r.factura ? (r.factura.fileId || "") : "",
    r.pago ? (r.pago.link || "") : "", r.pago ? (r.pago.name || "") : "", r.pago ? (r.pago.fileId || "") : "",
    r.respaldo ? (r.respaldo.link || "") : "", r.respaldo ? (r.respaldo.name || "") : "", r.respaldo ? (r.respaldo.fileId || "") : "",
  ]);
}
function rcUnflattenMedLecturas(rows) {
  const readings = [];
  const docs = {};
  (rows || []).forEach(r => {
    const id = r[0] || "", meterId = r[1] || "", month = r[2] || "";
    if (!meterId || !month) return;
    // El Sheet devuelve display values (decimal con coma, ej "15771,848").
    // rcNum normaliza coma/miles → número. Solo omitimos celdas vacías.
    const lectura = r[3];
    if (lectura !== "" && lectura != null) {
      readings.push({ id: id || ("lec_" + meterId + "_" + month), meterId, month, lectura: rcNum(lectura) });
    }
    const fLink = r[4] || "", fName = r[5] || "", fId = r[6] || "";
    const pLink = r[7] || "", pName = r[8] || "", pId = r[9] || "";
    const rLink = r[10] || "", rName = r[11] || "", rId = r[12] || "";
    if (fLink || pLink || rLink) {
      const key = meterId + "__" + month;
      docs[key] = {};
      if (fLink) docs[key].factura  = { link: fLink, name: fName, fileId: fId };
      if (pLink) docs[key].pago     = { link: pLink, name: pName, fileId: pId };
      if (rLink) docs[key].respaldo = { link: rLink, name: rName, fileId: rId };
    }
  });
  return { readings, docs };
}

// Precios: [sucursal, tipo, periodo, precio]
function rcFlattenMedPrecios(prices) {
  return (prices || []).map(p => [p.sucursal || "", p.type || "", p.month || "", p.precio]);
}
function rcUnflattenMedPrecios(rows) {
  return (rows || []).filter(r => r[0] && r[2]).map(r => ({
    sucursal: r[0], type: r[1] || "", month: r[2], precio: rcNum(r[3]),
  }));
}

async function rcReadMedidores() {
  if (!rcEndpointConfigured()) return null;
  const [med, lec, pre] = await Promise.all([
    rcApiGet({ action: "getMedidores" }),
    rcApiGet({ action: "getLecturasMedidor" }),
    rcApiGet({ action: "getPreciosMedidor" }),
  ]);
  const meters = rcUnflattenMedidores((med && med.rows) || []);
  const { readings, docs } = rcUnflattenMedLecturas((lec && lec.rows) || []);
  const prices = rcUnflattenMedPrecios((pre && pre.rows) || []);
  return { meters, readings, prices, docs };
}

// Igual que emisiones: diff por clave sobre las tres hojas. Un cliente con
// estado viejo ya no puede borrar las lecturas que otro acaba de registrar.
async function rcWriteMedidores(M) {
  if (!rcEndpointConfigured()) return;
  await rcSyncKeyedSheet("Medidores",        rcFlattenMedidores(M.meters));
  await rcSyncKeyedSheet("Lecturas Medidor", rcFlattenMedLecturas(M.readings, M.docs));
  await rcSyncKeyedSheet("Precios Medidor",  rcFlattenMedPrecios(M.prices));
}

// Sube un documento (Factura/Pago/Respaldo) de medidor a su carpeta Drive. Sin
// backend configurado cae a un objectURL local para no romper el flujo en pruebas.
// `meter`/`month` solo se usan para respaldos: carpeta raíz por tipo de consumo
// y adentro subcarpetas <medidor>/<mes> creadas automáticamente por el Apps Script.
async function rcUploadMedidorDoc(file, kind, meter, month) {
  const type = meter && meter.type;
  const folder = kind === "pago" ? RC_CONFIG.FOLDERS.MEDIDOR_PAGOS
    : kind === "respaldo" ? (RC_CONFIG.FOLDERS.MEDIDOR_RESPALDOS || {})[type] || ""
    : RC_CONFIG.FOLDERS.MEDIDOR_FACTURAS;
  if (!rcEndpointConfigured() || !folder) {
    return { id: "", link: URL.createObjectURL(file), name: file.name, local: true };
  }
  let subfolders = [];
  if (kind === "respaldo" && meter) {
    const meterName = ((meter.nombre || "Medidor") + (meter.numero ? " (N° " + meter.numero + ")" : ""))
      .replace(/[\/\\]/g, "-").trim();
    subfolders = [meterName, month || ""].filter(Boolean);
  }
  const base64 = await rcFileToBase64(file);
  const up = await rcApiPost({
    action: "upload",
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    base64,
    folderId: folder,
    subfolders,
  });
  return { id: up.id, link: up.link, name: file.name };
}

// Envía a la papelera de Drive el archivo de un doc de medidor. Sin backend
// o sin fileId (doc local de prueba) no hace nada.
async function rcDeleteMedidorDoc(fileId) {
  if (!rcEndpointConfigured() || !fileId) return;
  await rcApiPost({ action: "deleteFile", fileId });
}

// ----- Read all records ---------------------------------------------------

// Clave estable de la fila, leída de la columna "ID" (la última de cada hoja
// de registros). Antes el id era el índice de la fila en la lectura, así que
// borrar u ordenar filas a mano en la planilla desalineaba a todos los
// clientes abiertos y la siguiente edición caía en la fila equivocada.
//
// Sin ID (fila agregada a mano, o hoja anterior a v5 sin backfill) se devuelve
// un id "noid-*": la app lo muestra igual, pero rcResolveSheetCell se niega a
// editarlo hasta que ensureRecordIds() le asigne uno.
function rcRecordUid(cell, i) {
  const v = String(cell == null ? "" : cell).trim();
  return v !== "" ? v : "noid-" + i;
}

// Rellena los ID faltantes en las hojas de registros. Idempotente: sin huecos
// no escribe. Se corre antes de la primera lectura y en cada refresco, así una
// fila que agregues a mano queda editable desde la app.
async function rcEnsureRecordIds() {
  if (!rcEndpointConfigured()) return null;
  const res = await rcApiPost({ action: "ensureRecordIds" });
  const filled = (res && res.filled) || {};
  const total = Object.keys(filled).reduce((n, k) => n + (filled[k] || 0), 0);
  if (total) console.log("[rc-sync] IDs asignados a filas sin ID:", filled);

  // El backend se niega a usar la columna ID de una hoja si ahí hay datos
  // ajenos. Sin aviso, esa hoja quedaría sin IDs y sus registros no se podrían
  // editar desde la app, sin explicación visible.
  const blocked = (res && res.blocked) || {};
  const names = Object.keys(blocked);
  if (names.length) {
    console.warn("[rc-sync] hojas sin columna ID disponible:", blocked);
    const detalle = names.map((n) => n + " (columna " + blocked[n].columna + ")").join(", ");
    rcToast(
      "warning",
      "Falta liberar una columna en la planilla",
      detalle + ". Mueve esos datos a otra columna para poder editar esos registros desde la app."
    );
  }
  return res;
}

async function rcReadAllRecords() {
  if (!rcEndpointConfigured()) return [];
  const data = await rcApiGet({ action: "read" });
  const records = [];

  ((data.Combustible || []).slice(1)).forEach(function (row, i) {
    const link = row[0], fecha = row[1], consumo = row[2], costo = row[3];
    const sucursal = row[5], tipo = row[6], proveedor = row[7], estadoLbl = row[8], origenLbl = row[9];
    if (!fecha && !consumo) return;
    const subcat = rcCombSubcat(tipo);
    records.push({
      id: "comb-" + rcRecordUid(row[10], i),
      _sheetName: "Combustible",
      date: rcParseDate(fecha),
      sucursal: sucursal || "",
      type: "combustible",
      subcat: subcat,
      provider: proveedor || "",
      cantidad: rcNum(consumo),
      unit: (subcat === "glp" || subcat === "gas-natural") ? "kg" : "L",
      costo: rcNum(costo),
      origen: rcOrigenValue(origenLbl),
      estado: rcEstadoValue(estadoLbl),
      _driveLink: link || "",
    });
  });

  ((data.Electricidad || []).slice(1)).forEach(function (row, i) {
    const link = row[0], numCli = row[1], fecha = row[2], consumo = row[3];
    const costo = row[4], sucursal = row[6], proveedor = row[8], estadoLbl = row[9], origenLbl = row[10];
    if (!fecha && !consumo) return;
    records.push({
      id: "elec-" + rcRecordUid(row[11], i),
      _sheetName: "Electricidad",
      date: rcParseDate(fecha),
      sucursal: sucursal || "",
      type: "electricidad",
      subcat: null,
      provider: proveedor || "",
      cantidad: rcNum(consumo),
      unit: "kWh",
      costo: rcNum(costo),
      origen: rcOrigenValue(origenLbl),
      estado: rcEstadoValue(estadoLbl),
      numeroCliente: numCli || "",
      _driveLink: link || "",
    });
  });

  ((data.Agua || []).slice(1)).forEach(function (row, i) {
    const link = row[0], numCli = row[1], fecha = row[2], consumo = row[3];
    const costo = row[4], sucursal = row[6], proveedor = row[8], subcatLbl = row[9], estadoLbl = row[10], origenLbl = row[11];
    if (!fecha && !consumo) return;
    records.push({
      id: "agua-" + rcRecordUid(row[12], i),
      _sheetName: "Agua",
      date: rcParseDate(fecha),
      sucursal: sucursal || "",
      type: "agua",
      subcat: rcAguaSubcat(subcatLbl),
      provider: proveedor || "",
      cantidad: rcNum(consumo),
      unit: "m³",
      costo: rcNum(costo),
      origen: rcOrigenValue(origenLbl),
      estado: rcEstadoValue(estadoLbl),
      numeroCliente: numCli || "",
      _driveLink: link || "",
    });
  });

  return records;
}

async function rcRefreshDashboard() {
  const { dispatch } = window.__rcStoreRef || {};
  if (!rcEndpointConfigured()) {
    console.warn("[rc-sync] APPS_SCRIPT_URL no configurada — saltando refresh");
    return;
  }
  if (dispatch) dispatch({ type: "RECORDS/LOADING", loading: true });
  window.dispatchEvent(new CustomEvent("rc:refresh-start"));
  try {
    const records = await rcReadAllRecords();
    console.log("[rc-sync] refresh: loaded", records.length, "records");
    if (dispatch) dispatch({ type: "RECORDS/REPLACE", records });
    window.dispatchEvent(new CustomEvent("rc:refresh-done", { detail: { ok: true, count: records.length } }));
  } catch (e) {
    console.error("[rc-sync] refresh failed", e);
    if (dispatch) dispatch({ type: "RECORDS/LOADING", loading: false });
    window.dispatchEvent(new CustomEvent("rc:refresh-done", { detail: { ok: false, msg: e.message } }));
  }
}
window.rcRefreshDashboard = rcRefreshDashboard;
window.rcReadAllRecords = rcReadAllRecords;

// ----- Row mapping --------------------------------------------------------

function endOfMonth(iso) {
  if (!iso) return "";
  const [y, m] = iso.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return String(last).padStart(2, "0") + "/" + String(m).padStart(2, "0") + "/" + y;
}
// Para registros manuales — el usuario elige un mes y se guarda día 15
// (punto medio del mes); se escribe en formato DD-MM-YY (orden D-M-Y
// explícito, 2 dígitos de año).
function fmtDDMMYY(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return iso;
  return m[3] + "-" + m[2] + "-" + m[1].slice(2);
}
function rcEstadoLabel(estado) {
  return estado === "eliminada" ? "Eliminada" : "Activa";
}
function rcEstadoValue(label) {
  if (!label) return "activa";
  const t = String(label).trim().toLowerCase();
  return t === "eliminada" || t === "eliminado" ? "eliminada" : "activa";
}

// Mapea r.origen interno → etiqueta legible que persiste en la hoja.
function rcOrigenLabel(origen) {
  const o = String(origen || "").toLowerCase();
  if (o === "manual") return "Manual";
  if (o === "documento" || o === "pdf") return "Documento";
  if (o === "foto") return "Foto";
  if (o === "sheets") return "";
  return "";
}
function rcOrigenValue(label) {
  const t = String(label || "").trim().toLowerCase();
  if (t === "manual") return "manual";
  if (t === "documento" || t === "pdf") return "documento";
  if (t === "foto") return "foto";
  return "sheets";
}

function rowsByType(records) {
  const byType = { combustible: [], electricidad: [], agua: [] };
  for (const r of records) {
    const isManual = r.origen === "manual";
    const origen = rcOrigenLabel(r.origen);
    if (r.type === "combustible") {
      byType.combustible.push([
        r._driveLink || "",
        isManual ? fmtDDMMYY(r.date) : endOfMonth(r.date),
        r.cantidad,
        r.costo,
        RC_CONFIG.EMPRESA,
        r.sucursal,
        r.subcat ? subcatLabel(r.type, r.subcat) : "Petróleo Diesel",
        r.provider || "",
        rcEstadoLabel(r.estado),
        origen,
      ]);
    } else if (r.type === "electricidad") {
      byType.electricidad.push([
        r._driveLink || "",
        r.numeroCliente || "",
        isManual ? fmtDDMMYY(r.date) : r.date,
        r.cantidad,
        r.costo,
        RC_CONFIG.EMPRESA,
        r.sucursal,
        "⚡Energía kWh",
        r.provider || "Enel",
        rcEstadoLabel(r.estado),
        origen,
      ]);
    } else if (r.type === "agua") {
      byType.agua.push([
        r._driveLink || "",
        r.numeroCliente || "",
        isManual ? fmtDDMMYY(r.date) : r.date,
        r.cantidad,
        r.costo,
        RC_CONFIG.EMPRESA,
        r.sucursal,
        "💧Agua m3",
        r.provider || "Aguas Andinas",
        r.subcat ? subcatLabel("agua", r.subcat) : "",
        rcEstadoLabel(r.estado),
        origen,
      ]);
    }
  }
  return byType;
}

// ----- File upload helper (base64) ---------------------------------------

async function rcFileToBase64(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ----- Fotos: flujo "Tomar foto" -----------------------------------------
// Sube imagen a FOTOS_POR_COMPLETAR, agrega fila pendiente en hoja "Fotos".
// Al completar, mueve archivo a FOTOS_PROCESADOS y marca status=procesado.

const FOTOS_SHEET = "Fotos";
// Orden y semántica de columnas en la hoja "Fotos":
//   1 File ID | 2 Drive URL | 3 Fecha subida | 4 Tipo | 5 Sucursal | 6 Subcat
//   7 Período | 8 Status     | 9 Fecha compl. | 10 Consumo | 11 Unidad | 12 Costo
//  13 Proveedor | 14 Notas
const FOTOS_HEADERS = [
  "File ID", "Drive URL", "Fecha subida", "Tipo", "Sucursal", "Subcategoría",
  "Período", "Status", "Fecha completado",
  "Consumo", "Unidad", "Costo", "Proveedor", "Notas",
];

async function rcUploadFoto(params) {
  if (!rcEndpointConfigured()) throw new Error("Backend no configurado.");
  const folderId = RC_CONFIG.FOLDERS.FOTOS_POR_COMPLETAR;
  if (!folderId) throw new Error("FOTOS_POR_COMPLETAR no configurado en sync.jsx");
  const {
    file, tipo, sucursal, periodo, subcat,
    consumo, unidad, costo, proveedor, notas,
  } = params || {};
  const base64 = await rcFileToBase64(file);
  const up = await rcApiPost({
    action: "upload",
    name: file.name,
    mimeType: file.type || "image/jpeg",
    base64,
    folderId,
  });
  const fechaSubida = new Date().toISOString();
  const row = [
    up.id, up.link, fechaSubida,
    tipo || "", sucursal || "", subcat || "",
    periodo || "", "pendiente", "",
    consumo || "", unidad || "", costo || "",
    proveedor || "", notas || "",
  ];
  await rcApiPost({ action: "append", sheet: FOTOS_SHEET, values: [row] });
  return { fileId: up.id, link: up.link };
}

// Lista de emails a notificar (cola fotos) persistida en Config sheet.
async function rcReadFotoNotifEmails() {
  if (!rcEndpointConfigured()) return [];
  const data = await rcApiGet({ action: "getConfig", key: "fotoNotifEmails" });
  const v = data && data.value;
  return Array.isArray(v) ? v.filter(e => typeof e === "string" && e.indexOf("@") !== -1) : [];
}

async function rcWriteFotoNotifEmails(emails) {
  if (!rcEndpointConfigured()) return;
  const clean = (emails || [])
    .map(e => String(e || "").trim())
    .filter(e => e && e.indexOf("@") !== -1);
  await rcApiPost({ action: "setConfig", key: "fotoNotifEmails", value: clean });
}

// Dispara el correo a los destinatarios configurados. Fire-and-forget; nunca
// rompe el flujo de subida si falla.
async function rcNotifyFotoPending(info) {
  if (!rcEndpointConfigured()) return;
  try {
    await rcApiPost({ action: "notifyFotoPending", ...(info || {}) });
  } catch (e) {
    console.warn("[rc-sync] notifyFotoPending failed", e);
  }
}

async function rcReadFotos() {
  if (!rcEndpointConfigured()) return [];
  const data = await rcApiGet({ action: "getFotos" });
  const rows = (data && data.rows) || [];
  // rowIndex = 2 corresponde a la primera fila de datos (asumiendo encabezado en fila 1)
  return rows.map((r, i) => ({
    rowIndex:        i + 2,
    fileId:          r[0] || "",
    link:            r[1] || "",
    fechaSubida:     r[2] || "",
    tipo:            r[3] || "",
    sucursal:        r[4] || "",
    subcat:          r[5] || "",
    periodo:         r[6] || "",
    status:          (r[7] || "").toString().toLowerCase(),
    fechaCompletado: r[8] || "",
    consumo:         r[9] || "",
    unidad:          r[10] || "",
    costo:           r[11] || "",
    proveedor:       r[12] || "",
    notas:           r[13] || "",
  }));
}

// Period "YYYY-MM" → ISO "YYYY-MM-DD" del último día del mes.
function rcLastDayOfMonth(yyyymm) {
  if (!yyyymm || typeof yyyymm !== "string") return "";
  const parts = yyyymm.split("-").map(Number);
  if (parts.length < 2 || !parts[0] || !parts[1]) return "";
  const [y, m] = parts;
  const lastDay = new Date(y, m, 0).getDate();
  return y + "-" + String(m).padStart(2, "0") + "-" + String(lastDay).padStart(2, "0");
}

// Construye fila para hoja Combustible/Electricidad/Agua a partir de una
// foto completada. Devuelve null para refrigerantes u otros tipos sin sheet.
function rcFotoToConsumptionRow(fotoRow, patch) {
  const empresa   = RC_CONFIG.EMPRESA || "";
  const sucursal  = fotoRow.sucursal || "";
  const fecha     = rcLastDayOfMonth(fotoRow.periodo);
  const consumo   = parseFloat(patch.consumo) || 0;
  const costo     = parseFloat(patch.costo)   || 0;
  const proveedor = patch.proveedor || "";
  const link      = fotoRow.link || "";
  const tipo      = fotoRow.tipo;
  const subLabel  = (typeof subcatLabel === "function" && patch.subcat)
    ? (subcatLabel(tipo, patch.subcat) || patch.subcat)
    : (patch.subcat || "");
  if (tipo === "combustible") {
    return { sheet: "Combustible", values: [[
      link, fecha, consumo, costo, empresa, sucursal, subLabel, proveedor, "activa", "Foto",
    ]]};
  }
  if (tipo === "electricidad") {
    return { sheet: "Electricidad", values: [[
      link, "", fecha, consumo, costo, empresa, sucursal, "Electricidad", proveedor, "activa", "Foto",
    ]]};
  }
  if (tipo === "agua") {
    return { sheet: "Agua", values: [[
      link, "", fecha, consumo, costo, empresa, sucursal, "Agua", proveedor, subLabel, "activa", "Foto",
    ]]};
  }
  return null;
}

async function rcCompleteFoto({ fileId, rowIndex, patch, fotoRow }) {
  if (!rcEndpointConfigured()) throw new Error("Backend no configurado.");
  // Se ubica la fila por el File ID de Drive (columna 1 de la hoja Fotos), que
  // ya es único por foto. Antes se escribía por número de fila calculado en la
  // lectura: si alguien borraba u ordenaba filas de la cola a mano, los datos
  // completados terminaban en la foto equivocada.
  if (!fileId && !rowIndex) throw new Error("fileId o rowIndex requerido");
  const now = new Date().toISOString();
  // Columnas que actualizamos (col index 1-based en hoja Fotos).
  // Incluye tipo/sucursal/periodo para reflejar ediciones hechas en el form
  // de Completar (no solo los datos nuevos del patch).
  const cells = [
    [4,  (fotoRow && fotoRow.tipo)     || ""],
    [5,  (fotoRow && fotoRow.sucursal) || ""],
    [6,  patch.subcat    || ""],
    [7,  (fotoRow && fotoRow.periodo)  || ""],
    [8,  "procesado"],
    [9,  now],
    [10, patch.consumo   || ""],
    [11, patch.unidad    || ""],
    [12, patch.costo     || ""],
    [13, patch.proveedor || ""],
    [14, patch.notas     || ""],
  ];
  for (const [col, value] of cells) {
    if (fileId) {
      await rcApiPost({ action: "updateById", sheet: FOTOS_SHEET, id: fileId, col, value });
    } else {
      await rcApiPost({ action: "update", sheet: FOTOS_SHEET, row: rowIndex, col, value });
    }
  }
  // Migrar copia a la hoja de consumo (Combustible/Electricidad/Agua) para
  // que aparezca en el dashboard.
  if (fotoRow) {
    const target = rcFotoToConsumptionRow(fotoRow, patch);
    if (target) {
      try {
        await rcApiPost({ action: "append", sheet: target.sheet, values: target.values });
      } catch (e) {
        console.warn("[rc-sync] migrate foto → " + target.sheet + " failed", e);
      }
    }
  }
  if (fileId && RC_CONFIG.FOLDERS.FOTOS_PROCESADOS) {
    await rcApiPost({
      action: "move",
      fileId,
      fromFolderId: RC_CONFIG.FOLDERS.FOTOS_POR_COMPLETAR,
      toFolderId:   RC_CONFIG.FOLDERS.FOTOS_PROCESADOS,
    });
  }
  // Refresca records para que la nueva fila aparezca en el dashboard.
  if (typeof rcRefreshDashboard === "function") {
    try { await rcRefreshDashboard(); } catch (e) {}
  }
}

// ----- Confirm handler ----------------------------------------------------

// Adjunta un documento a un registro existente del dashboard. Sube el archivo
// a la carpeta MANUAL_FACTURAS y, si el registro proviene de Sheets, también
// actualiza la celda Link. Devuelve { id, link } del archivo en Drive.
async function rcAttachDocumentToRecord(rec, file) {
  if (!rcEndpointConfigured()) throw new Error("Backend no configurado.");
  const folderId = RC_CONFIG.FOLDERS.MANUAL_FACTURAS;
  if (!folderId) throw new Error("MANUAL_FACTURAS no configurado en sync.jsx");
  const base64 = await rcFileToBase64(file);
  const up = await rcApiPost({
    action: "upload",
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    base64,
    folderId,
  });
  // Igual que la edición inline: la celda se ubica por el ID de la fila, no por
  // su posición. El archivo ya quedó en Drive, así que si la fila no existe solo
  // se avisa — no se reintenta contra una fila adivinada.
  const target = rcResolveSheetCell(rec.id, "link");
  if (target && target.needsId) {
    console.warn("[rc-sync] attach: fila sin ID, no se actualiza la celda Link:", rec.id);
    rcToast("warning", "Archivo subido", "No se pudo enlazar en la planilla: la fila no tiene ID. Recarga y reintenta.");
  } else if (target) {
    try {
      await rcApiPost({ action: "updateById", sheet: target.sheet, id: target.id, col: target.col, value: up.link });
    } catch (e) {
      console.warn("[rc-sync] attach: update link cell failed", e);
      rcToast("warning", "Archivo subido", "No se pudo enlazar en la planilla: " + (e.message || ""));
    }
  }
  return up;
}

async function rcHandleConfirm(ev) {
  const detail = ev.detail || {};
  const { source, provider, records, files } = detail;
  console.log("[rc-sync] rc:confirm received", detail);
  if (!rcEndpointConfigured()) {
    console.warn("[rc-sync] APPS_SCRIPT_URL no configurada");
    window.dispatchEvent(new CustomEvent("rc:sync-done", {
      detail: { ok: false, msg: "Backend no configurado. Edita APPS_SCRIPT_URL en sync.jsx." },
    }));
    return;
  }
  try {
    // 1) Subir cada archivo único a la carpeta Drive correspondiente
    const uploads = {};
    if (source === "upload" && files && files.length) {
      const providerId = (provider && provider.id) || "";
      const pf = (RC_CONFIG.PROVIDER_FOLDERS && RC_CONFIG.PROVIDER_FOLDERS[providerId]) || null;
      const folderOrigen = (pf && pf.porProcesar)
        || RC_CONFIG.FOLDERS.UPLOAD_FACTURAS
        || RC_CONFIG.FOLDERS.MANUAL_FACTURAS
        || null;
      // Sólo movemos a "procesados" si el proveedor tiene su par configurado.
      const folderDestino = (pf && pf.procesados) || null;
      if (folderOrigen) {
        for (const f of files) {
          if (!f.file) continue;
          if (uploads[f.name]) continue;
          try {
            console.log("[rc-sync] uploading to Drive:", f.name);
            const base64 = await rcFileToBase64(f.file);
            const up = await rcApiPost({
              action: "upload",
              name: f.file.name,
              mimeType: f.file.type || "application/octet-stream",
              base64: base64,
              folderId: folderOrigen,
            });
            uploads[f.name] = { id: up.id, link: up.link, folderOrigen, folderDestino };
            console.log("[rc-sync] uploaded:", up);
          } catch (e) { console.warn("[rc-sync] upload failed", f.name, e); }
        }
      }
    }

    // 1b) Subir facturas adjuntas a entradas manuales (una por record)
    if (source === "manual" && Array.isArray(detail.facturas) && detail.facturas.length) {
      const folder = RC_CONFIG.FOLDERS.MANUAL_FACTURAS;
      if (folder) {
        for (const f of detail.facturas) {
          if (!f.file) continue;
          try {
            console.log("[rc-sync] uploading factura:", f.name);
            const base64 = await rcFileToBase64(f.file);
            const up = await rcApiPost({
              action: "upload",
              name: f.file.name,
              mimeType: f.file.type || "application/octet-stream",
              base64: base64,
              folderId: folder,
            });
            const target = (records || []).find(r => r.id === f.recordId);
            if (target) target._driveLink = up.link;
            console.log("[rc-sync] factura uploaded:", up);
          } catch (e) { console.warn("[rc-sync] factura upload failed", f.name, e); }
        }
      } else {
        console.log("[rc-sync] MANUAL_FACTURAS folder not configured — skipping factura upload");
      }
    }

    // 2) Anexar drive link a registros con mismo sourceFile
    if (Object.keys(uploads).length && records) {
      records.forEach((r) => {
        if (r.sourceFile && uploads[r.sourceFile]) {
          r._driveLink = uploads[r.sourceFile].link;
        }
      });
    }

    // 3) Append a las hojas correspondientes
    const byType = rowsByType(records);
    console.log("[rc-sync] rows ready to write", byType);
    let written = 0;
    if (byType.combustible.length) {
      await rcApiPost({ action: "append", sheet: RC_CONFIG.SHEETS.COMBUSTIBLE, values: byType.combustible });
      written += byType.combustible.length;
    }
    if (byType.electricidad.length) {
      await rcApiPost({ action: "append", sheet: RC_CONFIG.SHEETS.ELECTRICIDAD, values: byType.electricidad });
      written += byType.electricidad.length;
    }
    if (byType.agua.length) {
      await rcApiPost({ action: "append", sheet: RC_CONFIG.SHEETS.AGUA, values: byType.agua });
      written += byType.agua.length;
    }

    // 4) Mover PDFs a "Procesados"
    for (const u of Object.values(uploads)) {
      if (u.folderOrigen && u.folderDestino) {
        try {
          await rcApiPost({
            action: "move",
            fileId: u.id,
            fromFolderId: u.folderOrigen,
            toFolderId: u.folderDestino,
          });
          console.log("[rc-sync] moved file to Procesados:", u.id);
        } catch (e) { console.warn("[rc-sync] move failed", e); }
      }
    }

    window.dispatchEvent(new CustomEvent("rc:sync-done", {
      detail: { ok: true, written, source },
    }));
    if (written > 0 && typeof rcRefreshDashboard === "function") rcRefreshDashboard();
  } catch (e) {
    console.error("Sheets sync failed", e);
    window.dispatchEvent(new CustomEvent("rc:sync-done", {
      detail: { ok: false, msg: e.message },
    }));
  }
}
window.addEventListener("rc:confirm", rcHandleConfirm);

// ----- Inline edit sync ---------------------------------------------------
// El id que arma rcReadAllRecords es "comb-{uid}" / "elec-{uid}" / "agua-{uid}",
// donde uid es el valor de la columna "ID" de esa fila. El backend ubica la
// fila por ese uid (acción "updateById"), no por número de fila: así se puede
// borrar, ordenar o insertar filas a mano en la planilla sin que las ediciones
// terminen en la fila equivocada.
//
// Las columnas (1-based) siguen los layouts de WEB_CFG.HEADERS:
//   Combustible  → Consumo=3, Costo=4
//   Electricidad → Consumo total=4, Costo=5
//   Agua         → Consumo total=4, Costo=5
function rcResolveSheetCell(id, field) {
  const m = /^(comb|elec|agua)-(.+)$/.exec(id || "");
  if (!m) return null;
  const kind = m[1];
  const uid = m[2];
  // Fila sin ID todavía: no se edita a ciegas. Se resuelve solo cuando
  // ensureRecordIds() le asigna uno (ocurre en la carga y en cada refresco).
  if (uid.indexOf("noid-") === 0) return { needsId: true };
  const COLS = {
    comb: { link: 1, date: 2, cantidad: 3, costo: 4, subcat: 7, provider: 8, estado: 9,  sheet: RC_CONFIG.SHEETS.COMBUSTIBLE },
    elec: { link: 1, date: 3, cantidad: 4, costo: 5,             provider: 9, estado: 10, sheet: RC_CONFIG.SHEETS.ELECTRICIDAD },
    agua: { link: 1, date: 3, cantidad: 4, costo: 5, subcat: 10, provider: 9, estado: 11, sheet: RC_CONFIG.SHEETS.AGUA },
  }[kind];
  if (!COLS || !COLS[field]) return null;
  return { sheet: COLS.sheet, id: uid, col: COLS[field] };
}

async function rcHandleEdit(ev) {
  const { id, field, value } = ev.detail || {};
  if (!rcEndpointConfigured()) return;
  const target = rcResolveSheetCell(id, field);
  if (!target) {
    console.warn("[rc-sync] edit ignored — record not from sheets:", id, field);
    return;
  }
  if (target.needsId) {
    const msg = "Esta fila todavía no tiene ID en la planilla. Recarga para asignarlo.";
    console.warn("[rc-sync] edit ignored — fila sin ID:", id);
    rcToast("error", "No se pudo guardar la edición", msg);
    window.dispatchEvent(new CustomEvent("rc:edit-done", { detail: { ok: false, msg } }));
    return;
  }
  // La fecha viaja como ISO (YYYY-MM-DD) desde la UI; la escribimos en el
  // mismo formato DD-MM-YY que usan los registros manuales (rcParseDate lo lee).
  const outValue = field === "date" ? fmtDDMMYY(value) : value;
  try {
    const res = await rcApiPost({
      action: "updateById", sheet: target.sheet, id: target.id, col: target.col, value: outValue,
    });
    console.log("[rc-sync] cell updated", target.sheet, "fila", res && res.row, target.col, "=", value);
    window.dispatchEvent(new CustomEvent("rc:edit-done", { detail: { ok: true } }));
  } catch (e) {
    console.error("[rc-sync] cell update failed", e);
    // "registro no encontrado" = la fila se borró en la planilla. El backend NO
    // escribió nada; antes, con índices, habría pisado otra fila en silencio.
    const gone = /registro no encontrado/i.test(e.message || "");
    rcToast(
      "error",
      "No se pudo guardar la edición",
      gone ? "Esa fila ya no existe en la planilla. Recarga los datos." : (e.message || "")
    );
    window.dispatchEvent(new CustomEvent("rc:edit-done", { detail: { ok: false, msg: e.message } }));
  }
}
window.addEventListener("rc:edit", rcHandleEdit);

// ----- React helpers ------------------------------------------------------

// Carga config + emisiones + notif + medidores desde el Sheet. La usan el
// bootstrap inicial y el refresco al volver a la pestaña.
//
// ORDEN IMPORTANTE: el flag __rc*Bootstrapped se pone ANTES del dispatch. El
// effect que sincroniza esa hoja se dispara con el LOAD y, al verse habilitado,
// arma su línea base con el estado ya cargado. Si el flag se pusiera después
// (como antes), ese primer pase se descartaba y la línea base terminaba
// armándose con el PRIMER CAMBIO del usuario — o peor, quedaba vacía y cada
// carga de la app concluía "todo es nuevo" y reescribía las hojas completas.
async function rcLoadDomains() {
  const dispatchNow = () => (window.__rcStoreRef || {}).dispatch;

  // 1) Configuración de sucursales
  try {
    const cfg = await rcReadConfigSucursales();
    const dispatch = dispatchNow();
    if (dispatch && cfg && Array.isArray(cfg) && cfg.length > 0) {
      dispatch({ type: "CONFIG/LOAD", configSucursales: cfg });
    }
  } catch (e) {
    console.warn("[rc-sync] config load failed", e);
    // Antes fallaba en silencio: la app arrancaba sin sucursales y parecía que
    // se habían borrado. Ahora se avisa.
    rcToast("error", "No se pudieron cargar las sucursales", e && e.message);
  }
  window.__rcConfigBootstrapped = true;

  // 2) Factores de emisión
  window.__rcEmissionsBootstrapped = true;
  try {
    const em = await rcReadEmissions();
    const dispatch = dispatchNow();
    if (dispatch && em && rcEmissionsHasContent(em)) {
      // Descartar la línea base antes del LOAD: el effect la re-arma con lo
      // recién leído, así un refresco no se interpreta como cambio del usuario.
      rcResetBaseline("Emisiones");
      dispatch({ type: "EMIS/LOAD", emissions: em });
    }
  } catch (e) {
    console.warn("[rc-sync] emissions load failed", e);
    rcToast("error", "No se pudieron cargar los factores de emisión", e && e.message);
  }

  // 3) Emails de notificación cola fotos
  window.__rcNotifBootstrapped = true;
  try {
    const emails = await rcReadFotoNotifEmails();
    const dispatch = dispatchNow();
    if (dispatch) dispatch({ type: "NOTIF/LOAD", emails });
  } catch (e) {
    console.warn("[rc-sync] notif emails load failed", e);
  }

  // 4) Medidores
  window.__rcMedidoresBootstrapped = true;
  try {
    const med = await rcReadMedidores();
    const dispatch = dispatchNow();
    if (dispatch && med && (med.meters.length || med.readings.length || med.prices.length || Object.keys(med.docs).length)) {
      rcResetBaseline("Medidores");
      rcResetBaseline("Lecturas Medidor");
      rcResetBaseline("Precios Medidor");
      dispatch({ type: "MED/LOAD", ...med });
    }
  } catch (e) {
    console.warn("[rc-sync] medidores load failed", e);
    rcToast("error", "No se pudieron cargar los medidores", e && e.message);
  } finally {
    const dispatch = dispatchNow();
    if (dispatch) dispatch({ type: "MED/SET_LOADING", loading: false });
  }
}

// Bootstrap: cargar registros + configSucursales desde Sheets al iniciar.
const SyncBootstrap = () => {
  React.useEffect(() => {
    async function init() {
      if (!rcEndpointConfigured()) {
        console.warn("[rc-sync] APPS_SCRIPT_URL no está configurada — el dashboard quedará vacío.");
        window.__rcConfigBootstrapped = true;
        const { dispatch } = window.__rcStoreRef || {};
        if (dispatch) dispatch({ type: "MED/SET_LOADING", loading: false });
        return;
      }
      // Antes de leer: asegurar que toda fila tenga ID. Cubre las filas previas
      // a v5 y las que se hayan agregado a mano en la planilla.
      try {
        await rcEnsureRecordIds();
      } catch (e) {
        console.warn("[rc-sync] ensureRecordIds failed", e);
      }
      await rcRefreshDashboard();
      await rcLoadDomains();
    }
    init();
  }, []);
  return null;
};

// Refresco al volver a la pestaña. Sin esto un cliente se queda con la foto
// que leyó al abrir durante toda la sesión: mientras más vieja, más desfasado
// lo que muestra (y lo que decide el usuario sobre esos datos).
//
// MED/LOAD y EMIS/LOAD reemplazan su slice, así que solo se refresca cuando no
// hay escrituras en vuelo ni cambios locales sin confirmar — si no, se
// descartaría trabajo del usuario.
const RC_REFRESH_MIN_MS = 60000;

// Recarga todo desde el Sheet. `force` salta el mínimo entre refrescos (lo usa
// el botón "Recargar"), pero NUNCA salta la comprobación de escrituras
// pendientes: MED/LOAD y EMIS/LOAD reemplazan su slice y descartarían cambios
// locales que aún no llegaron al Sheet.
let __rcLastRefresh = 0;
let __rcRefreshing = false;

async function rcRefreshFromSheet(force) {
  if (!rcEndpointConfigured() || !window.__rcConfigBootstrapped) return false;
  if (__rcRefreshing) return false;
  if (rcHasPendingWrites()) {
    if (force) rcToast("info", "Guardando cambios…", "Vuelve a intentar en unos segundos.");
    return false;
  }
  const now = new Date().getTime();
  if (!force && now - __rcLastRefresh < RC_REFRESH_MIN_MS) return false;
  __rcLastRefresh = now;
  __rcRefreshing = true;
  try {
    // Asigna ID a las filas que se hayan agregado a mano desde la última carga.
    try { await rcEnsureRecordIds(); } catch (e) { console.warn("[rc-sync] ensureRecordIds failed", e); }
    await rcRefreshDashboard();
    await rcLoadDomains();
    console.log("[rc-sync] datos recargados desde el Sheet");
    return true;
  } catch (e) {
    console.warn("[rc-sync] refresh failed", e);
    if (force) rcToast("error", "No se pudo recargar", e && e.message);
    return false;
  } finally {
    __rcRefreshing = false;
  }
}

const SyncRefresher = () => {
  React.useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      rcRefreshFromSheet(false);
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return null;
};

// El botón "Refrescar" del dashboard llama a rcRefreshFromSheet(true): además
// de los registros recarga config, emisiones y medidores, y asigna ID a las
// filas que se hayan agregado a mano en la planilla.

// Toast en respuesta a sync-done.
const SyncToaster = () => {
  React.useEffect(() => {
    function onSyncDone(ev) {
      const { dispatch } = window.__rcStoreRef || {};
      if (!dispatch) return;
      const d = ev.detail || {};
      if (d.ok) {
        dispatch({
          type: "TOAST/SHOW",
          toast: {
            kind: "success",
            title: "Sincronizado",
            body: d.written + " fila" + (d.written !== 1 ? "s" : "") + " escrita" + (d.written !== 1 ? "s" : "") + ".",
          },
        });
      } else {
        dispatch({
          type: "TOAST/SHOW",
          toast: { kind: "error", title: "No se pudo sincronizar", body: d.msg || "Error desconocido" },
        });
      }
    }
    window.addEventListener("rc:sync-done", onSyncDone);
    return () => window.removeEventListener("rc:sync-done", onSyncDone);
  }, []);
  return null;
};

// Expone el store a los handlers y persiste emisiones / medidores / notif.
// configSucursales se persiste en la acción del usuario, no acá.
const StoreBridge = () => {
  const app = useApp();
  const emisDebounceRef = React.useRef(null);

  React.useEffect(() => {
    window.__rcStoreRef = app;
    return () => { window.__rcStoreRef = null; };
  }, [app]);

  // configSucursales YA NO se observa acá. Se persiste en la acción del usuario
  // (rcSaveSucursal / rcRemoveSucursal, llamadas desde config-edit / config /
  // onboarding). El observador con foto-para-diffear era la causa de que cada
  // carga de la app reescribiera la tabla completa: la foto se tomaba antes de
  // que React aplicara el CONFIG/LOAD, salía vacía, y todo parecía nuevo.

  // Guarda emails de notificación cuando cambian (debounce 600ms).
  const notifDebounceRef = React.useRef(null);
  React.useEffect(() => {
    if (!window.__rcNotifBootstrapped) return;
    const json = JSON.stringify(app.state.fotoNotifEmails || []);
    if (notifDebounceRef.current) clearTimeout(notifDebounceRef.current);
    notifDebounceRef.current = setTimeout(async () => {
      if (!rcEndpointConfigured()) return;
      if (window.__rcLoadedNotifJson === json) {
        window.__rcLoadedNotifJson = undefined;
        return;
      }
      try {
        await rcWriteFotoNotifEmails(app.state.fotoNotifEmails || []);
        console.log("[rc-sync] fotoNotifEmails guardados:", (app.state.fotoNotifEmails || []).length);
      } catch (e) {
        console.error("[rc-sync] notif emails save failed", e);
      }
    }, 600);
    return () => { if (notifDebounceRef.current) clearTimeout(notifDebounceRef.current); };
  }, [app.state.fotoNotifEmails]);

  // Guarda emisiones en Sheets cuando cambian (debounce 800ms).
  // El primer pase tras el bootstrap solo arma la línea base — con el estado ya
  // cargado del Sheet — y no escribe. Se arma acá, sincrónicamente, y no dentro
  // del setTimeout: si el usuario edita antes de que venza el debounce, la base
  // ya quedó tomada del estado cargado y su edición se detecta como cambio.
  React.useEffect(() => {
    if (!window.__rcEmissionsBootstrapped) return;
    const rows = rcFlattenEmissions(app.state.emissions);
    if (RC_BASELINE["Emisiones"] === undefined) {
      rcArmBaseline("Emisiones", rows);
      return;
    }
    if (emisDebounceRef.current) clearTimeout(emisDebounceRef.current);
    emisDebounceRef.current = setTimeout(async () => {
      if (!rcEndpointConfigured()) return;
      RC_DIRTY.add("Emisiones");
      try {
        const res = await rcSyncKeyedSheet("Emisiones", rows);
        if (res) console.log("[rc-sync] emisiones:", res.upserted, "upsert /", res.deleted, "borradas");
      } catch (e) {
        console.error("[rc-sync] emissions save failed", e);
        rcToast("error", "No se pudieron guardar los factores", e && e.message);
      } finally {
        RC_DIRTY.delete("Emisiones");
      }
    }, 800);
    return () => { if (emisDebounceRef.current) clearTimeout(emisDebounceRef.current); };
  }, [app.state.emissions]);

  // Guarda medidores (meters/readings/prices/docs) en Sheets cuando cambian (debounce 900ms).
  const medDebounceRef = React.useRef(null);
  const med = app.state.medidores;
  // Tres hojas, tres líneas base. Mismo criterio que emisiones: el primer pase
  // tras el bootstrap solo arma y no escribe.
  const MED_SHEETS = ["Medidores", "Lecturas Medidor", "Precios Medidor"];
  React.useEffect(() => {
    if (!window.__rcMedidoresBootstrapped) return;
    const slice = { meters: med.meters, readings: med.readings, prices: med.prices, docs: med.docs };
    const rowsBySheet = {
      "Medidores":        rcFlattenMedidores(slice.meters),
      "Lecturas Medidor": rcFlattenMedLecturas(slice.readings, slice.docs),
      "Precios Medidor":  rcFlattenMedPrecios(slice.prices),
    };
    const unarmed = MED_SHEETS.filter((s) => RC_BASELINE[s] === undefined);
    if (unarmed.length) {
      unarmed.forEach((s) => rcArmBaseline(s, rowsBySheet[s]));
      if (unarmed.length === MED_SHEETS.length) return;   // carga completa: no escribir
    }
    if (medDebounceRef.current) clearTimeout(medDebounceRef.current);
    medDebounceRef.current = setTimeout(async () => {
      if (!rcEndpointConfigured()) return;
      MED_SHEETS.forEach((s) => RC_DIRTY.add(s));
      try {
        for (const s of MED_SHEETS) {
          const res = await rcSyncKeyedSheet(s, rowsBySheet[s]);
          if (res) console.log("[rc-sync] " + s + ":", res.upserted, "upsert /", res.deleted, "borradas");
        }
      } catch (e) {
        console.error("[rc-sync] medidores save failed", e);
        rcToast("error", "No se pudieron guardar los medidores", e && e.message);
      } finally {
        MED_SHEETS.forEach((s) => RC_DIRTY.delete(s));
      }
    }, 900);
    return () => { if (medDebounceRef.current) clearTimeout(medDebounceRef.current); };
  }, [med.meters, med.readings, med.prices, med.docs]);

  return null;
};

// Banner persistente con el último estado de sync.
const SyncStatus = () => {
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => {
    function onSyncStart() { setStatus({ kind: "loading", at: Date.now() }); }
    function onSyncDone(ev) {
      const d = ev.detail || {};
      setStatus({
        kind: d.ok ? "ok" : "err",
        at: Date.now(),
        msg: d.ok
          ? (d.msg
              ? d.msg + " · " + new Date().toLocaleTimeString("es-CL")
              : "Última sincronización: " + d.written + " fila" + (d.written !== 1 ? "s" : "") + " · " + new Date().toLocaleTimeString("es-CL"))
          : "Error: " + (d.msg || "desconocido"),
      });
    }
    window.addEventListener("rc:confirm", onSyncStart);
    window.addEventListener("rc:sync-done", onSyncDone);
    return () => {
      window.removeEventListener("rc:confirm", onSyncStart);
      window.removeEventListener("rc:sync-done", onSyncDone);
    };
  }, []);
  if (!status) return null;
  return (
    <div className={"rc-sync-banner " + status.kind} role="status">
      {status.kind === "loading" && <span className="prt-spinner" />}
      {status.kind === "ok" && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {status.kind === "err" && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )}
      <span>{status.kind === "loading" ? "Guardando…" : status.msg}</span>
    </div>
  );
};

// Placeholder — el link al spreadsheet ya no se expone al usuario final.
const SheetLink = () => null;

Object.assign(window, {
  StoreBridge, SyncBootstrap, SyncRefresher, SyncToaster, SyncStatus, SheetLink, RC_CONFIG,
  rcReadConfigSucursales, rcUpsertSucursal, rcDeleteSucursal, rcFlattenConfig, rcUnflattenConfig,
  rcSaveSucursal, rcRemoveSucursal, rcSyncKeyedSheet, rcToast, rcLoadDomains,
  rcRefreshFromSheet, rcEnsureRecordIds, rcResolveSheetCell, rcRecordUid,
  rcReadEmissions, rcWriteEmissions, rcFlattenEmissions, rcUnflattenEmissions,
  rcUploadFoto, rcReadFotos, rcCompleteFoto,
  rcReadFotoNotifEmails, rcWriteFotoNotifEmails, rcNotifyFotoPending,
  rcAttachDocumentToRecord,
  rcReadMedidores, rcWriteMedidores, rcUploadMedidorDoc, rcDeleteMedidorDoc,
});
