# Inmuebles de SIMI en la agenda

El buscador aparece **solo para Visita comercial**. Para los otros asuntos permanece el campo manual y no se hacen búsquedas de catálogo. La dirección manual también funciona en visitas comerciales, incluso si SIMI falla o aún no se ha configurado.

## Qué se consulta y qué no se modifica

- La agenda busca en una copia del catálogo en Supabase, no en SIMI al escribir cada letra.
- Solo la función `simi-catalog-sync` consulta SIMI. Usa exclusivamente **GET**, una URL fija **HTTPS** y rechaza redirecciones. No crea, edita ni elimina datos en SIMI o en la página web.
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

Opcionales: `SIMI_PAGE_SIZE` (por defecto 50, máximo 100) y `SIMI_MAX_PAGES` (por defecto 100, máximo 200). Confirma las cuotas antes de aumentarlos.

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
3. Selecciona **Visita comercial** y pulsa **Actualizar catálogo**.
4. Espera el mensaje con el número de inmuebles.
5. Selecciona equipo, busca un código publicado conocido y comprueba sus datos.
6. Elige el inmueble y guarda una cita de prueba con tus permisos habituales.
7. Reabre la cita y verifica que conserva la descripción, el código y el enlace.
8. Cambia el asunto a otro tipo: el buscador desaparece y la dirección permanece editable.

**Aún hay que probar tu cuenta real**: la documentación tiene inconsistencias de paginación y algunos ejemplos de respuesta están incompletos. El adaptador reconoce `data`, `totalInmuebles` y `totalPagina`, y falla de forma segura si el formato o la paginación no coinciden. No se ha probado con tu clave durante el desarrollo.

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
