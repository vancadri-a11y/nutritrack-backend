# Actualizar NutriTrackAI a 5.7

Esta guía usa tu usuario `vanc`, servidor `192.168.100.90`, puerto local `8787` y dirección privada `https://local-datapps.tail70fd4e.ts.net`. Si tu IP cambió, reemplázala en los comandos de SSH y SCP. Los pasos de Mac y Ubuntu están separados.

No hace falta comprar un dominio para probar esta versión en tu red Tailscale. La dirección actual es privada: para lanzar al público necesitarás una dirección HTTPS accesible sin Tailscale y cambiar la configuración de app, servidor y Supabase.

## 1. Preparar Supabase

Abre tu proyecto de Supabase → **SQL Editor**.

1. Si ya existen las tablas `public.profiles` y `public.meals` de nuestra migración 001, no repitas 001. En una base nueva, ejecuta primero `Backend/migrations/001_users_meals.sql`.
2. Abre `Backend/migrations/002_account_quotas.sql`, copia su contenido completo y ejecútalo **una sola vez**. Debe finalizar correctamente. Si se informa un error, no sigas con el cambio del backend hasta resolverlo.
3. Confirma los límites:

```sql
select user_daily_limit, global_daily_limit, timezone
from public.ai_quota_settings;
```

Debe mostrar `5`, `200`, `America/Mazatlan`. Para cambiarlos posteriormente:

```sql
update public.ai_quota_settings
set user_daily_limit = 5,
    global_daily_limit = 200,
    timezone = 'America/Mazatlan'
where singleton = true;
```

Las cuotas se reinician por fecha a medianoche de esa zona horaria. Se comparten entre todas las funciones de IA. No limitan un importe de dinero exacto: un uso es una solicitud reservada y un análisis puede incluir un reintento interno del modelo.

**No ejecutes archivos de pruebas en el SQL Editor de tu proyecto real.**

## 2. Obtener la clave administrativa

En Supabase → **Project Settings → API Keys**, copia una clave secreta de servidor, normalmente `sb_secret_…`. Si tu proyecto solo ofrece claves antiguas, la alternativa es `service_role`, que suele comenzar con `eyJ…`.

Se colocará en `SUPABASE_SECRET_KEY` en Ubuntu. La clave que ya usabas en `SUPABASE_PUBLISHABLE_KEY` se conserva en su propia variable. Son distintas. Nunca pongas la clave secreta en Xcode, la app, el ZIP ni una captura.

## 3. Configurar el correo de recuperación

Primero configura y guarda SMTP en **Authentication → Emails → SMTP Settings**; la edición de plantillas puede estar bloqueada hasta completar ese paso.

En **Authentication → URL Configuration**, cambia **Site URL** para que la confirmación de registro ya no apunte a Render:

```text
https://local-datapps.tail70fd4e.ts.net/auth/confirmed
```

Añade a **Redirect URLs** estas dos direcciones exactas:

```text
https://local-datapps.tail70fd4e.ts.net/auth/confirmed
https://local-datapps.tail70fd4e.ts.net/auth/recovery
```

En **Authentication → Emails → Reset password**, usa un enlace con hash de recuperación:

```html
<h2>Restablecer tu contraseña de NutriTrackAI</h2>
<p>Si solicitaste este cambio, abre el siguiente enlace:</p>
<p><a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">Cambiar contraseña</a></p>
<p>Si no lo solicitaste, puedes ignorar este correo.</p>
```

El servidor suministra `RedirectTo`; la verificación de un enlace se hace cuando eliges guardar la contraseña o abrirlo en la app. La página ofrece **Abrir NutriTrackAI** y un formulario web de respaldo. Esta configuración evita depender de que el correo pueda abrir directamente un esquema privado de iOS.

