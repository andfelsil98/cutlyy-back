# Contexto Global De Cutlyy Back Para Codex

Este archivo es el contexto operativo inicial del backend. Leelo al comenzar un chat o una tarea en este repo para evitar redescubrir la arquitectura, reglas de negocio y convenciones basicas.

## Fuente De Verdad

- El codigo vivo manda sobre la documentacion. Los archivos en `docs/` y `README.md` pueden ayudar, pero pueden estar desactualizados.
- Antes de cambiar reglas de negocio, valida en servicios/controladores actuales y en las interfaces de `src/domain`.
- Hay cambios locales frecuentes del usuario. No reviertas cambios que no hayas hecho.

## Que Es Esta App

Backend de Cutlyy para un sistema multiempresa de agenda y operacion de negocios de belleza/barberia. Maneja autenticacion, negocios, sedes, servicios, usuarios, membresias, roles/permisos, bookings, appointments, pagos, metricas, reviews, WhatsApp, push notifications y procesos diferidos por outbox/Cloud Tasks.

## Stack Y Runtime

- Node.js 22, TypeScript, ESM.
- Express 5.
- Firebase Admin: Firestore, Auth, Storage y FCM.
- Google Cloud Tasks para automatizaciones diferidas.
- Infobip para WhatsApp.
- Logs con Winston.

Comandos utiles:

- `npm run dev`: ejecuta `tsx watch src/app.ts`.
- `npm run typecheck`: valida TypeScript.
- `npm run build`: limpia `dist` y compila con `tsup`.
- `npm test`: actualmente es placeholder y falla.

## Arranque Y Pipeline HTTP

- `src/app.ts` lee `FIREBASE_CREDENTIALS_PATH`, inicializa Firebase/Firestore y monta `Server` con `AppRoutes.routes`.
- Si `outboxProcessorRuntimeConfig.enabled` esta en `true`, arranca un runner en memoria para outbox; actualmente esta desactivado en `src/config/runtime.config.ts`.
- `src/presentation/server.ts` aplica middlewares en este orden:
  - `cors({ origin: "*" })`
  - `helmet()`
  - `express.json({ strict: false })`
  - `express.urlencoded({ extended: true })`
  - `requestLogger`
  - `rateLimitMiddleware`
  - `authMiddleware`
  - `businessIdHeaderMiddleware`
  - rutas
  - `notFoundRoute`
  - `errorHandler`

## Estructura Del Codigo

- `src/config`: envs, runtime, rutas publicas, templates WhatsApp, metric types, constantes de Cloud Tasks.
- `src/domain`: interfaces, errores, constantes y utilidades puras.
- `src/data`: inicializacion de Firestore Admin.
- `src/infrastructure`: middlewares, logger, clientes externos y providers.
- `src/presentation`: rutas, controladores, DTOs y servicios de aplicacion.

Patron comun:

- Rutas en `src/presentation/<feature>/routes.ts`.
- Controladores en `src/presentation/<feature>/<feature>.controller.ts`.
- DTOs en `src/presentation/<feature>/dtos`.
- Servicios de aplicacion compartidos en `src/presentation/services`.
- Firestore se centraliza bastante en `src/presentation/services/firestore.service.ts`, pero varios flujos complejos usan transacciones directas.

## API Principal

`src/presentation/routes.ts` monta:

- `/auth`
- `/business`
- `/branches`
- `/services`
- `/modules`
- `/permissions`
- `/roles`
- `/business-memberships`
- `/users`
- `/appointments`
- `/bookings`
- `/reviews`
- `/whatsapp`
- `/metrics`
- `/plans`
- `/push-notifications`
- `/outbox`

## Autenticacion Y Multiempresa

- Las rutas privadas requieren `Authorization: Bearer <FirebaseIdToken>`.
- `authMiddleware` valida el token con Firebase Admin e inyecta `req.uid` y `req.decodedIdToken`.
- `businessIdHeaderMiddleware` exige y valida el header `businessId` en rutas privadas que no esten exentas.
- La validacion de `businessId` comprueba que el negocio exista, tenga `planId`, tenga `subscriptionStatus` `ACTIVE`, y que el plan exista y este `ACTIVE`.
- Las reglas publicas/exentas viven en `src/config/public-routes.config.ts`. Revisa ese archivo antes de asumir si una ruta necesita auth o `businessId`.

