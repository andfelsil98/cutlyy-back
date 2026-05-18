# Evaluacion De Implementacion - MVP Sistema De Control Para Gimnasios

Fecha de analisis: 2026-05-10

## Objetivo

Este documento evalua que tanto del ecosistema actual de Cutlyy puede servir como base para una nueva aplicacion de control para gimnasios. El enfoque no es copiar el dominio de agendamiento, sino reutilizar la arquitectura, patrones tecnicos y componentes que ya estan avanzados, separando con claridad:

- Que ya tenemos y se puede reaprovechar.
- Que falta construir como dominio nuevo.
- Que adaptaria del software actual.
- Que quitaria para no cargar el MVP con complejidad innecesaria.
- Una estimacion de esfuerzo mas realista considerando backend y frontend.

Repos revisados:

- Backend: `/Users/andfelsil98/projects/cutlyy/cutlyy-back`
- Frontend: `/Users/andfelsil98/projects/cutlyy/cutlyy-front`

## Veredicto Ejecutivo

La base actual si sirve bastante para acelerar el MVP de gimnasios, sobre todo en arquitectura, autenticacion, multiempresa, roles/permisos, CRUDs administrativos, carga de imagenes, PWA, notificaciones push, WhatsApp, metricas y patrones de tabla/filtros en frontend.

Lo que no se debe asumir como reutilizable directo es el corazon de negocio. Cutlyy esta construido alrededor de `Bookings` y `Appointments`; el MVP de gimnasios gira alrededor de `Miembros`, `Planes de membresia`, `Renovaciones`, `Pagos`, `QR dinamico`, `Anti-passback` y `Asistencias`. Esas piezas son nuevas.

Mi recomendacion seria crear la nueva app como fork/plantilla controlada de Cutlyy, no como refactor dentro de Cutlyy. Reutilizaria el stack, layout, middlewares, servicios base y componentes compartidos, pero modelaria el dominio del gimnasio desde cero para evitar que conceptos de citas contaminen el producto.

## Estimacion De Reutilizacion

| Area | Reutilizacion estimada | Comentario |
| --- | ---: | --- |
| Stack backend, Express, Firebase, Firestore, middlewares | 70-85% | Muy aprovechable. El pipeline HTTP esta listo. |
| Autenticacion y sesion | 60-75% | Requiere adaptar registro/login y perfiles porque email es opcional para clientes. |
| Multiempresa, sedes y planes SaaS | 55-70% | `Business` y `Branch` encajan bien; `Plans` actuales son planes del software, no membresias del gimnasio. |
| Roles y permisos | 65-80% | Para MVP puede simplificarse a Admin/Recepcion, pero la base ya existe. |
| Usuarios administrativos | 50-65% | Sirve para staff. Para miembros del gimnasio conviene un modelo separado o una adaptacion fuerte. |
| Pagos | 25-40% | Hay estados y metodos en bookings, pero no existe libro/historial de pagos independiente. |
| Metricas/dashboard | 35-55% | El patron existe, los indicadores deben cambiar. |
| Outbox, Cloud Tasks, notificaciones | 50-70% | Muy util para alertas, vencimientos y mensajes, pero faltan handlers nuevos. |
| QR, scanner, anti-passback | 0-15% | Dominio nuevo. No existe hoy. |
| Asistencias entrada/salida | 0-20% | Nuevo, aunque se puede apoyar en Firestore y metricas. |
| Frontend shell, rutas privadas, layout, tablas, filtros | 65-80% | Muy reutilizable para admin. |
| Frontend PWA usuario | 35-55% | La infraestructura PWA existe, pero faltan pantallas de miembro y QR. |
| Frontend scanner QR | 0-20% | Hay que integrar libreria/camara y flujos nuevos. |

Lectura rapida: la aplicacion actual puede cubrir aproximadamente un 45-60% del trabajo estructural, pero solo un 30-45% del dominio funcional del MVP. Lo que mas acelera es no empezar infraestructura desde cero.

## Mapa Del MVP Contra Lo Existente

### 1. Autenticacion Y Roles

Propuesta del MVP:

- Login/logout.
- Roles: Admin y Recepcion.

Lo que ya tenemos:

