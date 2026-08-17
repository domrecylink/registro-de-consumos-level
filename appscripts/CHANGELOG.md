# Apps Script — CHANGELOG (Level)

Registro de lo que **esta instancia** tiene desplegado. `SCRIPT_VERSION` en
`apps-script.gs` = versión activa, verificable con `?action=ping`.

| Versión | Fecha | Snapshot | Cambios |
|---------|-------|----------|---------|
| v6 | 2026-08-17 | `v6_2026-08-17.gs` | Primera implementación de Level. `ensureSheets()` crea también `Config`, `Config Sucursales` y `Emisiones` — antes solo recorría `WEB_CFG.HEADERS` (9 hojas) y esas tres nacían recién en su primera escritura, así que una planilla nueva quedaba incompleta. `action:"init"` ahora devuelve la lista de hojas resultante en vez de `{ok:true}` pelado. |

El archivo que se pega en el editor de Apps Script es **`apps-script.gs` en la
raíz del repo** — ese es el código vivo. El snapshot de acá es su copia
congelada, idéntica byte a byte mientras Level siga en v6.

Level nació sobre la generación **v5** del backend de la plantilla
(`registro-de-consumos-base`) y le sumó el arreglo de `ensureSheets`, así que su
primer despliegue es v6: no hay que pasar por v1…v5, cada versión incluye las
anteriores. El número identifica **qué código corre**, no cuántas veces se
implementó acá — es lo que permite comparar por `ping` si Level y Base corren el
mismo backend, que es justo lo que importa al portar un arreglo con
`git fetch base`.

**Pendiente en la plantilla:** el arreglo de `ensureSheets` está solo en Level.
Conviene subirlo a `registro-de-consumos-base` como su v6 para que las dos
instancias converjan y `ping` siga siendo comparable.

Los snapshots v1…v5 de la plantilla no se copiaron: eran el historial de
despliegues sobre la planilla de **Base** y llevaban su `SPREADSHEET_ID` adentro,
así que pegar uno por error habría hecho que Level escribiera en la planilla de
otro cliente. Para ese historial, ver el changelog de la plantilla.

Al pasar a v7: congelar el archivo saliente como `appscripts/vN_fecha.gs`, subir
`SCRIPT_VERSION` en la raíz y agregar la fila arriba.

## Primer despliegue

1. Abrir la planilla de Level → Extensiones → Apps Script.
2. Borrar `Código.gs` y pegar el `apps-script.gs` de la raíz de este repo
   (ya trae el `SPREADSHEET_ID` y las carpetas de Level).
3. Implementar → Aplicación web · *Ejecutar como: Yo* · *Acceso: Cualquier
   usuario*. Autorizar Sheets + Drive + Mail.
4. Pegar la URL resultante en `APPS_SCRIPT_URL` (`proto/sync.jsx`).
5. Crear las hojas: elegir `ensureSheets` en el desplegable de funciones y
   apretar **Run**. Deja las 12 hojas con sus encabezados. La app nunca llama
   esta función por su cuenta.
6. Verificar: `?action=ping` debe responder `version: "v6"`.

Las 12 hojas: `Combustible`, `Electricidad`, `Agua`, `N° de cliente`,
`Fill out`, `Fotos`, `Medidores`, `Lecturas Medidor`, `Precios Medidor`,
`Config Sucursales`, `Emisiones`, `Config`.

`ensureSheets` es idempotente: correrla de nuevo no duplica hojas ni pisa
encabezados o datos existentes. Se puede repetir sin miedo.

En una planilla nueva no hace falta `ensureRecordIds` — `appendRows` le pone ID a
cada fila desde el principio. `?action=inspectRecordIds` sirve igual como chequeo
de solo lectura: debe reportar las tres hojas de registros con la columna ID
libre (Combustible → **K**, Electricidad → **L**, Agua → **M**).

Para verificar el backend sin abrir Google: `node test-apps-script.js` en la raíz
del repo — carga `apps-script.gs` con un `SpreadsheetApp` falso y comprueba las 12
hojas, sus encabezados y la idempotencia.

## Al actualizar el backend

**Desplegar el backend y recargar la app van juntos.** Un cliente con el JS viejo
contra el backend nuevo verá errores al guardar (toast rojo) en vez de perder
datos en silencio — es el comportamiento deseado, pero conviene avisar a quien
tenga la pestaña abierta. Implementar → Administrar implementaciones → editar la
existente → Versión "Nueva versión". La URL no cambia.