Mantén activada la confirmación por correo. Para enviar correos a usuarios reales configura **SMTP propio** en Supabase; el servicio de correo predeterminado tiene restricciones. Conserva tu plantilla de confirmación existente: la plantilla que se cambia aquí es **Reset Password**. [Referencia oficial sobre plantillas](https://supabase.com/docs/guides/auth/auth-email-templates).

Mientras uses la dirección privada, el dispositivo que abre el enlace debe tener acceso a tu Tailscale. Si el correo o enlace caduca, solicita uno nuevo desde la app.

## 4. Copiar el backend nuevo desde la Mac

Descomprime `NutriTrackAI5.7_completo.zip` en el Escritorio. Abre una terminal **local de la Mac**, no la sesión SSH, y ejecuta:

```sh
cd "$HOME/Desktop/NutriTrackAI5.7"
ssh vanc@192.168.100.90 'mkdir -p /home/vanc/nutritrack-server/app-v57'
scp -r Backend Shared vanc@192.168.100.90:/home/vanc/nutritrack-server/app-v57/
```

Si descomprimiste en otra carpeta, cambia solo el `cd` a esa ubicación. No copies las carpetas dentro de otra copia de Backend. En Ubuntu, la estructura debe quedar `app-v57/Backend/server.mjs` y `app-v57/Shared/recipes.json`.

El ZIP `NutriTrackAI5.7_backend.zip` también contiene estas dos carpetas dentro de `NutriTrackAI5.7` y sirve para el mismo paso. Si ya existe `app-v57` de un intento anterior, verifica su contenido antes de reutilizarla.

## 5. Preparar las variables en Ubuntu

Conéctate desde la Mac:

```sh
ssh vanc@192.168.100.90
```

Ya **dentro de Ubuntu**:

```sh
cd /home/vanc/nutritrack-server
cp -p .env ".env-backup-$(date +%Y%m%d-%H%M%S)"
chmod 600 .env .env-backup-*
nano .env
```

Conserva tu URL y claves actuales. Añade o modifica estas líneas, con **una sola definición por variable**:

```dotenv
NUTRITRACK_AUTH_MODE=supabase
SUPABASE_SECRET_KEY=PEGA_AQUI_TU_CLAVE_SECRETA
NUTRITRACK_RECOVERY_URL=https://local-datapps.tail70fd4e.ts.net/auth/recovery
```

Mantén `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `OPENAI_API_KEY` y tus modelos. Guarda con **Control + O**, Enter y sal con **Control + X**. No escribas literalmente `PEGA_AQUI_TU_CLAVE_SECRETA`.

## 6. Probar antes de reemplazar la versión actual

En Ubuntu, en `/home/vanc/nutritrack-server`:

```sh
sudo docker run --rm --env-file .env \
  --mount type=bind,source="$PWD/app-v57",target=/app,readonly \
  --workdir /app/Backend node:24-bookworm-slim node --test
```

Se esperan **80 pruebas aprobadas y 1 omitida**. La omitida requiere una base PostgreSQL desechable; no se conecta a Supabase. Estas pruebas no gastan OpenAI. Si alguna falla, conserva la versión actual y revisa el mensaje antes de avanzar.

## 7. Activar la versión nueva

La configuración existente de Compose debe montar `./app:/app:ro`. Hay una copia de referencia en `Deployment/compose.yaml`; no necesitas sustituir una configuración existente que ya funciona.

Ejecuta en Ubuntu, siguiendo el orden:

```sh
sudo docker compose stop backend
mv app "app-before-5.7-$(date +%Y%m%d-%H%M%S)"
mv app-v57 app
sudo docker compose up -d --force-recreate backend
curl -i http://127.0.0.1:8787/health
sudo docker compose logs --tail=40 backend
```

Si uno de los `mv` falla, resuélvelo antes de ejecutar los comandos siguientes. Guarda la carpeta `app-before-5.7-…`: permite volver a tu código anterior.

Health debe devolver **200** y `"version":"5.7"`, `"auth":"supabase"`. Health solo comprueba que el servidor responde; la cuota y el borrado requieren además migración y clave administrativa correctas.

Comprueba también el proxy HTTPS:

```sh
sudo tailscale serve status
```

Si no aparece el proxy, actívalo:

```sh
sudo tailscale serve --bg http://127.0.0.1:8787
```

Desde un dispositivo conectado a tu Tailscale, abre:

```text
https://local-datapps.tail70fd4e.ts.net/health
https://local-datapps.tail70fd4e.ts.net/auth/recovery
```

La segunda dirección sin el token mostrará que hace falta un enlace válido; eso es correcto.

## 8. Instalar la app 5.7 y probar con una cuenta desechable

En la Mac, abre `NutriTrackAI.xcodeproj`, conserva el equipo de firma y Bundle IDs de tu aplicación y ejecútala en el iPhone. Activa Tailscale en el iPhone para acceder a la dirección privada.

1. Crea una cuenta de prueba y confirma el correo. No uses tu cuenta principal para verificar el borrado.
2. Inicia sesión. En **Perfil → Mi cuenta** comprueba que aparezcan 5 usos disponibles.
3. Analiza y guarda una foto de comida. En **Comidas**, ábrela: aparece su foto; tócala para ampliarla y usa el gesto de zoom.
4. Confirma que la cuota baje. Generar un plan o adaptar una receta utiliza la misma cuota. Estas pruebas de IA reales sí consumen tu cuenta de OpenAI.
5. Cierra sesión; escribe el correo y pulsa **¿Olvidaste tu contraseña?**. Abre el correo, toca **Cambiar contraseña → Abrir NutriTrackAI**, escribe la nueva contraseña dos veces y guarda. Inicia sesión con la nueva; la anterior debe fallar. Prueba también el formulario web con un segundo enlace nuevo.
6. Verifica que un enlace ya utilizado o vencido no permita reutilizar la recuperación.
7. Con la cuenta desechable, registra datos y pulsa **Eliminar mi cuenta**, escribe `ELIMINAR` y confirma. Comprueba que no pueda volver a iniciar sesión y que sus datos y fotos ya no aparezcan. Las otras cuentas deben conservarse.
8. En Supabase confirma que desaparezca de **Authentication → Users** y que ya no existan filas con su `user_id` en perfiles, comidas, consumo y reservas.

El límite global se probó con una base PostgreSQL local y solicitudes simultáneas. Para probar agotamiento sin hacer 200 llamadas pagadas, en un proyecto de pruebas puedes bajar temporalmente los límites a 1 por cuenta y 2 globales, probar y devolverlos a 5/200. No hagas esa modificación en un proyecto que ya tenga usuarios activos sin planificarla.

## 9. Datos, archivos y mantenimiento

En el esquema incluido, perfiles, comidas, consumo y reservas pertenecen a `auth.users` con `ON DELETE CASCADE`. La app conserva fotos e historial localmente; no añade subida automática a Storage. Si ya hay objetos de Storage con propiedad de esa cuenta, se borran mediante la API antes de eliminar Auth. [Supabase requiere eliminar los objetos antes de borrar su propietario](https://supabase.com/docs/guides/auth/managing-user-data).

Antes de publicar, revisa también cualquier tabla o bucket adicional que hayas creado fuera de estas migraciones. Los archivos subidos con una clave administrativa necesitan una relación de propiedad explícita; no se atribuyen automáticamente a un usuario.

Puedes revisar las claves foráneas que apuntan a las identidades:

```sql
select conrelid::regclass as tabla, conname,
       pg_get_constraintdef(oid) as relacion
from pg_constraint
where contype = 'f' and confrelid = 'auth.users'::regclass;
```

Las reservas guardan respuestas de IA para reintentos del mismo día. Para limitar su retención, ejecuta periódicamente en Supabase:

```sql
delete from public.ai_reservations
where day < (now() at time zone 'America/Mazatlan')::date;
```

Esto no borra los contadores diarios. No necesitas esta consulta para reiniciar cuotas. Las fotos no se almacenan en las tablas de cuotas.

## 10. Al pasar al público

Esta entrega no publica la app ni cambia tu servidor remoto. Para una URL pública, actualiza:

- `NutriTrackAI/Services/AIConnectionStore.swift` → `defaultAddress`: la raíz HTTPS pública, sin `/health` ni otras rutas.
- `.env` de Ubuntu → `NUTRITRACK_RECOVERY_URL`: esa raíz más `/auth/recovery`; recrea el contenedor.
- Supabase → **Redirect URLs**: añade la dirección de recuperación pública exacta y prueba un correo nuevo.

La migración automática de la app cambia la antigua dirección Render conocida y la dirección mal escrita `local-dataapps.tail70fd4e.ts.net` por la dirección correcta de 5.7: `local-datapps.tail70fd4e.ts.net`. Conserva las direcciones personalizadas. Si ya instalaste una compilación que guardó tu dirección privada y luego cambias a una pública, deberás actualizar también esa preferencia guardada con una migración específica de la siguiente compilación; cambiar solo el valor predeterminado no reemplaza una dirección guardada.

Para disponibilidad, la laptop debe permanecer encendida, conectada a Internet y sin suspensión. Docker reinicia el backend, pero no puede atender solicitudes con la laptop apagada. Tras un reinicio, verifica tanto Docker como Tailscale y `/health`.
