# Inmuebles de SIMI en la agenda

El buscador aparece **solo para Visita comercial**. Para los otros asuntos permanece el campo manual y no se hacen búsquedas de catálogo. La dirección manual también funciona en visitas comerciales, incluso si SIMI falla o aún no se ha configurado.

## Qué se consulta y qué no se modifica

- La agenda busca en una copia del catálogo en Supabase, no en SIMI al escribir cada letra.
- Solo la función `simi-catalog-sync` consulta SIMI. Usa exclusivamente **GET** y **HTTPS**. Solo admite redirecciones de la misma ruta entre `simi-api.com` y `www.simi-api.com`; rechaza HTTP, otros dominios, puertos y destinos. No crea, edita ni elimina datos en SIMI o en la página web.
- Solo el administrador puede actualizar el catálogo manualmente. Los demás usuarios activos pueden buscar para visitas comerciales.
- No se importan propietarios, clientes, documentos, teléfonos ni contactos de asesores. Solo código, tipo, barrio, ciudad, dirección propia del inmueble si se entrega, operación y enlace a la publicación.
- La clave no está en el frontend ni en GitHub. No la pegues en conversaciones, archivos SQL, capturas ni ejemplos de código.
- La existencia del acceso de lectura **no confirma** los permisos totales de la clave: conviene que SIMI confirme que es exclusiva y de solo lectura, así como sus cuotas.

## 1. Base de datos

En **Supabase → SQL Editor**, ejecuta `supabase/add-simi-property-catalog.sql`. No vuelvas a ejecutar todos los scripts anteriores. Las instalaciones nuevas incluyen esta configuración en `supabase/schema.sql`.

Se crean el catálogo, el control de sincronización y la búsqueda autorizada. Se añaden dos campos opcionales a las citas para conservar el código y enlace elegidos; las citas actuales no se modifican.

**Para la carga por lotes en un proyecto existente**, ejecuta después **`supabase/add-simi-batch-sync.sql`**. Si el catálogo ya estaba activado, ejecuta únicamente este segundo archivo. Añade una tabla privada de descarga temporal y un cursor durable sin cambiar el catálogo publicado ni las citas. `supabase/schema.sql` ya incluye ambos pasos para instalaciones nuevas.

## 2. Guardar la clave sin compartirla

En **Supabase → Edge Functions → Secrets**, crea:

| Nombre | Valor |
|---|---|
| `SIMI_API_KEY` | El código largo que SIMI te entregó, sin añadir `Basic`, sin codificarlo y sin comillas. |
| `SIMI_AGENCY_ID` | `459` para Félix Trujillo Falla. |

La documentación pública usa `Authorization: Basic base64("Authorization:" + token)`. La función hace esa codificación automáticamente. Si SIMI te entregó un encabezado ya formado o credenciales diferentes, consulta primero su formato; no pruebes variaciones publicando la clave.

Opcionales:

- `SIMI_PAGE_SIZE`: por defecto **20**, máximo 100. Las páginas son más pequeñas para reducir el tiempo de respuesta. Aumentar o reducir este valor cambia el número total de consultas.
- `SIMI_MAX_PAGES`: por defecto 100, máximo 200.
- `SIMI_REQUEST_TIMEOUT_MS`: por defecto **45000** (45 segundos), máximo 60000.
- `SIMI_SYNC_TIMEOUT_MS`: por defecto **100000**, máximo 120000. Es un techo adicional por ejecución, no un límite para toda la descarga reanudable.
- `SIMI_BATCH_PAGES`: por defecto **5**, entre 1 y 10 páginas por ejecución.
- `SIMI_BATCH_TIMEOUT_MS`: por defecto **60000**, máximo 80000. Si no queda margen para otra página, el lote termina con el cursor guardado en lugar de perder todo el trabajo.

