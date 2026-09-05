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
