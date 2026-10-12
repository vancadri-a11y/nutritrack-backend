# NutriTrackAI 5.7

App iOS en SwiftUI, backend Node.js y Supabase. Esta versión está preparada para el servidor Ubuntu de tu laptop.

**Empieza por [Actualizar Ubuntu y Supabase](Docs/ACTUALIZACION_V57.md).** Allí están los comandos, las variables nuevas y la configuración del correo de recuperación.

## Cambios

- Recuperación por enlace de correo: abre la pantalla de contraseña nueva en la app. También incluye un formulario web de respaldo.
- «Eliminar mi cuenta» con confirmación escrita. El servidor comprueba la sesión, elimina archivos de Storage pertenecientes al usuario y borra su identidad; las relaciones de las migraciones eliminan sus datos asociados. La app limpia los registros y fotos locales de esa cuenta.
- Cuotas persistentes: **5 solicitudes de IA por cuenta y 200 entre todos los usuarios al día**, compartidas por fotos, planes, rutinas y adaptaciones de recetas. La reserva ocurre en una transacción de PostgreSQL antes de llamar al proveedor.
- Usos disponibles en Mi cuenta y en el escáner; mensajes específicos cuando se agota la cuota.
- Foto guardada visible al abrir una comida, con ampliación y zoom.
- Tres colores nuevos: Ámbar, Cereza y Ciruela, también disponibles para widgets.
- Bienvenida animada con una hoja y «NutriTrackAI», respetando Reducir movimiento.

## Abrir la app

1. Abre `NutriTrackAI.xcodeproj` en Xcode y selecciona el esquema **NutriTrackAI**.
2. Para el simulador, ejecuta con Run. Para tu iPhone, conserva tus Bundle IDs, equipo de firma, App Groups y HealthKit en los targets de app y widgets.
3. La dirección predeterminada es `https://local-datapps.tail70fd4e.ts.net`. Actualmente requiere Tailscale en el iPhone y pertenecer a tu red. Al tener una dirección pública, cambia `AIConnectionStore.defaultAddress` y `NUTRITRACK_RECOVERY_URL` como indica la guía.

La versión del proyecto es **5.7**, build **57**. El ZIP contiene código fuente y el proyecto; no una app firmada para distribución.

## Datos y límites

El historial, planes, agua, actividad y fotografías de la app siguen en SwiftData, con un almacenamiento separado por cuenta. El backend conserva las rutas de perfiles y comidas, pero esta versión no añade sincronización automática ni copia de fotografías en la nube. Eliminar cuenta borra los registros locales del dispositivo que realiza la acción; otro dispositivo desconectado puede conservar su copia local hasta que se limpie allí.

Las cuotas se reinician a medianoche de **America/Mazatlan** y se pueden cambiar en Supabase. Una reserva consume un uso aunque después falle o se cancele el intento; esto evita repetir gastos inciertos del proveedor. Un resultado exitoso con la misma clave de solicitud puede recuperarse ese día sin otro uso. Consultar el catálogo, la cuota o registrar manualmente no consume IA.

Consulta [la API del backend](Backend/README.md) y [la validación de 5.7](Docs/VALIDACION_V57.md). Los documentos V4/V5/V55 se conservan como historial; la guía vigente es `ACTUALIZACION_V57.md`.