Confirma las cuotas antes de cambiar estos límites. No hay reintentos automáticos tras errores de red, autenticación o cuota.

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` son secretos internos proporcionados por Supabase; nunca se copian al frontend.

## 3. Publicar la función

Desde el proyecto, con Supabase CLI configurada:

```powershell
npx supabase functions deploy simi-catalog-sync --no-verify-jwt
```

`supabase/config.toml` configura el mismo comportamiento. La función **no es pública sin protección**: comprueba la sesión mediante `auth.getUser`, el rol administrador activo y la contraseña cambiada antes de sincronizar. La comprobación JWT del gateway se desactiva para admitir también el programador protegido con un secreto independiente.

Si despliegas desde el editor del panel, incluye **ambos archivos** de `supabase/functions/simi-catalog-sync/`: `index.ts` y `simi.mjs`. Desactiva la verificación JWT del gateway solo para esta función; no para las funciones existentes.

## 4. Primera carga y comprobación

1. Publica la aplicación actualizada y recarga la página.
2. Inicia sesión como administrador y abre **Nueva cita**.
3. Selecciona **Visita comercial**.
4. Antes de la primera sincronización, puedes pulsar **Probar conexión**: hace una sola consulta de un inmueble, no guarda datos ni reemplaza el catálogo. Si funciona, pulsa **Actualizar catálogo** y espera el mensaje con el número de inmuebles.
5. Selecciona equipo, busca un código publicado conocido y comprueba sus datos.
6. Elige el inmueble y guarda una cita de prueba con tus permisos habituales.
7. Reabre la cita y verifica que conserva la descripción, el código y el enlace.
8. Cambia el asunto a otro tipo: el buscador desaparece y la dirección permanece editable.

**Aún hay que probar tu cuenta real**: la documentación tiene inconsistencias de paginación y algunos ejemplos de respuesta están incompletos. El adaptador normaliza colecciones `data`, `Inmuebles` o `inmuebles`, arrays directos, objetos indexados de PHP y envoltorios de respuesta limitados. Conserva y valida los metadatos `totalInmuebles`, `totalPagina` y sus variantes explícitas. No se ha probado con tu clave durante el desarrollo.

### Si ya publicaste la primera versión de la función

Para pasar de descarga única a lotes, sigue **este orden**:

1. Ejecuta **`supabase/add-simi-batch-sync.sql`** una vez en SQL Editor.
2. Actualiza completos **`index.ts` y `simi.mjs`** en la función existente y pulsa **Deploy updates**. Mantén desactivado **Verify JWT with legacy secret** solo en `simi-catalog-sync`.
3. Publica también la agenda actualizada (`index.html` y `property-picker.js`, junto con el resto del proyecto). Recarga la aplicación.
4. Entra como administrador, selecciona **Visita comercial** y pulsa **Actualizar catálogo**.

Los clientes anteriores reciben `SIMI_CLIENT_UPDATE` y no empiezan otra descarga completa. Las funciones SQL antiguas de publicación completa quedan deshabilitadas para evitar que se mezclen dos métodos. No ejecutes otra vez el script base del catálogo después del script de lotes.

### Corrección de `DELETE requires a WHERE clause`

Si la agenda muestra `SIMI_SAVE: No se pudo reservar el lote` y los registros de PostgreSQL muestran `DELETE requires a WHERE clause`, la protección de Supabase bloqueó la limpieza temporal sin filtro de la primera versión por lotes.

1. En **Supabase → SQL Editor → New query**, copia todo **`supabase/fix-simi-batch-staging-cleanup.sql`** y pulsa **Run**.
2. Espera **Success. No rows returned**. Si aparece un error, detente y revisa ese mensaje.
3. Regresa a la agenda como administrador → **Nueva cita → Visita comercial → Actualizar catálogo**.

Este ajuste solo reemplaza la función de reserva; no descarga datos ni reinicia trabajos al ejecutarlo. Conserva el avance, el catálogo publicado y las citas, y mantiene la protección de Supabase activada. No requiere cambiar secretos, volver a desplegar la Edge Function ni publicar el frontend. La migración de lotes y el esquema de instalaciones nuevas ya incluyen la corrección.

### Pausar, continuar y reiniciar

- La interfaz muestra cuántos inmuebles y páginas están confirmados en Supabase.
- Encadena hasta 20 lotes con avance por clic; no son consultas de espera ni reintentos de un error. Si alcanza ese límite, muestra **Continuar carga**.
- **Pausar después del lote** termina la cadena de esta pestaña. El lote actual confirma sus páginas y después se detiene.
- Cerrar el diálogo, cambiar a un asunto no comercial o cerrar sesión impide iniciar más lotes desde esa pestaña. La página en curso puede terminar y quedar guardada en el servidor.
- Al volver a pulsar **Actualizar catálogo / Continuar carga**, el servidor retoma desde la siguiente página guardada, incluso desde otro dispositivo. El navegador nunca decide el cursor.
- Tras un fallo de red o tiempo de espera, se conservan las páginas confirmadas y se espera al menos un minuto antes de reintentar.
- Si SIMI cambia los totales, repite códigos o entrega datos inválidos, la carga se detiene. Para `SIMI_FORMAT`, usa primero **Revisar página fallida** sin borrar el avance. Cuando proceda reiniciar, **Reiniciar carga parcial** exige confirmación y solo descarta los registros temporales de ese trabajo; no vacía el catálogo visible ni cambia citas.
- Un trabajo con más de 24 horas o con cambio de agencia exige reinicio para no mezclar inventarios de momentos o cuentas diferentes.
- La publicación final y la retirada de códigos ausentes se hacen en una sola transacción al confirmar la última página. Si falla, sigue disponible el catálogo anterior.
- **La descarga antigua que falló en la página 22 no guardaba páginas**: no es posible recuperarlas retroactivamente. La primera carga con esta versión empieza en la página 1; las siguientes interrupciones sí se reanudan.
- Si hay un programador o un segundo administrador trabajando, pausar una pestaña no los detiene. El bloqueo evita trabajos simultáneos y todos continúan el mismo cursor.

### Revisar una página detenida por `SIMI_FORMAT` sin perder el avance

Si quedaron páginas guardadas y SIMI devuelve texto en la siguiente, **no pulses Reiniciar carga parcial** todavía. Una página corta o un texto de “sin resultados” no demuestra por sí solo que el catálogo esté completo, especialmente sin totales del proveedor.

Para habilitar el diagnóstico en un proyecto existente:

1. Ejecuta completo **`supabase/add-simi-page-inspection.sql`** en **SQL Editor → New query**. Solo añade una función de reserva: no reinicia el trabajo, no consulta SIMI ni modifica páginas guardadas.
2. Reemplaza completos **`index.ts` y `simi.mjs`** en la Edge Function y pulsa **Deploy updates**. Conserva los secretos y la configuración JWT actuales.
3. Publica el frontend actualizado y recarga la agenda.
4. Como administrador, abre **Nueva cita → Visita comercial → Actualizar catálogo** para recuperar el estado fallido; después pulsa **Revisar página fallida** una sola vez.

El diagnóstico consulta únicamente la página del cursor guardado, con el mismo tamaño de página y agencia originales. No acepta una página elegida por el navegador. Comparte el bloqueo con las otras acciones, permite una revisión por minuto y no ejecuta reintentos automáticos. Los trabajos de más de 24 horas o de otra agencia no se consultan para evitar validar una copia antigua.

La respuesta muestra solo tipos, números y categorías predefinidas:

- `no_results_notice`: frase completa reconocida como aviso de “sin resultados”; **no confirma** que sea el final oficial del inventario.
- `auth_notice` / `rate_limit_notice`: aviso relacionado con autenticación o cuota; confirmar con soporte.
- `empty_text` / `html_document` / `unknown_text` / `unrecognized_format`: respuesta vacía, HTML, texto desconocido o formato no reconocido.
- `valid_list` / `empty_list`: en esta revisión SIMI entregó una lista válida o vacía.

Ninguna categoría publica ni reanuda automáticamente la descarga. El trabajo sigue detenido, conserva sus registros temporales y el catálogo anterior permanece visible. Comparte únicamente el diagnóstico mostrado, nunca el cuerpo original de SIMI, contactos, claves o encabezados. Según el resultado se decidirá con soporte cómo validar el final o la reanudación sin borrar el avance.

Este diagnóstico exige una sesión de administrador activo y no está permitido al programador. La migración de lotes y `schema.sql` ya lo incluyen para instalaciones nuevas.

### Formatos de respuesta admitidos

- Se aceptan arrays y objetos PHP solo cuando contienen registros con códigos de inmueble reconocibles; no se importan arrays arbitrarios de contactos.
- Un acuse como `{code:0,response:true}`, un objeto vacío o la respuesta de detalle de un solo inmueble no se confunden con un catálogo.
- Los indicadores explícitos de error se rechazan aunque incluyan datos. Los errores sin estado numérico de autenticación identificado se muestran como `SIMI_REJECTED`, sin afirmar que la clave sea válida o inválida.
- Los contadores inválidos, contradictorios o que correspondan a otra página bloquean la actualización. Las descargas parciales no reemplazan el catálogo.
- Los errores de formato incluyen un resumen **solo de tipos**, por ejemplo `raíz=object, data=object`. Se muestran nombres de campos de una lista fija, nunca nombres desconocidos, valores, claves, códigos de inmuebles o contactos.
- No se cambian automáticamente la versión del endpoint ni el método de autenticación, y no se hacen consultas extra para adivinar formatos.

Tras desplegar, pulsa **Probar conexión** una vez. Si persiste el error, comparte el mensaje o el campo `response_shape` del evento `simi_request_failed`, no la respuesta original de SIMI. El resumen permite confirmar qué parte del contrato necesita revisión; no demuestra por sí solo que el acceso autenticado haya sido aceptado.

### Diagnóstico seguro de conexión

El mensaje de la agenda incluye un código y, cuando corresponde, la página que falló. En **Edge Functions → simi-catalog-sync → Logs**, los eventos `simi_request_failed` contienen código, acción, página, estado HTTP, tiempos y un resumen de tipos de respuesta cuando hay un error de formato. No incluyen la clave, encabezados, tokens, respuesta original de SIMI ni contactos.

| Código | Qué significa / qué revisar |
|---|---|
| `SIMI_TIMEOUT` | Una consulta no terminó a tiempo. La espera pasó de 15 a 45 segundos por defecto; revisa el tamaño de página y la latencia con soporte. |
| `SIMI_SYNC_TIMEOUT` | El lote agotó su tiempo. Las páginas ya confirmadas quedan guardadas; puedes continuar desde la siguiente sin reemplazar el catálogo anterior. |
| `SIMI_TLS` | Falló la validación del certificado TLS. Solicita a SIMI revisar la cadena de certificados; nunca desactives TLS ni uses HTTP con la clave. |
| `SIMI_DNS` | Supabase no pudo resolver el dominio. Consulta si SIMI permite el acceso desde servicios externos. |
| `SIMI_NETWORK` | Falló el transporte. Confirma restricciones por IP/centro de datos con SIMI y revisa sus registros en la hora indicada. |
| `SIMI_REDIRECT` | El servidor redirigió fuera de los destinos HTTPS autorizados o entró en un bucle. No se envió la clave al destino rechazado. |
| `SIMI_AUTH` | SIMI rechazó clave o permisos, incluso si su respuesta HTTP era 200. Confirma el formato original y los permisos con soporte sin compartir la clave. |
| `SIMI_RATE_LIMIT` | Se alcanzó la cuota; no repitas consultas y confirma los límites. |
| `SIMI_FORMAT` | El servidor no entregó el formato de listado esperado. Se necesita confirmar el contrato de la API. |
| `SIMI_REJECTED` | SIMI indicó un error en el JSON. La respuesta no se interpreta como listado ni como catálogo vacío. |
| `SIMI_HTTP` | El proveedor devolvió otro estado HTTP de error; el diagnóstico indica su número, sin mostrar el cuerpo. |
| `SIMI_UNEXPECTED` | Fallo no clasificado de la función; no se expone el error crudo. |
| `SIMI_BATCH_MIGRATION` | Falta aplicar la migración de carga por lotes. |
| `SIMI_CLIENT_UPDATE` | Hay que publicar o recargar la agenda con el protocolo por lotes. |
| `SIMI_BATCH_BUSY` | Otra ejecución tiene el bloqueo, o aún no pasó el minuto de espera después de un fallo. |
| `SIMI_JOB_FAILED` | La descarga parcial está detenida; si el error guardado es `SIMI_FORMAT`, revisa primero la página fallida. Otros fallos pueden exigir reinicio confirmado. El catálogo visible se conserva. |
| `SIMI_INSPECTION_MIGRATION` | Falta ejecutar `supabase/add-simi-page-inspection.sql` para revisar la página fallida. |
| `SIMI_INSPECTION_UNAVAILABLE` | El trabajo no está detenido por formato; no se consulta ninguna página. |
| `SIMI_JOB_EXPIRED` | El trabajo tiene más de 24 horas o corresponde a otra agencia. No se valida como inventario actual. |

Que el servicio responda desde un computador **no demuestra** que admita conexiones autenticadas desde Supabase. El diagnóstico distingue esas situaciones; la causa real solo puede confirmarse al volver a probar la función con tu cuenta.

No se solicita el detalle de cada inmueble en una llamada adicional. Si el listado no incluye la dirección exacta, se muestra código, tipo, barrio y ciudad; puedes completar la dirección manualmente. No se toma la dirección de los contactos.

## 5. Actualización periódica (opcional)

Por defecto la sincronización es **manual**. Antes de automatizarla, confirma con SIMI las cuotas y si se comparten con la web.

Para iniciar una actualización cada seis horas y continuar los lotes pendientes:

1. Activa las extensiones **pg_cron** y **pg_net** en tu proyecto.
2. Genera una contraseña aleatoria de al menos 32 caracteres y guárdala en Edge Function Secrets con nombre `SIMI_SYNC_SECRET`. Es distinta de la clave de SIMI.
3. En **Supabase Vault**, crea `agenda_simi_sync_token` con ese mismo valor y `agenda_simi_sync_url` con la URL HTTPS de la función desplegada.
4. Ejecuta `supabase/schedule-simi-catalog-sync.sql` **después de la migración y del despliegue por lotes**. El archivo no contiene secretos. Si tenías el programador anterior, vuelve a ejecutar este archivo para reemplazarlo.
5. Comprueba el resultado de la primera tarea y los registros de la función, sin registrar encabezados ni respuestas completas.

Para detener la tarea:

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'agenda-simi-catalog';
```