- Backend con Firebase Auth Admin, `authMiddleware`, `req.uid`, `req.decodedIdToken`.
- Login/registro en `AuthService`.
- Roles, permisos, modulos y control de acceso:
  - `AccessControlService`
  - `RoleService`
  - `PermissionService`
  - `ModuleService`
  - `BusinessMembershipService`
- Frontend con:
  - `PrivateRoute`
  - `PermissionRoute`
  - `GlobalPermissionRoute`
  - stores de usuario/membresia/rol
  - rutas protegidas y layout administrativo.

Que falta o cambiaria:

- Definir si los miembros del gimnasio tienen cuenta propia desde el MVP o solo QR emitido desde admin. La propuesta incluye App/PWA usuario, asi que si requieren login, hay que soportar usuario final.
- Separar roles de staff del gimnasio de los miembros/clientes. En Cutlyy, `BusinessMembership` mezcla pertenencia al negocio, rol, empleado y cliente. Para gimnasio conviene:
  - `StaffMemberships` para Admin/Recepcion.
  - `Members` o `GymMembers` para clientes del gimnasio.
- Simplificar permisos iniciales. No hace falta arrancar con un catalogo tan amplio como Cutlyy.

Recomendacion:

- Reutilizar Firebase Auth y rutas privadas.
- Reutilizar roles/permisos, pero sembrar solo:
  - `GYM_ADMIN`
  - `RECEPTION`
- Mantener `SUPER_ADMIN` global si el producto sera SaaS multi-gimnasio.
- Para miembros, permitir:
  - cuenta sin auth al inicio, creada por recepcion;
  - auth opcional para PWA usuario cuando se quiera que el usuario entre por email/telefono.

### 2. Gestion De Usuarios

Propuesta del MVP:

- Crear, editar y suspender usuario.
- Foto de perfil.
- Estado: Activo, Suspendido, Vencido.
- Nombre, telefono, email opcional, fecha de registro.

Lo que ya tenemos:

- `Users` con nombre, telefono, email, documento, foto de perfil y timestamps.
- `UserService` con crear, editar, listar, borrar y sincronizar Firebase Auth.
- Frontend con paginas de perfil, usuarios, detalle y subida de imagen via Firebase Storage.
- `BusinessMembership` permite estados `ACTIVE`, `INACTIVE`, `PENDING`, `DELETED`.

Brecha importante:

- En Cutlyy el usuario requiere `document`, `documentTypeName`, `documentTypeId` y `email`.
- En el MVP de gimnasio el email es opcional y no se menciona documento.
- `Vencido` no deberia ser un estado puro del usuario. Es mejor que sea un estado de su membresia o un estado de acceso calculado.

Modelo recomendado:

- `Members`
  - `id`
  - `gymId`
  - `branchId?`
  - `name`
  - `phone`
  - `email?`
  - `document?`
  - `profilePhotoUrl?`
  - `status`: `ACTIVE` | `SUSPENDED` | `DELETED`
  - `accessStatus`: `ACTIVE` | `EXPIRED` | `SUSPENDED` opcional denormalizado
  - `registeredAt`
  - `createdAt`
  - `updatedAt`
- El estado `EXPIRED` debe salir de la membresia vigente o del vencimiento, no de borrar/inactivar al usuario.

Recomendacion:

- Reutilizar parte de `UserService`, subida de fotos y tablas.
- No usar `BusinessMembership` como membresia del gimnasio. Ese nombre ya significa membresia al negocio/rol en Cutlyy y generaria confusion.
- Crear un `MemberService` propio.

### 3. Gestion De Membresias

Propuesta del MVP:

- Crear planes: mensual, semanal, diario, personalizado.
- Asignar plan a usuario.
- Fecha inicio, fecha vencimiento.
- Renovaciones.
- Estados: Activa, Vencida, Suspendida.

Lo que ya tenemos:

- `Plans` actuales con billing interval y limites del negocio.
- `BusinessUsageService` y `BusinessUsageLimitService` para cupos SaaS.
- Patrones de CRUD de planes en backend y frontend.

Brecha clave:

- Los `Plans` actuales son planes comerciales del software para el negocio, no planes que un gimnasio vende a sus miembros.
- No existe entidad de renovacion.
- No existe vencimiento por cliente.
- No existe calculo automatico de estado vencido.

Modelo recomendado:

