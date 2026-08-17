# Apps Script — CHANGELOG (Level)

Registro de lo que **esta instancia** tiene desplegado. `SCRIPT_VERSION` en
`apps-script.gs` = versión activa, verificable con `?action=ping`.

| Versión | Fecha | Estado |
|---------|-------|--------|
| v5 | 2026-08-17 | Primera y única implementación de Level. |

Level nació sobre la generación **v5** del backend de la plantilla
(`registro-de-consumos-base`), así que su primer despliegue ya es v5: no hay que
pasar por v1…v4. El número identifica **qué código corre**, no cuántas veces se
implementó acá — es lo que permite comparar por `ping` si Level y Base corren el
mismo backend, que es justo lo que importa al portar un arreglo con
`git fetch base`.

Los snapshots `vN_fecha.gs` de la plantilla no se copiaron: eran el historial de
despliegues sobre la planilla de **Base** y llevaban su `SPREADSHEET_ID` adentro,
así que pegar uno por error habría hecho que Level escribiera en la planilla de
otro cliente. Acá empiezan a acumularse recién cuando Level pase a v6: al subir
`SCRIPT_VERSION`, congelar el archivo saliente como `appscripts/vN_fecha.gs` y
agregar su fila arriba. Para el historial anterior a v5, ver el changelog de la
plantilla.

## Primer despliegue

1. Abrir la planilla de Level → Extensiones → Apps Script.
2. Borrar `Código.gs` y pegar el `apps-script.gs` de la raíz de este repo
   (ya trae el `SPREADSHEET_ID` y las carpetas de Level).
3. Correr `ensureSheets()` con el botón Run: crea las 11 hojas con sus
   encabezados. La app **nunca** llama esta acción sola.
4. Implementar → Aplicación web · *Ejecutar como: Yo* · *Acceso: Cualquier
   usuario*. Autorizar Sheets + Drive + Mail.
5. Pegar la URL resultante en `APPS_SCRIPT_URL` (`proto/sync.jsx`).
6. Verificar: `?action=ping` debe responder `version: "v5"`.

En una planilla nueva no hace falta `ensureRecordIds` — `appendRows` le pone ID a
cada fila desde el principio. `?action=inspectRecordIds` sirve igual como chequeo
de solo lectura: debe reportar las tres hojas de registros con la columna ID
libre (Combustible → **K**, Electricidad → **L**, Agua → **M**).

## Al actualizar el backend

**Desplegar el backend y recargar la app van juntos.** Un cliente con el JS viejo
contra el backend nuevo verá errores al guardar (toast rojo) en vez de perder
datos en silencio — es el comportamiento deseado, pero conviene avisar a quien
tenga la pestaña abierta. Implementar → Administrar implementaciones → editar la
existente → Versión "Nueva versión". La URL no cambia.
