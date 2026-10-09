# NutriTrackAI — backend multiusuario

Node.js 20+; Supabase Auth; PostgreSQL mediante PostgREST con RLS; claves de OpenAI solo en el servidor.

## Activar

1. Crear un proyecto de Supabase. Guardar la contraseña de la base fuera del repositorio.
2. Ejecutar `migrations/001_users_meals.sql` en el SQL Editor del proyecto nuevo. No ejecutar `tests/rls.sql` allí: ese archivo crea un entorno de pruebas desechable.
3. En Authentication, activar correo y contraseña, mantener la confirmación por correo y configurar SMTP para usuarios reales. Configurar la URL de confirmación y recuperación. El correo de recuperación requiere una página o deep link que permita establecer la nueva contraseña; ese flujo de UI aún no está implementado aquí.
4. En Render configurar un Web Service con Node, directorio raíz `NutriTrackAI5.0`, Build Command `cd Backend && npm test`, Start Command `node Backend/server.mjs`, Health Check `/health`. Incluir `Shared/recipes.json`: el backend lo carga al arrancar.
5. Configurar las variables de `.env.example` en Render: `NUTRITRACK_AUTH_MODE=supabase`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` y `OPENAI_API_KEY`. La publishable key identifica el proyecto; el JWT individual controla el acceso a los datos. No usar secret/service_role: el backend conserva RLS al llamar a la base.
6. Usar una instancia de Render que no duerma para usuarios reales. Comenzar con una instancia: límites y caché de IA viven en memoria; para varias réplicas hace falta un limitador compartido y cuotas persistentes.
7. Si cambia la URL pública de Render, actualizar `AIConnectionStore.defaultAddress` antes de compilar la app. El usuario final no configura servidor ni claves.
8. Ejecutar pruebas con dos cuentas reales: registro, correo de confirmación, login, renovación, perfil, guardar/listar/borrar comidas, acceso cruzado denegado e IA. Las pruebas locales no reemplazan esta validación del servicio desplegado.

No se necesita publicar las claves de OpenAI ni generar una por usuario. Configuras tu clave una vez en el servidor; el backend paga las llamadas con esa cuenta. Los access/refresh tokens son sesiones individuales emitidas por Supabase, nunca claves del proveedor.

## API

Todas las respuestas tienen `Cache-Control: no-store`. Autenticación de datos e IA: `Authorization: Bearer <access_token>`. Cuerpos JSON.

- `POST /v1/auth/register`: `{ "email": "...", "password": "..." }`, mínimo 12 caracteres. Devuelve sesión o `confirmation_required`.
- `POST /v1/auth/login`: correo y contraseña. Devuelve `access_token`, `refresh_token`, `expires_in`, usuario.
- `POST /v1/auth/refresh`: `{ "refresh_token": "..." }`. Guardar ambos tokens nuevos; el refresh token rota.
- `POST /v1/auth/recover`: `{ "email": "..." }`. Envía correo; mensaje público genérico.
- `GET /v1/auth/me`: identidad verificada por Supabase.
- `POST /v1/auth/logout`: revoca la renovación de la sesión actual. Como ocurre con JWT, un access token ya emitido puede seguir siendo válido hasta expirar; la app borra credenciales locales.
- `GET /v1/profile`: lista de cero o un perfil.
- `PATCH /v1/profile`: crea/actualiza campos permitidos `name`, `height_cm`, `weight_kg`, `age`, `goal`, `activity`, `timezone`.
- `GET /v1/meals?limit=50&offset=0`: historial paginado; máximo 100 por petición.
- `POST /v1/meals`: guarda/actualiza una comida con UUID estable. Campos `id`, `recorded_at` ISO 8601, `title`, `meal_type`, `origin`, `calories`, `protein`, `carbs`, `fat`, `notes` opcional. Los nutrientes corresponden a la porción consumida. `meal_type`: desayuno/comida/cena/colacion; `origin`: manual/photo/recipe.
- `DELETE /v1/meals/:id`: elimina exclusivamente dentro de la cuenta autenticada.
- Rutas IA y recetario existentes: ver `../Docs/API_V4.md`.

`user_id` nunca se acepta en el cuerpo. El servidor obtiene la identidad de la sesión, filtra las consultas y la base verifica además RLS. La clave primaria de comidas es `(user_id,id)` para evitar conflictos entre UUID de distintas cuentas.

## Estado de la app

La pantalla Mi cuenta permite registro, login y cierre de sesión sin copiar tokens. Las solicitudes de IA y recetario renuevan sesiones automáticamente. Cada cuenta tiene un archivo SwiftData separado; los datos personales anteriores se conservan en el archivo original y no se asignan automáticamente a una cuenta.

El backend ya tiene persistencia de perfiles y comidas. **La app todavía guarda esas entidades en SwiftData y no invoca automáticamente las nuevas rutas de persistencia**. Antes de publicar se debe integrar la sincronización (carga inicial, envío, cola sin conexión, edición y eliminación), fotos privadas, recuperación completa de contraseña y borrado de cuenta. Los planes/agua/actividad continúan siendo locales. No anunciar copia en la nube hasta completar esa integración y las pruebas reales.

## Validación

`npm test`: pruebas existentes y nuevas de sesiones, datos, aislamiento a nivel de API, validación y fallos del proveedor. `tests/rls.sql` verifica la migración y aislamiento con roles reales de PostgreSQL en una base desechable.

Fuentes: https://supabase.com/docs/guides/auth ; https://supabase.com/docs/guides/database/postgres/row-level-security ; https://supabase.com/docs/guides/getting-started/api-keys ; https://render.com/docs/free