- `MembershipPlans`
  - `id`
  - `gymId`
  - `name`
  - `durationUnit`: `DAY` | `WEEK` | `MONTH` | `CUSTOM`
  - `durationValue`
  - `price`
  - `status`: `ACTIVE` | `INACTIVE` | `DELETED`
  - `createdAt`
  - `updatedAt`
- `MemberMemberships`
  - `id`
  - `gymId`
  - `memberId`
  - `planId`
  - `startDate`
  - `expiresAt`
  - `status`: `ACTIVE` | `EXPIRED` | `SUSPENDED` | `CANCELLED`
  - `renewedFromId?`
  - `createdByStaffId`
  - `createdAt`
  - `updatedAt`
- `MembershipRenewals` opcional, o usar `MemberMemberships` encadenadas por `renewedFromId`.

Recomendacion:

- Reutilizar la pantalla/patron de `Plans` del front como base visual y tecnica.
- Crear dominio nuevo para planes de gimnasio.
- Mantener los planes SaaS del negocio separados si esta app tambien se vendera como multiempresa.

### 4. Registro De Pagos

Propuesta del MVP:

- Registrar pago.
- Historial de pagos.
- Metodos: Efectivo, Nequi, Daviplata, Transferencia, Tarjeta.
- Estado de pago.

Lo que ya tenemos:

- En `Booking` existen:
  - `paymentMethod`
  - `paidAmount`
  - `paymentStatus`
  - metodos `CASH`, `NEQUI`, `DAVIPLATA`, `QR`, `CARD`, `TRANSFER`
- `BookingService.addPayment` valida abonos y estado parcial/pagado.
- Frontend tiene servicios y UI para registrar abonos en bookings.

Brecha:

- No hay coleccion `Payments` independiente.
- No hay historial real de pagos por usuario/membresia.
- No hay anulaciones, referencias, recibos, notas, cajero, conciliacion o corte diario.

Modelo recomendado:

- `Payments`
  - `id`
  - `gymId`
  - `branchId?`
  - `memberId`
  - `membershipId`
  - `amount`
  - `method`: `CASH` | `NEQUI` | `DAVIPLATA` | `TRANSFER` | `CARD`
  - `status`: `PAID` | `VOIDED` | `REFUNDED` opcional para MVP
  - `reference?`
  - `notes?`
  - `receivedByStaffId`
  - `paidAt`
  - `createdAt`
- Para MVP, si se registra un pago al renovar, se crea:
  - una membresia o renovacion;
  - un pago ligado a esa membresia.

Recomendacion:

- Reusar metodos y funcion `resolvePaymentStatus`, pero no depender de `Booking`.
- Implementar pagos como ledger propio desde el inicio. Es barato ahora y evita dolor despues.

### 5. Dashboard Basico

Propuesta del MVP:

- Ingresos del dia.
- Ingresos del mes.
- Usuarios activos.
- Usuarios vencidos.
- Usuarios morosos.
- Entradas del dia.

Lo que ya tenemos:

- `MetricService` con agregados diarios/mensuales.
- Frontend con `ManageMetricsPage`, ECharts, filtros, cards y graficas.
- `Metrics` actuales agregan revenue, appointments y estados.

Brecha:

- Las metricas actuales se calculan desde citas/bookings.
- Falta fuente de verdad para pagos, miembros y asistencias.
- `Usuarios morosos` necesita definicion de negocio: vencido con deuda, pago pendiente, o vencimiento sin renovacion.

Modelo recomendado:

- `GymMetrics`
  - `type`: `GYM` | `BRANCH`
  - `timeFrame`: `DAILY` | `MONTHLY`
  - `gymId`
  - `branchId?`
  - `date?`
  - `month?`
  - `revenue`
  - `paymentsCount`
  - `activeMembers`
  - `expiredMembers`
  - `suspendedMembers`
  - `delinquentMembers`
  - `checkIns`
  - `checkOuts`
  - `deniedAccesses`

Recomendacion:

- Reusar el patron de `MetricService`, pero crear calculos nuevos.
- Para MVP, se puede calcular dashboard por query al principio y agregar metricas luego si el volumen es bajo. Si se espera uso real desde el dia 1, mejor agregar incrementos en pagos/asistencias.

### 6. Control De Acceso QR

