# Activación de Supabase

La aplicación ya contiene la URL y la clave pública del proyecto. La clave administrativa no debe agregarse a ningún archivo del frontend.

## 1. Crear la base de datos

1. Abre el proyecto `agenda-felix-trujillo` en Supabase.
2. Entra en **SQL Editor** y crea una consulta nueva.
3. Copia y ejecuta todo el contenido de `supabase/schema.sql`.
4. Confirma que la ejecución termine sin errores.

### Actualizar un proyecto existente

Si el proyecto ya estaba en funcionamiento antes de incorporar asesores sin acceso, ejecuta una sola vez `supabase/add-external-advisors.sql` desde **SQL Editor**. El script migra los asesores y las citas actuales sin cambiar sus identificadores.

Después, ejecuta una sola vez `supabase/expand-unique-advisor-colors.sql`. Esta segunda migración amplía la paleta a doce colores y reserva un color diferente para cada asesor, incluso cuando esté inactivo. Si encuentra colores repetidos, conserva la asignación más antigua y distribuye automáticamente colores libres. Solo se detiene si existen más de doce asesores.

Finalmente, ejecuta una sola vez `supabase/add-appointment-creators.sql` para que el detalle de cada cita pueda mostrar el nombre del usuario que la creó sin exponer otros datos de su perfil.

Para activar el dashboard en un proyecto existente, ejecuta también `supabase/add-appointment-dashboard.sql` en **SQL Editor**. No requiere nuevas Edge Functions. Las instalaciones nuevas ya incluyen esta función en `supabase/schema.sql`.

Para añadir **Captado**, ejecuta `supabase/add-appointment-capture-source.sql` y después `supabase/require-capture-source-for-commercial-visits.sql` en **SQL Editor**, antes de publicar el formulario actualizado. Si ya ejecutaste el primer archivo, ejecuta únicamente el segundo para ajustar la obligatoriedad a **Visita comercial**. Ninguno modifica las citas existentes. Tras publicar, recarga la aplicación en los dispositivos abiertos: las visitas comerciales nuevas necesitan el medio de captación. Las instalaciones nuevas ya incluyen la regla final en `supabase/schema.sql`.

## 2. Crear el administrador inicial

1. Entra en **Authentication > Users**.
2. Selecciona **Add user > Create new user**.
3. Usa el correo `asesorventasfelixtrujillo@gmail.com`.
4. Escribe una contraseña temporal de al menos 10 caracteres.
5. Activa la opción para marcar el correo como confirmado.
6. Regresa a **SQL Editor** y ejecuta `supabase/bootstrap-admin.sql`.

Yunior Lara quedará como administrador y asesor del equipo de Ventas. En el primer ingreso deberá reemplazar la contraseña temporal.

## 3. Publicar las funciones

En **Edge Functions**, crea y publica estas dos funciones usando los archivos indicados:

- `admin-create-user`: `supabase/functions/admin-create-user/index.ts`
- `change-password`: `supabase/functions/change-password/index.ts`

Después de aplicar `supabase/expand-unique-advisor-colors.sql`, vuelve a desplegar `admin-create-user` para que acepte la paleta ampliada y valide colores ocupados.

Supabase proporciona automáticamente a las funciones `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`. No copies esos valores al HTML ni a `supabase-config.js`.

También se pueden publicar con Supabase CLI:

```powershell
npx supabase login
npx supabase link --project-ref hohqupxxgtldssbvrhlx
npx supabase functions deploy admin-create-user
npx supabase functions deploy change-password
```

## 4. Crear el resto del equipo

Inicia sesión como Yunior y abre **Usuarios**. Crea cada cuenta con una contraseña temporal:

| Nombre | Correo | Rol | Equipo | Color |
|---|---|---|---|---|
| Harold Trujillo | `trujilloharoldfdo@gmail.com` | Asesor | Arrendamientos | Ámbar |
| Cristian Rojas | `asesor789felix@gmail.com` | Asesor | Arrendamientos | Turquesa |
| Paola Crespo | `atencionalcliente@felixtrujillofalla.com` | Asesor | Ventas | Azul |
| Patricia Trujillo | `comercial@felixtrujillofalla.com` | Asesor | Ventas | Violeta |
| Eliana Gómez | `administracion@felixtrujillofalla.com` | Supervisor | Sin equipo | Sin color |

## 5. Activar gestoras de Ventas

Después de crear a Paola y Patricia, ejecuta una sola vez todo el contenido de `supabase/enable-sales-team-appointment-managers.sql` en **SQL Editor**. El script valida sus perfiles antes de activar la capacidad y cancela toda la operación si no son asesoras de Ventas.

## 6. Crear asesores sin acceso

El administrador puede abrir **Usuarios > Asesores sin acceso** y registrar personas que solo necesitan recibir citas. Se solicita nombre, equipo y color; no se crea una cuenta en Authentication ni se requiere correo o contraseña.

Estos asesores pueden activarse o desactivarse desde la misma sección. Al desactivarlos dejan de aparecer en nuevas citas, pero se conserva todo su historial.

La paleta disponible es Ámbar, Turquesa, Azul, Violeta, Coral, Esmeralda, Índigo, Rosa, Naranja, Cian, Lima y Gris pizarra. Los colores asignados aparecen deshabilitados en los formularios y permanecen reservados al desactivar un asesor.