Importante actual: los prefijos publicos incluyen `/auth`, `/branches`, `/services` y `/appointments`; ademas hay reglas puntuales para business, bookings, reviews, WhatsApp task endpoint, outbox, plans, etc.

## Entidades Y Estados Clave

Business:

- Tipos: `BARBERSHOP`, `HAIRSALON`, `BEAUTYSALON`.
- Estados: `ACTIVE`, `INACTIVE`, `PENDING`, `DELETED`.
- `subscriptionStatus`: `ACTIVE` o `INACTIVE`.
- Tiene `planId`, `slug`, `consecutivePrefix`, empleados y estado de borrado cascada opcional.

BusinessMembership:

- Relaciona documento de usuario con negocio.
- Estados: `ACTIVE`, `INACTIVE`, `DELETED`, `PENDING`.
- Controla `isEmployee`, `branchId`, `roleId`, score/reviews.

Booking:

- Estados: `CREATED`, `CANCELLED`, `FINISHED`, `DELETED`.
- Tiene `branchId`, `consecutive`, `appointments`, `clientId`, `totalAmount`, `paidAmount`, `paymentMethod`, `paymentStatus`.
- Metodos de pago: `CASH`, `NEQUI`, `DAVIPLATA`, `QR`, `CARD`, `TRANSFER`.
- Estados de pago: `PENDING`, `PARTIALLY_PAID`, `PAID`.

Appointment:

- Estados: `CREATED`, `IN_PROGRESS`, `CANCELLED`, `FINISHED`, `DELETED`.
- Tiene `businessId`, `bookingId`, `date`, `startTime`, `endTime`, `serviceId`, `employeeId`.

OutboxEvent:

- Estados: `PENDING`, `PROCESSING`, `DONE`, `ERROR`, `PAUSED`.
- Tipos conocidos actuales: `BOOKING_CREATED`, `BOOKING_METRICS_SYNC`, `BOOKING_CREATED_WHATSAPP`, `BOOKING_CREATED_PUSH`, `BOOKING_CANCELLED`, `BOOKING_FINISHED`, `APPOINTMENT_TASKS_SYNC`, `BUSINESS_DELETE_CASCADE`, `BUSINESS_STORAGE_DELETE`, `BRANCH_STORAGE_DELETE`, `USER_AUTH_DELETE`, `USER_AUTH_SYNC`.
- El processor implementa handlers para `BOOKING_METRICS_SYNC`, `APPOINTMENT_TASKS_SYNC`, `BOOKING_CREATED_WHATSAPP`, `BOOKING_CREATED_PUSH` y `BUSINESS_DELETE_CASCADE`.

## Reglas De Negocio Que Conviene No Romper

- El negocio es el tenant principal: sedes, servicios, membresias, bookings, appointments, metricas y reviews cuelgan de un business.
- Los planes limitan cupos operativos: empleados, sedes, bookings y roles custom.
- Crear sedes, crear bookings, marcar empleados y crear roles puede consumir cupos.
- No se debe degradar/eliminar el ultimo `SUPER_ADMIN` de un negocio.
- Los roles protegidos actuales estan en `src/domain/constants/protected-role.constants.ts`: `SUPER_ADMIN`, `ADMIN`, `OWNER`, con ids fijos.
- Una membresia necesita `roleId` para activarse.
- Solo empleados activos deben recibir `branchId` o citas.
- Cambios sobre empleados/sedes/servicios suelen validar que no queden citas activas afectadas.
- Al crear cliente desde booking/cita, se tiende a crear usuario sin auth activa y membresia pendiente en el negocio.
- Los telefonos de cliente se normalizan para Colombia con utilidades de `src/domain/utils/string.utils.ts`.
- Las notificaciones externas suelen ser best effort o via outbox; no conviertas fallos externos en rollback del flujo principal sin revisar el patron existente.

## Bookings, Appointments Y Automatizaciones

- `BookingService` coordina creacion/edicion/borrado de bookings, pagos, public manage, eventos de WhatsApp/push y sync con appointments.
- `AppointmentService` valida agenda, servicios, empleados, conflictos, estados, metricas, tasks y revenue por cita.
- `SchedulingIntegrityService` y metodos de AppointmentService son importantes para evitar traslapes.
- Las citas programan tasks con `AppointmentStatusTaskSchedulerService`:
  - inicio: marcar `IN_PROGRESS`.
  - fin: marcar `FINISHED`.