Propuesta del MVP:

- Generacion QR dinamico.
- Escaner QR.
- Validacion:
  - membresia activa;
  - usuario activo;
  - anti-passback.
- Registro entrada/salida.

Lo que ya tenemos:

- Nada especifico de QR.
- Si existe infraestructura util:
  - auth;
  - businessId;
  - Firestore;
  - middlewares;
  - PWA;
  - rate limit;
  - servicios y DTOs.

Brecha:

- No hay generador de tokens QR.
- No hay scanner en frontend.
- No hay validacion de acceso.
- No hay anti-passback.
- No hay sesiones abiertas de asistencia.

Modelo recomendado:

- `AccessPasses` o tokens efimeros:
  - `memberId`
  - `gymId`
  - `nonce`
  - `expiresAt`
  - `createdAt`
  - `usedAt?`
- Para QR dinamico, mejor no guardar cada frame si rota muy rapido. Opciones:
  - JWT firmado con TTL de 30-60 segundos.
  - Token aleatorio persistido con TTL corto.
- `AccessEvents`
  - `id`
  - `gymId`
  - `branchId`
  - `memberId`
  - `direction`: `IN` | `OUT`
  - `result`: `ALLOWED` | `DENIED`
  - `reason?`: `MEMBER_SUSPENDED` | `MEMBERSHIP_EXPIRED` | `PASSBACK_DENIED` | `TOKEN_EXPIRED` | `INVALID_TOKEN`
  - `scannedByStaffId`
  - `createdAt`
- `AttendanceSessions`
  - `id`
  - `gymId`
  - `branchId`
  - `memberId`
  - `entryAt`
  - `exitAt?`
  - `status`: `OPEN` | `CLOSED`

Anti-passback recomendado:

- Si el ultimo estado abierto del miembro en esa sede es `OPEN`, un nuevo `IN` debe negarse o interpretarse como salida segun regla elegida.
- Para MVP simple:
  - primer scan valido del dia abre entrada;
  - segundo scan cierra salida;
  - no permitir nueva entrada si existe sesion abierta, salvo que recepcion fuerce cierre.
- Guardar overrides manuales con `reason` y `staffId`.

Frontend recomendado:

- Usar PWA para mostrar QR del miembro.
- Crear vista de recepcion `Escaner`.
- Integrar libreria de scanner QR con camara. Revisar opciones al implementar, pero probablemente `html5-qrcode` o `@zxing/browser`.

Riesgo principal:

- QR dinamico y anti-passback son los flujos con mas riesgo del MVP. Deben tener pruebas manuales fuertes con camara real, mala conexion y doble scan rapido.

### 7. Historial De Asistencia

Propuesta del MVP:

- Hora entrada.
- Hora salida.
- Usuario.
- Sede opcional.

Lo que ya tenemos:

- No existe entidad equivalente.
- Frontend si tiene patrones para listados paginados y filtros.

Recomendacion:

- Crear `AttendanceSessions` como vista principal para historial.
- Crear `AccessEvents` como bitacora tecnica completa.
- En UI mostrar historial basado en sesiones, no en eventos crudos.
- Filtros minimos:
  - fecha;
  - miembro;
  - sede;
  - estado abierto/cerrado.

### 8. Alertas Y Notificaciones

Propuesta del MVP:

- Membresia proxima a vencer.
- Membresia vencida.
- Usuario inactivo.
- Canales:
  - WhatsApp manual/simple.
  - Email opcional.

Lo que ya tenemos:

- WhatsApp por Infobip con templates.
- Push web con FCM.
- Outbox con reintentos.
- Cloud Tasks para procesos diferidos.

Brecha:

- No existe email provider.
- No existe scheduler diario de vencimientos.
- No existen alertas de membresia.
- Los templates actuales son de booking.

Recomendacion:

- Para MVP realista:
  - Dashboard/lista de alertas en admin.
  - Boton "Enviar WhatsApp" que abra link `wa.me` con mensaje prellenado, si se quiere evitar integracion template al inicio.
  - Outbox para alertas automaticas cuando se decida automatizar.
- Si se usa Infobip desde el inicio:
  - crear templates nuevos;
  - nuevos eventos outbox: `MEMBERSHIP_EXPIRING_WHATSAPP`, `MEMBERSHIP_EXPIRED_WHATSAPP`.