## Permisos aplicados

- Todos los usuarios activos pueden consultar todas las citas.
- Los asesores crean citas únicamente a su nombre y no pueden modificarlas.
- Paola Crespo y Patricia Trujillo gestionan todas las citas de Ventas y consultan Arrendamientos en modo lectura.
- La supervisora crea, edita, reasigna y elimina citas de cualquier equipo.
- El administrador gestiona usuarios y tiene control completo sobre las citas.
- Solo el administrador crea y activa o desactiva asesores sin acceso.
- Nadie puede consultar la agenda hasta cambiar su contraseña temporal.
- Solo el administrador y la supervisora pueden abrir el dashboard y ejecutar su consulta de indicadores. La capacidad de gestionar citas de un equipo no concede acceso al dashboard.

## Dashboard de citas

- Disponible en escritorio y celular para los roles `admin` y `supervisor`.
- Permite seleccionar semana (lunes a domingo) o mes calendario, equipo y asesor.
- Muestra únicamente asesor, equipo, total de citas y citas realizadas; incluye un resumen separado de Arrendamientos y Ventas.
- El total incluye todos los estados, también las canceladas. Las realizadas son únicamente las citas con estado `completed`.
- Se usa la fecha de la cita, no la de creación, y el asesor asignado, no el usuario que la registró.
- Los asesores activos aparecen con cero aunque no tengan citas. Los inactivos aparecen cuando tienen citas en el periodo.
- El equipo se toma del registro de la cita, para respetar el equipo guardado en el historial. Si un asesor tiene citas en ambos equipos, aparece una fila por equipo.
- Los indicadores se calculan en Supabase, sin depender del límite de citas descargadas por la agenda, y se actualizan al recibir cambios de citas en tiempo real.
- Las citas eliminadas definitivamente no forman parte de las estadísticas.
- Los permisos de lectura de la agenda no cambian: todos los usuarios activos siguen consultando las citas. La restricción adicional se aplica a la pestaña y a la función de indicadores.

## Medio de captación de la cita

- **Captado** aparece debajo de **Inmueble o dirección**, con las opciones WhatsApp, Fijo, Finca Raíz, Proppit, Ciencuadras, Facebook e Instagram.
- Es obligatorio al crear una cita con asunto **Visita comercial**, tanto en el formulario como en Supabase. Para los demás asuntos es opcional.
- Se guarda en `appointments.capture_source` y se muestra también en el detalle y al editar.
- Las visitas comerciales antiguas sin medio registrado conservan la compatibilidad: pueden editarse manteniendo el mismo asunto sin completar ese dato.
- Al cambiar otro asunto a **Visita comercial**, hay que seleccionar el medio. Si una visita comercial ya tiene un medio, no puede eliminarse mientras mantenga ese asunto.
- Para otros asuntos puede registrarse, cambiarse o eliminarse el medio. El formulario adapta la validación al cambiar el asunto sin borrar automáticamente la selección.
- No cambia los permisos de creación o edición de citas ni los indicadores del dashboard.

## Buscador de inmuebles SIMI

Para activar el catálogo de solo lectura, sigue **[SIMI-SETUP.md](SIMI-SETUP.md)**. Requiere `supabase/add-simi-property-catalog.sql`, la función `simi-catalog-sync` y la clave guardada como secreto en Supabase. No modifica la web ni SIMI. El buscador solo aparece para **Visita comercial**; los demás asuntos conservan la dirección manual. La actualización periódica es opcional y se configura después de confirmar las cuotas.

Para activar la sincronización reanudable, ejecuta además **`supabase/add-simi-batch-sync.sql`** antes de desplegar la función y la agenda actualizadas. Si el catálogo ya existe, ejecuta únicamente esta nueva migración. Conserva las citas y el catálogo anterior, guarda cada página en una tabla privada y publica solo al completar la descarga. Las instalaciones nuevas ya incluyen la configuración en `supabase/schema.sql`.

Si ya activaste los lotes y una página falla con `SIMI_FORMAT`, el diagnóstico manual sin perder avances requiere **`supabase/add-simi-page-inspection.sql`**, ambos archivos actualizados de la Edge Function y el frontend nuevo. Consulta **SIMI-SETUP.md → Revisar una página detenida**. No publica ni reinicia la carga, y no requiere cambiar secretos.

Para cerrar una carga detenida con un aviso de “sin resultados” y un total publicado verificado independientemente en SIMI, ejecuta después **`supabase/add-simi-confirmed-publication.sql`** y publica la función y el frontend actualizados. El script no publica por sí solo: habilita la validación y confirmación del administrador. Consulta **SIMI-SETUP.md → Publicar la carga guardada**. `schema.sql` ya incluye este ajuste para instalaciones nuevas.

## Pruebas locales
Con Node.js instalado, ejecuta `npm ci` y después `npm test`. Las pruebas comprueban periodos, filtros, acceso por rol, actualización de la interfaz y la función SQL en un PostgreSQL local en memoria. No se conectan al proyecto de Supabase ni modifican datos reales. Las dependencias de pruebas no son necesarias para publicar la aplicación estática.
