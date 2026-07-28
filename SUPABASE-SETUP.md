# Activación de Supabase

La aplicación ya contiene la URL y la clave pública del proyecto. La clave administrativa no debe agregarse a ningún archivo del frontend.

## 1. Crear la base de datos

1. Abre el proyecto `agenda-felix-trujillo` en Supabase.
2. Entra en **SQL Editor** y crea una consulta nueva.
3. Copia y ejecuta todo el contenido de `supabase/schema.sql`.
4. Confirma que la ejecución termine sin errores.

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

## Permisos aplicados

- Todos los usuarios activos pueden consultar todas las citas.
- Los asesores crean citas únicamente a su nombre y no pueden modificarlas.
- Paola Crespo y Patricia Trujillo gestionan todas las citas de Ventas y consultan Arrendamientos en modo lectura.
- La supervisora crea, edita, reasigna y elimina citas de cualquier equipo.
- El administrador gestiona usuarios y tiene control completo sobre las citas.
- Nadie puede consultar la agenda hasta cambiar su contraseña temporal.