- Email dejarlo fuera del MVP salvo que sea requisito comercial.

### 9. App/PWA Usuario

Propuesta del MVP:

- Ver membresia.
- Ver vencimiento.
- Mostrar QR acceso.
- Ver historial basico.

Lo que ya tenemos:

- Frontend ya es PWA con Vite PWA.
- Firebase web auth.
- Service worker, push web y configuracion Firebase.
- Layouts y rutas.

Brecha:

- No hay area de usuario final tipo miembro.
- No hay QR.
- No hay endpoints `me` para miembro.
- El modelo actual de usuario esta mas orientado a admin/staff y clientes de booking.

Recomendacion:

- Crear rutas separadas:
  - `/app/login`
  - `/app/membership`
  - `/app/qr`
  - `/app/attendance`
- Crear backend:
  - `GET /member-app/me`
  - `GET /member-app/membership`
  - `POST /member-app/access-pass`
  - `GET /member-app/attendance`
- Para MVP se puede permitir que recepcion cree al miembro sin auth y luego invitarlo a activar cuenta.

## Que Reutilizaria Casi Directo

### Backend

- `src/app.ts` y `Server`.
- Middlewares:
  - CORS;
  - Helmet;
  - JSON/urlencoded;
  - request logger;
  - rate limit;
  - auth;
  - error handler.
- `CustomError`.
- `FirestoreDataBase`.
- `FirestoreService`, aunque revisaria paginacion por offset para volumen futuro.
- `FirestoreConsistencyService` para transacciones/batches.
- `OutboxService`, `OutboxProcessorService` y `OutboxProcessTriggerService` como patron.
- Firebase Auth/Admin/Storage.
- Push notifications como infraestructura.
- WhatsApp provider como infraestructura opcional.
- `AccessControlService`, roles, permisos y modulos con catalogo mas pequeno.
- `BusinessService` y `BranchService` adaptados a gimnasios/sedes.

### Frontend

- Vite + React + TypeScript + MUI.
- `apiClient` con interceptor de `businessId`.
- Firebase config y PWA registration.
- `PrivateRoute`, `PermissionRoute`, stores y hooks de auth.
- Layout administrativo (`HomePage`) y panel global (`ControlPanelLayout`) adaptando textos/nav.
- Componentes compartidos:
  - `LazyTable`
  - `LazySelectField`
  - `InfiniteScrollList`
  - `FilterBar`
  - `PageHeader`
  - `AppButton`
  - `AppAlert`
  - `AppEChart`
  - campos de imagen con Firebase Storage.
- Hooks de data fetch/caching como `useCachedFetch`.

## Que Adaptaria Con Cuidado

### Multiempresa

El concepto `Business` encaja si el producto sera SaaS para multiples gimnasios. Cambiaria el lenguaje del dominio:

- `Business` puede seguir existiendo internamente como tenant si se quiere velocidad.
- En API/UI mostraria `Gimnasio` o `Gym`.
- Agregaria `type: "GYM"` o reemplazaria los tipos actuales.

Si la nueva app sera para un solo gimnasio inicialmente, aun mantendria multiempresa. Quitarla ahora ahorra poco y puede costar mucho despues.

### Sedes

`Branches` encaja muy bien:

- nombre;
- direccion;
- telefono;
- horarios;
- estado;
- relacion con negocio.

Quitaria dependencias innecesarias a servicios/citas y mantendria sede como unidad para acceso y asistencia.

### Usuarios Y Membresias

No mezclaria todo en `BusinessMembership`.

Propuesta:

- `StaffMemberships`: acceso administrativo y roles.
- `Members`: clientes del gimnasio.
- `MemberMemberships`: planes comprados, vencimiento y estado.

Esta separacion evita que un cliente del gimnasio aparezca como colaborador/usuario operativo por accidente.

### Planes

Mantendria dos conceptos separados:

- `Plans`: plan SaaS que el gimnasio le paga a la plataforma.
- `MembershipPlans`: plan que el gimnasio vende a sus miembros.

Si el MVP no cobrara SaaS todavia, se puede dejar `Plans` casi oculto, pero no lo reutilizaria para membresias del usuario final.

### Metricas

Reutilizaria la idea de metricas agregadas, pero no los nombres actuales:

