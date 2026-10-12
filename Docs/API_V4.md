# APIs y configuración · NutriTrackAI 4

## Desarrollo local

Requiere Node.js 20 o posterior. En la carpeta Backend:

```sh
cp .env.example .env
```

Edita `.env` localmente y asigna:

- `OPENAI_API_KEY`: tu clave del proyecto de OpenAI, exclusivamente en el servidor.
- `OPENAI_MODEL`: modelo para fotos. Valor de ejemplo: `gpt-4o-mini`.
- `OPENAI_PLAN_MODEL`: modelo para el plan completo. Valor de ejemplo: `gpt-4o-mini`.
- `OPENAI_WORKOUT_MODEL`: modelo del endpoint de rutinas heredado.
- `NUTRITRACK_DEV_TOKEN`: token aleatorio de desarrollo de al menos 24 caracteres.
- `PORT`: 8787 por defecto.

Arranca el servidor:

```sh
node --env-file=.env server.mjs
```

El adaptador escucha en `http://127.0.0.1:8787`. Para la app debes ponerlo detrás de un proxy/túnel HTTPS con certificado válido. Los clientes rechazan HTTP; no desactives ATS ni la verificación TLS.

En Xcode: **Product → Scheme → Edit Scheme → Run → Arguments → Environment Variables**:

```text
NUTRITRACK_API_URL=https://TU-DOMINIO/v1/food/analyze
NUTRITRACK_PLAN_URL=https://TU-DOMINIO/v1/plans/generate
NUTRITRACK_DEV_TOKEN=EL_TOKEN_DE_DESARROLLO_DEL_SERVIDOR
```

`NUTRITRACK_PLAN_URL` puede omitirse si ambas rutas viven bajo el mismo `/v1`: se deriva de la URL del escáner. El lugar de conexión en Swift es **NutriTrackAI/App/AppDependencies.swift**, métodos `makePlanClient()` y `makeVisionService()`.

No añadas `OPENAI_API_KEY` al esquema de Xcode, Info.plist o archivos Swift. `.env` está excluido del proyecto entregado y del repositorio.

## Contrato de planes

`POST /v1/plans/generate`, `Authorization: Bearer <sesión>`, `Content-Type: application/json` y `Idempotency-Key` de 16–100 caracteres permitidos.

```json
{
  "age": 30,
  "weightKG": 70,
  "heightCM": 170,
  "goal": "maintain",
  "activity": "light",
  "reference": "female",
  "minutes": 25,
  "preferences": "Vegetariano, preparaciones sencillas"
}
```

`goal`: maintain / loseFat / buildMuscle. `activity`: sedentary / light / moderate. `reference`: female / male. Se aceptan 18–100 años, 35–300 kg, 120–230 cm, 10–60 minutos y hasta 600 caracteres de preferencias. No se aceptan campos adicionales.

Respuesta: `source: "ai"`, `nutrition` y `sessions`.

- `nutrition`: calories, protein, carbs, fat, explanation, meals.
- `meals`: cuatro objetos con UUID `id`, name, suggestion, calorieBudget; orden Desayuno, Comida, Cena, Colación.
- `sessions`: siete objetos con UUID `id`, day, title, minutes, exercises; orden lunes a domingo.

El servidor valida la forma y coherencia; Swift vuelve a validar antes de mostrar o guardar. Si la IA rechaza una solicitud devuelve un error sin reemplazar el plan local. Un esquema JSON correcto no garantiza que una recomendación sea apropiada para cada condición de salud.

## Contrato del escáner

`POST /v1/food/analyze`, mismas cabeceras. El cliente genera una huella del cuerpo completo (foto + contexto), permitiendo afinar la misma foto sin recibir un resultado anterior.

```json
{
  "prompt_version": "food-v2",
  "mime_type": "image/jpeg",
  "image_base64": "BASE64_DEL_JPEG",
  "context": {
    "measuredGrams": 300,
    "notes": "Pollo a la plancha; una cucharadita de aceite",
    "consumedFraction": 0.5
  }
}
```

`measuredGrams` se omite o usa null si se desconoce; si se proporciona, debe ser 1–5000 g de toda la comida fotografiada. `notes`: hasta 600 caracteres. `consumedFraction`: de 0.25 a 1. JPEG de hasta 2 MB; la app normaliza la orientación y elimina EXIF/GPS al comprimir.

Además de is_food, summary, calories, protein, carbs, fat, confidence y notes, la respuesta v2 contiene:

- `analysis.items`: nombre, gramos, calorías y macros por alimento.
- `analysis.calorieLow`, `analysis.calorieHigh`: rango orientativo, no un intervalo estadístico calibrado.
- `analysis.question`: pregunta útil para refinar o cadena vacía.

El proveedor estima todo el plato. El servidor aplica consumedFraction a todos los valores y al desglose antes de responder. El cliente no vuelve a multiplicarlos. El backend sigue aceptando `food-v1` para compatibilidad con la v3.

## Errores y límites

400 datos inválidos; 401 sesión inválida; 409 solicitud en curso o reutilización de clave con datos distintos; 413 cuerpo grande; 422 foto no interpretable o propuesta rechazada; 429 cuota; 502 respuesta del proveedor inválida; 503 servicio sin configurar/ocupado; 504 timeout.

El servidor conserva cuotas en memoria, máximo cuatro llamadas simultáneas por proceso y caché temporal por usuario/ruta/clave. No registra fotos, datos de perfil ni respuestas. `store: false` se envía al proveedor; esto no sustituye revisar sus políticas de retención.

## Producción

`server.mjs` es solo de desarrollo y rechaza `NODE_ENV=production`. Integra `createAPIHandler` en tu servidor con autenticación real: validar firma, emisor, audiencia, expiración y usuario. Sustituye cuotas y caché en memoria por almacenamiento compartido si escalas.

Los valores de esquema Xcode solo se leen en DEBUG. Para Release, inyecta en **AppDependencies.swift**:

```swift
PlanHTTPClient(endpoint: URL(string: "https://TU-DOMINIO/v1/plans/generate")!) {
    try await tuSesion.tokenValido()
}
```

`tuSesion` es un ejemplo del proveedor de sesión de tu sistema de login, no una clase incluida. Haz lo mismo con `VisionHTTPClient` dentro de `VisionService(mode: .remote(...))`. No uses un token compartido de desarrollo como autenticación pública.

En esta entrega están implementados cliente y servidor de planes/fotos; no se crearon cuentas, claves, login de producción ni despliegues. Hasta configurar Release, conserva el escáner demo y la personalización manual, con la IA indicada como pendiente de conexión.

Referencias: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Images and vision](https://developers.openai.com/api/docs/guides/images-vision).