- Horarios y tasks usan configuracion de Cloud Tasks y endpoint interno con `CLOUD_TASKS_INTERNAL_TOKEN`.
- Antes de tocar transiciones de estado, revisa ambos servicios: booking y appointment se sincronizan entre si.

## Outbox Y Procesos Diferidos

- El outbox vive alrededor de `OutboxService`, `OutboxProcessorService`, `OutboxProcessTriggerService` y `src/presentation/outbox`.
- `POST /outbox/process?limit=N` procesa lotes.
- `OutboxProcessorService` reencola eventos stale en `PROCESSING`, marca eventos como `DONE`, `ERROR` con backoff exponencial, o `PAUSED` si un dispatch externo queda ambiguo.
- `ExternalDispatchService` evita duplicar envios externos y puede dejar despachos `AMBIGUOUS`; estos requieren cuidado manual antes de reintentar.
- `OutboxProcessTriggerService` programa una Cloud Task hacia `/outbox/process?limit=...` cuando se encola trabajo, si hay base URL/token configurados.
- El borrado de negocio usa outbox/cascada y estado de deletion dentro de `Business`.

## Integraciones

- Firebase credentials se cargan desde `FIREBASE_CREDENTIALS_PATH`.
- Firestore es la base principal. Timestamps se convierten a ISO en respuestas comunes.
- Firebase Auth se usa para usuarios autenticados y borrado/sync de cuentas.
- Firebase Storage se toca en limpiezas de business/branch/user.
- FCM se usa para push web; `PUSH_NOTIFICATIONS_ENABLED` puede apagar envios.
- Infobip WhatsApp usa templates en `src/config/whatsapp-templates.config.ts`.
- Cloud Tasks usa config en `src/config/cloud-tasks.config.ts` y envs `CLOUD_TASKS_*`.

## Variables De Entorno Relevantes

Definidas en `src/config/envs.ts`:

- `PORT`
- `FIREBASE_CREDENTIALS_PATH`
- `FIREBASE_STORAGE_BUCKET`
- `ENV`
- `INFOBIP_BASE_URL`
- `INFOBIP_API_KEY`
- `INFOBIP_WHATSAPP_SENDER`
- `CLOUD_TASKS_PROJECT_ID`
- `CLOUD_TASKS_LOCATION`
- `CLOUD_TASKS_QUEUE`
- `CLOUD_TASKS_MAX_ATTEMPTS`
- `CLOUD_TASKS_TARGET_BASE_URL`
- `CLOUD_TASKS_INTERNAL_TOKEN`
- `FRONTEND_APP_BASE_URL`
- `PUSH_NOTIFICATIONS_ENABLED`

## Convenciones De Implementacion

- Mantener TypeScript ESM y estilo actual de imports.
- Preferir `CustomError` para errores controlados.
- Mantener mensajes de negocio en espanol cuando el area ya los usa asi.
- Usar los servicios existentes antes de crear logica paralela.
- Para cambios complejos de Firestore, revisar si el patron local usa `FirestoreConsistencyService` o transacciones directas.
- No hacer refactors amplios ni cambiar contratos publicos sin necesidad clara.
- Cuando agregues rutas, revisa si deben entrar en auth publica o exencion de `businessId`.
- Cuando agregues eventos outbox, declara el tipo en `src/domain/interfaces/outbox-event.interface.ts` y registra handler en `OutboxProcessorService` si debe procesarse.
- Cuando agregues tareas HTTP internas, protege con `x-internal-task-token` usando constantes de Cloud Tasks.

## Verificacion Recomendada

- Para casi cualquier cambio: `npm run typecheck`.
- Para cambios de build/config: `npm run build`.
- No confies en `npm test` hasta que exista una suite real.
- Si el cambio toca reglas de booking/appointment/outbox, revisa logs y caminos de reintento porque no hay tests automatizados que cubran regresiones.

## Documentacion Existente

- `README.md` y `docs/` sirven como mapa, pero no como fuente unica.
- Si hay conflicto entre docs y codigo, actualiza o ignora docs segun el alcance de la tarea y avisa al usuario.