- Cutlyy: revenue por cita, cantidad de citas, cancelaciones.
- Gimnasio: ingresos por pagos, miembros activos/vencidos, entradas, salidas, accesos denegados.

### Outbox

Reutilizaria outbox para:

- alertas de vencimiento;
- notificaciones manuales/automaticas;
- recomputos de metricas;
- eventos de acceso si se quiere procesar algo diferido.

Mejoraria el registro de handlers para que no dependa de un `switch` cada vez mas grande.

## Que Quitaria Del MVP De Gimnasios

Quitaria o dejaria fuera del primer alcance:

- `Bookings`.
- `Appointments`.
- `Services` de belleza/barberia.
- `SchedulingIntegrityService`.
- `AppointmentStatusTaskSchedulerService`.
- Public booking flow.
- Reviews de citas.
- Productividad por empleado basada en citas.
- Templates WhatsApp de booking.
- Logica de consecutivos de booking.
- Reglas de agenda, traslapes y calendario.
- FullCalendar en las primeras pantallas, salvo que se quiera agenda de clases despues.

Tambien simplificaria:

- Catalogo inicial de permisos.
- Roles custom en el primer MVP si solo se necesita Admin/Recepcion.
- Control panel global si el primer cliente sera unico, aunque tecnicamente lo dejaria disponible para operar la plataforma.

## Que Falta Construir Desde Cero

Estas son las piezas nuevas principales:

1. `MemberService`
2. `MembershipPlanService`
3. `MemberMembershipService`
4. `MembershipRenewalService` o renovacion dentro de `MemberMembershipService`
5. `PaymentService`
6. `AccessPassService` o `QrTokenService`
7. `AccessControlValidationService` para validar QR, miembro y membresia
8. `AttendanceService`
9. `GymMetricService`
10. `MembershipAlertService`
11. `MemberAppService`
12. Scanner QR en frontend
13. Pantallas PWA de miembro
14. Dashboard especifico de gimnasio

## Rutas Backend Propuestas

Una superficie inicial podria ser:

```text
/auth
/gyms
/branches
/staff-memberships
/members
/membership-plans
/member-memberships
/payments
/access
/attendance
/dashboard
/alerts
/member-app
/push-notifications
/outbox
```

Detalle sugerido:

```text
GET    /members
POST   /members
GET    /members/:id
PUT    /members/:id
PATCH  /members/:id/suspend
PATCH  /members/:id/activate

GET    /membership-plans
POST   /membership-plans
PUT    /membership-plans/:id
DELETE /membership-plans/:id

POST   /member-memberships
POST   /member-memberships/:id/renew
PATCH  /member-memberships/:id/suspend

GET    /payments
POST   /payments
PATCH  /payments/:id/void

POST   /access/validate-qr
POST   /access/manual-checkout
GET    /attendance

GET    /dashboard/summary
GET    /alerts

GET    /member-app/me
GET    /member-app/membership
POST   /member-app/access-pass
GET    /member-app/attendance
```

Rutas publicas o sin `businessId`:

- `/auth` segun el flujo.
- `/member-app/*` podria requerir auth de usuario final, pero no necesariamente `businessId` si se resuelve desde el token/miembro.
- `/access/validate-qr` debe ser privada para recepcion, no publica.

## Modelo De Datos Sugerido

### `Gyms` o `Businesses`

Tenant principal.

Campos:

- `id`
- `name`
- `slug`
- `status`
- `subscriptionStatus`
- `planId?`
- `logoUrl?`
- `createdAt`
- `updatedAt`

### `Branches`

Sedes.

Campos:

- `id`
- `gymId`
- `name`
- `address`
- `phone?`
- `schedule?`
- `status`
- `createdAt`
- `updatedAt`

### `StaffMemberships`

Relacion entre usuario administrativo y gimnasio.

Campos:

- `id`
- `gymId`
- `userId`
- `roleId`
- `branchId?`
- `status`
- `createdAt`
- `updatedAt`

### `Members`

Clientes del gimnasio.

Campos:

- `id`
- `gymId`
- `branchId?`
- `name`
- `phone`
- `email?`
- `document?`
- `profilePhotoUrl?`
- `status`
- `registeredAt`
- `lastAccessAt?`
- `createdAt`
- `updatedAt`

