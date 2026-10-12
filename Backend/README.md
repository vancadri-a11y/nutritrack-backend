# Backend NutriTrackAI 5.7

Node.js 20 o posterior, sin dependencias npm. Supabase Auth verifica las sesiones; las operaciones ordinarias de perfiles y comidas usan el JWT del usuario y RLS. Las operaciones administrativas están aisladas en `supabase-admin.mjs`.

Para tu laptop: sigue [ACTUALIZACION_V57.md](../Docs/ACTUALIZACION_V57.md). Deben estar aplicadas las migraciones `001_users_meals.sql` y `002_account_quotas.sql`; en una base que ya tiene 001, ejecuta únicamente 002.

## Variables

`NUTRITRACK_AUTH_MODE=supabase`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `NUTRITRACK_RECOVERY_URL`, `OPENAI_API_KEY` y modelos opcionales. Usa `.env.example` como referencia; conserva las claves únicamente en el servidor.

La clave administrativa `sb_secret_…` o la antigua `service_role` se usa exclusivamente para cuotas y eliminación de identidad/Storage. Los accesos normales a datos siguen usando la publishable key y la sesión individual. Si falta la clave administrativa o la migración, IA y borrado fallan sin invocar al proveedor ni omitir cuotas.

## API de cuentas

Cuerpos JSON y `Cache-Control: no-store`. Las rutas autenticadas requieren `Authorization: Bearer <access_token>`.

- `POST /v1/auth/register`: correo y contraseña, mínimo 12 caracteres; sesión o confirmación por correo.
- `POST /v1/auth/login`: correo y contraseña; sesión individual.
- `POST /v1/auth/refresh`: `{"refresh_token":"…"}`. Guarda ambos tokens nuevos; hay rotación.
- `POST /v1/auth/recover`: `{"email":"…"}`. La redirección procede exclusivamente de `NUTRITRACK_RECOVERY_URL`; mensaje genérico para evitar revelar cuentas.
- `GET /auth/recovery`: página de recuperación con apertura de app y formulario web, sin almacenar credenciales en localStorage.
- `POST /v1/auth/recovery/verify`: `{"token_hash":"…"}`. Verifica exclusivamente el tipo `recovery` con Supabase y devuelve su sesión temporal.
- `PUT /v1/auth/password`: autenticada, `{"password":"…"}`; mínimo 12 caracteres. Supabase actualiza la contraseña. La app vuelve al inicio de sesión.
- `GET /v1/auth/me`: identidad verificada.
- `POST /v1/auth/logout`: revoca la renovación de la sesión actual; la app borra credenciales locales.
- `GET /v1/usage`: autenticada; devuelve `limit`, `used`, `remaining`, `global_remaining`, `resets_at`.
- `DELETE /v1/account`: autenticada, `{"confirmation":"DELETE"}`. Se elimina únicamente el usuario de la sesión. No acepta un ID de otra cuenta.

## API de datos e IA

- `GET /v1/profile` y `PATCH /v1/profile`: perfil propio; campos permitidos `name`, `height_cm`, `weight_kg`, `age`, `goal`, `activity`, `timezone`.
- `GET /v1/meals?limit=50&offset=0`: historial propio, máximo 100 por página.
- `POST /v1/meals`: UUID estable y campos `recorded_at`, `title`, `meal_type`, `origin`, `calories`, `protein`, `carbs`, `fat`, `notes` opcional.
- `DELETE /v1/meals/:id`: comida propia.
- `GET /v1/recipes`: catálogo; no consume cuota de IA.
- `POST /v1/food/analyze`, `/v1/plans/generate`, `/v1/workouts/generate`, `/v1/recipes/improve`: reserva de cuota antes del proveedor. Los contratos se conservan; consulta `../Docs/API_V4.md`.

`user_id` nunca se acepta del cliente: se obtiene de la identidad verificada y RLS agrega aislamiento en PostgreSQL. `HTTP 429` con `error=quota_exhausted` incluye mensaje, cuota y `Retry-After` hasta el siguiente reinicio. Los límites de ráfaga y concurrencia también se conservan; son independientes de las cuotas diarias.

## Persistencia y eliminación

La migración 002 reserva contador global, contador de usuario e identificador de solicitud en una transacción, con orden de bloqueo uniforme. No requiere tareas programadas para el reinicio: cada fecha tiene su contador. Las funciones RPC solo admiten el rol administrativo. El contador global sobrevive al borrado de una cuenta para evitar que eliminarla libere consumo del día.

La reserva cuenta incluso ante error, cancelación o caída del proceso. Los éxitos guardan una respuesta acotada para recuperar la misma solicitud ese día tras un reinicio. Las fotos no se guardan en las tablas de cuota. Para una operación nueva, usa una nueva `Idempotency-Key`. Un duplicado fallido devuelve `409 analysis_failed`, distinto de `analysis_in_progress`; el escáner prepara una clave nueva para el siguiente reintento explícito, sin realizar llamadas automáticas.

Antes de borrar la identidad, se consulta Storage por `owner_id`/`owner` y se eliminan sus archivos mediante la API de Storage, en lotes. Si falla un lote, se conserva la identidad y se puede reintentar. El borrado entre Storage y Auth no es una transacción única: pueden quedar archivos ya eliminados en un intento fallido. Las claves foráneas de perfiles, comidas y consumo usan `ON DELETE CASCADE`.

Si agregas tablas o cargas archivos con una clave administrativa, define explícitamente la relación con `auth.users` y la propiedad de cada archivo. La propiedad de Storage es el criterio de esta implementación; no se vacían buckets compartidos. Revisa los recursos adicionales del proyecto real antes de publicarlo.

Los resultados de idempotencia contienen datos de la respuesta de IA. Puedes borrar reservas de días anteriores sin afectar cuotas de hoy; ver consulta de mantenimiento en la guía. El borrado de cuenta elimina también sus reservas.

## Pruebas

```sh
node --test
```

La prueba de cuotas con PostgreSQL real se activa únicamente con `NUTRITRACK_TEST_DATABASE_URL` apuntando a una base **nueva y desechable**, local, llamada `nutritrack_v57_test`. Nunca la ejecutes contra tu Supabase: crea roles, esquemas y datos de prueba. Consulta `../Docs/VALIDACION_V57.md`.

Documentación de referencia: [claves de Supabase](https://supabase.com/docs/guides/getting-started/api-keys), [plantillas de correo](https://supabase.com/docs/guides/auth/auth-email-templates), [borrado de usuarios](https://supabase.com/docs/guides/auth/managing-user-data).
