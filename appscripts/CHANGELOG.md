# Apps Script — CHANGELOG (Base)

Snapshots congelados del `apps-script.gs` desplegado. `SCRIPT_VERSION` en el
código = versión activa (verificable con `?action=ping`).

| Versión | Fecha | Cambios |
|---------|-------|---------|
| v1 | 2026-07-01 | Base inicial: concurrencia (withLock), upsertSucursal/deleteSucursal, SCRIPT_VERSION en ping |
| v2 | 2026-07-13 | Módulo Medidores: hojas Medidores/Lecturas Medidor/Precios Medidor (getSheetRows/setSheetRows + acciones get/set), uploadFile con subfolders, deleteFile (papelera Drive) |
| v3 | 2026-07-17 | Columna "Facturable" en hoja Medidores (medidores excluidos del proceso de facturación) |
| v4 | 2026-08-04 | **Fin del clobber entre usuarios.** Nueva acción `syncKeyed` (upsert + delete por clave natural, ver `KEYED_SHEETS`). Se eliminan `setConfigSucursales`, `setEmissions`, `setMedidores`, `setLecturasMedidor`, `setPreciosMedidor` y las funciones `setEmissions`/`setSheetRows`: hacían `sheet.clear()` + reescritura total desde el estado en memoria de un cliente, borrando lo que otro hubiera guardado en paralelo. `upsertSucursal` ahora escribe en la posición original en vez de borrar + agregar al final (las filas ya no saltan). Regla nueva: ningún camino de escritura usa `sheet.clear()` ni `deleteRow()`. |

| v5 | 2026-08-04 | **Clave estable por registro.** Columna "ID" al final de Combustible / Electricidad / Agua. Nueva acción `updateById` (ubica la fila por ID y **falla explícito** si no existe, en vez de escribir en la que quedó en esa posición) y `ensureRecordIds` (backfill idempotente de los ID faltantes). `appendRows` asigna ID a cada fila nueva. Permite borrar, ordenar e insertar filas a mano en la planilla sin desalinear las ediciones de la app. La acción `update` (por fila/columna) se mantiene para otros usos. |

## Migración a v4 / v5

v5 incluye todo lo de v4 — si no desplegaste v4, despliega v5 directo.

`syncKeyed`, `updateById` y `ensureRecordIds` son acciones nuevas; las `set*`
eliminadas devuelven `unknown action`. **Desplegar el backend y recargar la app
van juntos**: un cliente con el JS viejo contra el backend nuevo verá errores al
guardar (toast rojo) en vez de perder datos en silencio — que es el
comportamiento deseado, pero conviene avisar a quien tenga la pestaña abierta.

Antes de desplegar v5:

1. Archivo → Crear una copia de la planilla (respaldo).
2. Tras desplegar, revisar `?action=inspectRecordIds` (solo lectura, no escribe).
   Reporta por hoja la columna del ID, su encabezado y si hay datos ajenos ahí.

La columna ID va **después** de todas las columnas en uso de cada hoja:
Combustible → **K**, Electricidad → **L**, Agua → **M**.

`ensureRecordIds` se protege solo: si la columna ID de una hoja tiene valores
que no son IDs generados por el script, **salta esa hoja completa** y la reporta
en `blocked` (la app muestra un aviso). Nunca sobreescribe contenido ajeno; los
registros de esa hoja simplemente no se pueden editar desde la app hasta que se
libere la columna. También rellena los encabezados en blanco de las hojas de
registros desde `WEB_CFG.HEADERS` (solo los vacíos; uno renombrado a mano se
respeta).