### `MembershipPlans`

Planes vendibles por el gimnasio.

Campos:

- `id`
- `gymId`
- `name`
- `durationUnit`
- `durationValue`
- `price`
- `status`
- `createdAt`
- `updatedAt`

### `MemberMemberships`

Membresias compradas por miembros.

Campos:

- `id`
- `gymId`
- `memberId`
- `planId`
- `startDate`
- `expiresAt`
- `status`
- `renewedFromId?`
- `createdByStaffId`
- `createdAt`
- `updatedAt`

### `Payments`

Historial financiero.

Campos:

- `id`
- `gymId`
- `branchId?`
- `memberId`
- `membershipId`
- `amount`
- `method`
- `status`
- `reference?`
- `notes?`
- `receivedByStaffId`
- `paidAt`
- `createdAt`

### `AccessEvents`

Bitacora de cada intento de acceso.

Campos:

- `id`
- `gymId`
- `branchId`
- `memberId?`
- `direction`
- `result`
- `reason?`
- `scannedByStaffId`
- `createdAt`

### `AttendanceSessions`

Historial entendible por negocio.

Campos:

- `id`
- `gymId`
- `branchId`
- `memberId`
- `entryAt`
- `exitAt?`
- `status`
- `createdAt`
- `updatedAt`

### `Alerts`

Alertas operativas.

Campos:

- `id`
- `gymId`
- `memberId`
- `type`
- `status`
- `dueAt?`
- `sentAt?`
- `createdAt`
- `updatedAt`

## Pantallas Frontend Propuestas

### Admin/Recepcion

- Login.
- Selector de gimnasio si aplica.
- Dashboard.
- Miembros:
  - tabla;
  - crear/editar;
  - suspender/reactivar;
  - ver detalle.
- Planes de membresia:
  - crear/editar/inactivar.
- Membresia de miembro:
  - asignar plan;
  - renovar;
  - suspender.
- Pagos:
  - registrar pago;
  - historial;
  - filtro por fecha/metodo/miembro.
- Acceso QR:
  - scanner;
  - resultado de validacion;
  - accion de salida manual.
- Asistencias:
  - historial por fecha/miembro/sede.
- Alertas:
  - proximos a vencer;
  - vencidos;
  - inactivos;
  - accion de WhatsApp.
- Configuracion:
  - sedes;
  - roles basicos;
  - perfil del gimnasio.

### PWA Usuario

- Login o acceso por invitacion.
- Mi membresia.
- QR dinamico.
- Historial basico de asistencia.
- Perfil basico.

## Cambios Que Harian Mas Replicable La Base Actual

Antes de usar Cutlyy como plantilla de otra app, convendria corregir o aislar estas cosas:

1. Cambiar nombres legacy:
   - `bigopets-backend` en `package.json`.
   - `BUSSINESS` en metricas si se toca esa capa.
   - rutas/storage con textos legacy.
2. Agregar healthcheck:
   - `GET /health`
   - `GET /health/ready`
3. Agregar OpenAPI o al menos coleccion API documentada.
4. Crear seeds controlados para modulos, permisos y roles base.
5. Agregar pruebas automaticas minimas para reglas criticas.
6. Separar configuracion de dominios por producto:
   - negocio de barberia;
   - gimnasio;
   - plataforma compartida.
7. Modularizar outbox handlers.
8. Revisar paginacion con `offset` para colecciones grandes.
9. Normalizar conceptos de usuario:
   - staff;
   - cliente/miembro;
   - usuario con auth;
   - usuario sin auth.

## Estimacion De Esfuerzo

Supuestos:

- Se reutiliza Cutlyy como base tecnica.
- Se crea dominio nuevo, no se fuerza `Booking/Appointment`.
- Equipo de 1 desarrollador full-stack senior o 2 personas coordinadas.
- MVP con calidad cercana a produccion, no prototipo desechable.
- Sin pasarela de pago real, solo registro manual de pagos.
- WhatsApp automatico opcional; WhatsApp manual simple en MVP.

### Backend

