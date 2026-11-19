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
- `SIMI_SYNC_TIMEOUT_MS`: por defecto **100000** (100 segundos para la descarga completa), máximo 120000. Evita dejar una descarga ilimitada; si no termina, no se aplica una copia parcial.

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

**Aún hay que probar tu cuenta real**: la documentación tiene inconsistencias de paginación y algunos ejemplos de respuesta están incompletos. El adaptador reconoce `data`, `totalInmuebles` y `totalPagina`, y falla de forma segura si el formato o la paginación no coinciden. No se ha probado con tu clave durante el desarrollo.

### Si ya publicaste la primera versión de la función

Actualiza **los dos archivos** `index.ts` y `simi.mjs` en la función existente y pulsa **Deploy updates**. Mantén desactivado **Verify JWT with legacy secret** solo en `simi-catalog-sync`. No hay que volver a ejecutar SQL ni cambiar tu clave para aplicar esta corrección.

Publica después la nueva versión de la agenda para ver **Probar conexión**. La prueba utiliza GET autenticado: si todavía está desplegada la función antigua, esta lo rechaza sin iniciar una sincronización.

### Diagnóstico seguro de conexión

El mensaje de la agenda incluye un código y, cuando corresponde, la página que falló. En **Edge Functions → simi-catalog-sync → Logs**, los eventos `simi_request_failed` contienen únicamente código, acción, página, estado HTTP y tiempos. No incluyen la clave, encabezados, tokens, respuesta de SIMI ni contactos.

| Código | Qué significa / qué revisar |
|---|---|
| `SIMI_TIMEOUT` | Una consulta no terminó a tiempo. La espera pasó de 15 a 45 segundos por defecto; revisa el tamaño de página y la latencia con soporte. |
| `SIMI_SYNC_TIMEOUT` | La descarga completa agotó su presupuesto de tiempo. No se guardó una copia parcial. |
| `SIMI_TLS` | Falló la validación del certificado TLS. Solicita a SIMI revisar la cadena de certificados; nunca desactives TLS ni uses HTTP con la clave. |
| `SIMI_DNS` | Supabase no pudo resolver el dominio. Consulta si SIMI permite el acceso desde servicios externos. |
| `SIMI_NETWORK` | Falló el transporte. Confirma restricciones por IP/centro de datos con SIMI y revisa sus registros en la hora indicada. |
| `SIMI_REDIRECT` | El servidor redirigió fuera de los destinos HTTPS autorizados o entró en un bucle. No se envió la clave al destino rechazado. |
| `SIMI_AUTH` | SIMI rechazó clave o permisos, incluso si su respuesta HTTP era 200. Confirma el formato original y los permisos con soporte sin compartir la clave. |
| `SIMI_RATE_LIMIT` | Se alcanzó la cuota; no repitas consultas y confirma los límites. |
| `SIMI_FORMAT` | El servidor no entregó el formato de listado esperado. Se necesita confirmar el contrato de la API. |
| `SIMI_HTTP` | El proveedor devolvió otro estado HTTP de error; el diagnóstico indica su número, sin mostrar el cuerpo. |
| `SIMI_UNEXPECTED` | Fallo no clasificado de la función; no se expone el error crudo. |

Que el servicio responda desde un computador **no demuestra** que admita conexiones autenticadas desde Supabase. El diagnóstico distingue esas situaciones; la causa real solo puede confirmarse al volver a probar la función con tu cuenta.

No se solicita el detalle de cada inmueble en una llamada adicional. Si el listado no incluye la dirección exacta, se muestra código, tipo, barrio y ciudad; puedes completar la dirección manualmente. No se toma la dirección de los contactos.

## 5. Actualización periódica (opcional)

Por defecto la sincronización es **manual**. Antes de automatizarla, confirma con SIMI las cuotas y si se comparten con la web.

Para programarla cada seis horas:

1. Activa las extensiones **pg_cron** y **pg_net** en tu proyecto.
2. Genera una contraseña aleatoria de al menos 32 caracteres y guárdala en Edge Function Secrets con nombre `SIMI_SYNC_SECRET`. Es distinta de la clave de SIMI.
3. En **Supabase Vault**, crea `agenda_simi_sync_token` con ese mismo valor y `agenda_simi_sync_url` con la URL HTTPS de la función desplegada.
4. Ejecuta `supabase/schedule-simi-catalog-sync.sql`. El archivo no contiene secretos.
5. Comprueba el resultado de la primera tarea y los registros de la función, sin registrar encabezados ni respuestas completas.

Para detener la tarea:

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'agenda-simi-catalog';
```

Las actualizaciones completas se espacian al menos 15 minutos; los reintentos tras un fallo, al menos un minuto. Un bloqueo evita descargar simultáneamente el catálogo desde distintas sesiones.

## Errores y conservación del historial

- Clave ausente/incorrecta, falta de permisos, cuotas, error de HTTPS, respuesta inesperada, duplicados, descarga parcial o límite de páginas: se conserva el último catálogo completo.
- Un catálogo vacío no desactiva masivamente los inmuebles anteriores; debe revisarse con soporte.
- Solo una descarga completa actualiza y desactiva los códigos ya no publicados.
- No se eliminan registros del catálogo ni se cambian citas históricas al sincronizar.
- La fecha de actualización aparece al buscar: no es una garantía de disponibilidad en tiempo real.
- Editar manualmente el texto desvincula la selección del catálogo; no borra la dirección.
- Al cambiar a un asunto no comercial, se conserva el texto y el modo pasa a manual. Si guardas así, la cita queda sin vínculo SIMI.