La tarea comprueba el estado en la base de datos cada minuto, pero solo invoca la función si hay trabajo pendiente o han pasado seis horas desde la última publicación. No consulta SIMI durante las comprobaciones inactivas. Cada invocación procesa un lote; un trabajo fallido no se reinicia automáticamente.

Las actualizaciones manuales completas se espacian al menos 15 minutos; los reintentos tras un fallo, al menos un minuto. Los lotes consecutivos con avance no tienen esa espera adicional. Un bloqueo evita descargar simultáneamente el catálogo desde distintas sesiones. No se publican la tabla temporal ni los tokens de reserva al navegador.

## Errores y conservación del historial

- Clave ausente/incorrecta, falta de permisos, cuotas, error de HTTPS, respuesta inesperada, duplicados, descarga parcial o límite de páginas: se conserva el último catálogo completo.
- Un catálogo vacío no desactiva masivamente los inmuebles anteriores; debe revisarse con soporte.
- Solo una descarga completa actualiza y desactiva los códigos ya no publicados.
- No se eliminan registros del catálogo ni se cambian citas históricas al sincronizar.
- La fecha de actualización aparece al buscar: no es una garantía de disponibilidad en tiempo real.
- Editar manualmente el texto desvincula la selección del catálogo; no borra la dirección.
- Al cambiar a un asunto no comercial, se conserva el texto y el modo pasa a manual. Si guardas así, la cita queda sin vínculo SIMI.