| Modulo | Estimacion |
| --- | ---: |
| Limpieza/fork/base/env/rutas | 2-4 dias |
| Auth, roles Admin/Recepcion, permisos y seeds | 3-5 dias |
| Gimnasios/sedes adaptados | 2-4 dias |
| Miembros CRUD, foto, suspension | 3-5 dias |
| Planes de membresia | 2-4 dias |
| Asignacion, vencimiento y renovaciones | 4-7 dias |
| Pagos e historial | 3-5 dias |
| QR dinamico y validacion | 4-7 dias |
| Anti-passback y asistencia | 4-7 dias |
| Dashboard y metricas | 4-6 dias |
| Alertas de vencimiento | 3-6 dias |
| PWA usuario endpoints | 3-5 dias |
| Hardening, indices, logs, typecheck/build | 4-7 dias |

Backend total aproximado: 38-72 dias persona.

### Frontend

| Modulo | Estimacion |
| --- | ---: |
| Rebrand/layout/nav/permisos | 2-4 dias |
| Miembros CRUD y detalle | 4-7 dias |
| Planes de membresia | 2-4 dias |
| Renovaciones y pagos | 4-7 dias |
| Scanner QR recepcion | 3-6 dias |
| Historial de asistencia | 2-4 dias |
| Dashboard | 3-5 dias |
| Alertas | 2-4 dias |
| PWA usuario con QR | 4-7 dias |
| QA responsive/PWA/permisos | 3-5 dias |

Frontend total aproximado: 29-53 dias persona.

### Total MVP

- 1 desarrollador full-stack: 7-11 semanas reales.
- 2 desarrolladores, uno back y uno front: 4-7 semanas reales.
- Version prototipo con menos hardening: 3-5 semanas, pero no la recomendaria si va cerca de produccion.

La parte que mas puede mover la estimacion es QR/anti-passback, porque requiere pruebas con camara, dispositivos reales, latencia, doble lectura y reglas de salida.

## Priorizacion Recomendada

### Fase 1 - Base Operativa

- Auth.
- Roles Admin/Recepcion.
- Gimnasio/sedes.
- Miembros.
- Planes de membresia.
- Asignar membresia.
- Registrar pagos.

Objetivo: recepcion ya puede operar usuarios y cobros.

### Fase 2 - Acceso Y Asistencia

- QR dinamico.
- Scanner.
- Validacion de acceso.
- Anti-passback.
- Historial entrada/salida.

Objetivo: el gimnasio ya puede controlar entrada fisica.

### Fase 3 - Dashboard, Alertas Y PWA Usuario

- Dashboard.
- Alertas de vencimiento.
- WhatsApp manual/simple.
- PWA usuario con QR y vencimiento.

Objetivo: valor visible para administracion y usuario final.

## Decisiones Pendientes Antes De Implementar

1. El miembro del gimnasio necesita login desde el MVP o solo QR emitido por recepcion?
2. El QR debe funcionar offline o siempre con internet?
3. El anti-passback sera por sede o por gimnasio completo?
4. Un segundo scan debe marcar salida automaticamente o bloquear entrada duplicada?
5. Email sera realmente opcional para todos los miembros?
6. Documento/cedula sera obligatorio en Colombia o opcional?
7. Los pagos necesitan anulacion/recibo/consecutivo desde MVP?
8. La app sera multi-gimnasio SaaS desde el dia 1 o instalacion para un solo gimnasio?
9. WhatsApp sera manual con link o automatico via Infobip?
10. Se necesita soporte de clases/agenda grupal despues? Si si, no eliminaria del todo patrones de calendario, solo los dejaria fuera del MVP.

## Recomendacion Final

Usaria Cutlyy como base tecnica, pero no como base de dominio. La mejor ruta es extraer una plantilla con:

- auth;
- tenant;
- roles/permisos;
- Firestore service;
- outbox;
- push/WhatsApp;
- storage;
- layouts;
- tablas/filtros;
- PWA.

Despues construiria el dominio de gimnasio limpio:

- miembros;
- planes de membresia;
- renovaciones;
- pagos;
- QR;
- asistencias;
- alertas;
- dashboard.

Esto permite moverse rapido sin heredar la complejidad mas especifica de agendamiento. Si se fuerza el MVP de gimnasio sobre `Booking`, `Appointment` o `BusinessMembership` tal como estan, al comienzo parecera mas rapido, pero el producto quedara dificil de razonar justo en las reglas que mas importan: vencimientos, pagos y acceso fisico.
