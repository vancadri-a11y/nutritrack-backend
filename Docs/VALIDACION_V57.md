# Validación NutriTrackAI 5.7

Verificación local del 11 de octubre de 2026. No se cambiaron el servidor Ubuntu ni el proyecto Supabase real.

## Backend

`node --test`: **80 aprobadas, 0 fallos, 1 omitida**. La omitida es la integración con PostgreSQL, ejecutada por separado con una base temporal real.

Se verificaron recuperación con redirección configurada en el servidor, rechazo de enlace vencido, contraseña mínima, sesión propia, borrado confirmado sin aceptar ID ajeno, eliminación de archivos antes de Auth y conservación de la identidad si falla Storage. Las pruebas también comprueban que la clave administrativa moderna no se envía como un JWT y que datos ordinarios siguen usando publishable key más JWT del usuario.

Cuotas: agotamiento devuelve 429 sin llamar a OpenAI; la reserva precede al proveedor; un resultado persistido puede recuperarse sin una segunda llamada. Un intento fallido sigue contabilizado y se distingue de uno en curso; un reintento explícito usa una nueva reserva. La falta de clave administrativa impide usar IA y borrar cuentas, sin omitir el control.

Registro: [backend-v57.txt](Validation/backend-v57.txt).

## PostgreSQL real

La prueba `Backend/quota-postgres.test.mjs` se ejecutó correctamente con PostgreSQL 18 local, en una base y un clúster temporales separados de cualquier servicio real.

- 20 reservas simultáneas de una cuenta admitieron exactamente 5.
- 20 reservas simultáneas repartidas entre dos cuentas respetaron un límite global reducido a 7 para la prueba: exactamente 7 admitidas.
- 10 solicitudes simultáneas con la misma clave generaron una sola reserva.
- El mismo identificador con otro contenido devolvió conflicto; el resultado completado pudo recuperarse y no incrementó el consumo.
- Los roles `anon` y `authenticated` no pudieron leer las tablas privadas ni ejecutar las funciones administrativas.
- La consulta de archivos seleccionó únicamente los objetos del usuario indicado.
- Al borrar la identidad, desaparecieron perfiles, comidas, consumo individual y reservas. El contador global permaneció.
- Una identidad eliminada no pudo reservar; el consumo de ayer no agotó la cuota de hoy.

El test rechaza hosts remotos y exige una base llamada `nutritrack_v57_test`. Requiere además una base nueva y roles de prueba ausentes en el clúster; no está pensado para reutilizar una base con datos.

## iOS

**42 pruebas aprobadas, 0 fallos**, con Xcode 27.0, iPhone 18 Pro e iOS 27.0 en simulador. La app y su extensión WidgetKit compilaron con firma local para permitir las pruebas de Keychain.

Los casos nuevos verifican enlaces de recuperación válidos e inválidos, rechazo de parámetros duplicados, uso de una sesión temporal sin reemplazar la cuenta actual, contraseña débil rechazada antes de enviar, rechazo de enlace vencido y eliminación de la sesión temporal después de usarla. Se comprobó también la recuperación de la limpieza local pendiente tras reiniciar la app, lectura de cuotas, mensaje de cuota agotada sin reintento automático y conservación de la fotografía al editar la comida. Al reintentar una foto tras un fallo confirmado, cambia su clave de solicitud; un intento aún en curso conserva la clave y los éxitos mantienen la protección frente a duplicados.

Registro: [ios-v57.txt](Validation/ios-v57.txt).

Se generaron y revisaron visualmente estas pantallas con datos de prueba:

- [Bienvenida](Validation/v57-screens/v57-welcome.png).
- [Inicio de sesión](Validation/v57-screens/v57-login.png).
- [Foto de una comida](Validation/v57-screens/v57-meal-photo.png).
- [Contraseña nueva](Validation/v57-screens/v57-password.png).
- [Apariencia](Validation/v57-screens/v57-colors.png).

La pantalla de contraseña de la captura muestra el formulario sin credenciales reales. La ilustración de comida es un recurso de prueba, no una foto de un usuario.

## Pendiente en la instalación real

Aplicar la migración, configurar clave administrativa, redirección y plantilla de correo, actualizar Ubuntu y probar cuentas desechables allí. No se realizaron llamadas pagadas a OpenAI, envíos reales de recuperación, eliminación de usuarios reales ni publicación en App Store. Las pruebas con respuestas controladas y PostgreSQL local no sustituyen esta comprobación del despliegue.

El endpoint Tailscale predeterminado sigue siendo privado. Las instrucciones de activación están en [ACTUALIZACION_V57.md](ACTUALIZACION_V57.md).


## Corrección de dirección del 12 de octubre de 2026

Se corrigió la dirección predeterminada a `https://local-datapps.tail70fd4e.ts.net`, comprobada en el panel de Tailscale. La app migra tanto la antigua dirección de Render como la dirección mal escrita `local-dataapps` que hubiera quedado guardada y conserva direcciones personalizadas. Se corrigieron también la guía y el archivo de variables de ejemplo.

La app compiló y la prueba seleccionada `testPreviousDefaultAddressesMigrateButCustomAddressRemains` pasó: **1 prueba aprobada, 0 fallos**, en iPhone 18 Pro / iOS 27.0. Registro: [ios-v57-address.txt](Validation/ios-v57-address.txt). No se repitieron las demás pruebas, cuyos resultados anteriores están documentados arriba.

En Supabase real quedaron guardados SMTP y la plantilla de recuperación en español. La redirección correcta, la activación del backend Ubuntu y la prueba de entrega y recuperación real siguen pendientes.
