# Plan De Endurecimiento De Consistencia Y Atomicidad

## Objetivo

Este documento define como reducir estados intermedios en `cutlyy-back` cuando una operacion toca multiples documentos o integraciones externas y una parte del flujo falla.

La meta no es meter todo en transacciones. La meta es elegir correctamente entre:

- `transaction` para `read-check-write` y actualizaciones fuertemente acopladas
- `write batch` para escrituras puras de Firestore que ya conocemos de antemano
- `saga` con compensacion y `outbox` para flujos que cruzan Firestore, Firebase Auth, Storage, Cloud Tasks, WhatsApp o push

## Problema Actual

Hoy el backend mezcla en el mismo metodo:

- validaciones
- escrituras de Firestore
- consumo o liberacion de cupos
- eliminacion de storage
- programacion o eliminacion de tasks
- envio de WhatsApp
- envio de push

Si alguno de esos pasos cae, podemos dejar:

- documentos principales actualizados pero secundarios no
- cupos consumidos o liberados sin reflejo real en el dominio
- entidades eliminadas en un lado y vivas en otro
- side effects externos ejecutados sin que el estado interno haya quedado consolidado

## Reglas Base

### 1. Core commit primero

Cada caso de uso debe separar:

1. validacion
2. `core commit` atomico en Firestore
3. side effects no criticos

El `core commit` es el estado minimo que debe quedar consistente aunque despues falle WhatsApp, push, Storage o Cloud Tasks.

### 2. No meter integraciones externas dentro de transacciones

No deben ejecutarse dentro de `transaction` o del mismo bloque critico:

- Firebase Auth
- Cloud Tasks
- Firebase Storage
- WhatsApp
- push

Esas integraciones deben salir a `outbox` o a una saga reanudable.

### 3. Las cuotas deben moverse con el dominio

Cuando una operacion consume o libera cupos y tambien cambia documentos del dominio, ambos cambios deben pertenecer al mismo commit logico.

Si no caben en la misma `transaction`, entonces la operacion debe modelarse como saga explicita con estado y compensacion.

### 4. Toda eliminacion grande debe ser reanudable

Ningun borrado transversal debe depender de que un solo request HTTP llegue hasta el final. Debe tener:

- estado de operacion
- etapa actual
- error de ultima ejecucion
- capacidad de reintento
- pasos idempotentes

### 5. Todo multi-write puro de Firestore debe salir del `for await`

Si una operacion solo toca Firestore y ya conoce los documentos a escribir, no debe hacer writes unitarios sueltos. Debe usar `batch` o `transaction`.

## Criterio De Decision

### Usar `transaction`

Usar cuando una operacion:

- lee un documento para validar y luego lo actualiza
- depende de que dos o mas documentos no queden desalineados
- mueve cuota y estado del dominio juntos
- reserva unicidad o genera identificadores que no pueden colisionar

### Usar `write batch`

Usar cuando:

- ya conocemos todos los documentos a escribir
- no dependemos de relecturas dentro del commit
- todo ocurre dentro de Firestore
- el volumen cabe dentro del limite de Firestore

### Usar `saga` mas `outbox`

Usar cuando:

- el flujo cruza Firestore con Auth, Storage, Tasks, WhatsApp o push
- el flujo puede superar 500 writes
- necesitamos reanudar despues de una caida del proceso
- una parte del flujo puede ejecutarse asincronamente sin romper consistencia

## Hotspots Prioritarios

### Prioridad 0

- `src/presentation/services/booking.service.ts`
- `src/presentation/services/appointment.service.ts`
- `src/presentation/services/business.service.ts`

Son los puntos con mayor riesgo real porque mezclan core state, cuotas, metricas, tareas automáticas y notificaciones.

### Prioridad 1

- `src/presentation/services/user.service.ts`
- `src/presentation/services/auth.service.ts`
- `src/presentation/services/business-membership.service.ts`

Cruzan Firestore con Firebase Auth o mantienen documentos duplicados entre coleccion principal y subcolecciones de soporte.

### Prioridad 2

- `src/presentation/services/role.service.ts`
- `src/presentation/services/branch.service.ts`
- `src/presentation/services/service.service.ts`
- `src/presentation/services/booking-consecutive.service.ts`

Tienen varios `multi-write` o reservas de unicidad que hoy no estan blindadas de forma consistente.

## Plan De Refactor Por Fases

### Fase 1. Primitivas De Consistencia

Archivos a crear:

- `src/domain/interfaces/outbox-event.interface.ts`
- `src/presentation/services/outbox.service.ts`
- `src/presentation/services/firestore-consistency.service.ts`

Objetivo:

- centralizar creacion de eventos de `outbox`
- centralizar commits con `transaction` y `batch`
- dejar helpers reutilizables para `quota + domain write`

Modelo sugerido para `OutboxEvents`:

- `id`
- `type`
- `aggregateType`
- `aggregateId`
- `status`: `PENDING | PROCESSING | DONE | ERROR`
- `payload`
- `attempts`
- `lastError`
- `createdAt`
- `updatedAt`
- `processedAt`

Tipos iniciales recomendados:

- `BOOKING_CREATED`
- `BOOKING_CANCELLED`
- `BOOKING_FINISHED`
- `APPOINTMENT_TASKS_SYNC`
- `BUSINESS_STORAGE_DELETE`
- `BRANCH_STORAGE_DELETE`
- `USER_AUTH_DELETE`
- `USER_AUTH_SYNC`

Resultado esperado:

- side effects externos dejan de depender del request que origino la operacion
- la persistencia critica queda consolidada antes de notificar o limpiar recursos externos

### Fase 2. Endurecer Booking Y Appointment

Archivos a intervenir:

- `src/presentation/services/booking.service.ts`
- `src/presentation/services/appointment.service.ts`
- `docs/business/booking-appointment-lifecycle.md`

#### 2.1 `createBooking`

Problema actual en [booking.service.ts](../../src/presentation/services/booking.service.ts):

- consume cuota
- crea booking
- crea appointments uno por uno
- actualiza booking con ids
- recalcula metricas
- programa tasks
- envia WhatsApp
- envia push

Patron objetivo:

1. validar todo primero
2. reservar consecutivo de forma segura
3. hacer `core commit` atomico de booking + appointments + cuota
4. publicar eventos a `outbox`
5. procesar metricas y notificaciones fuera del request si no son indispensables para integridad

Refactor concreto:

- mover la construccion del booking y appointments a un `transaction` o a un `batch` controlado si la cuota se resuelve dentro de la misma transaccion
- dejar `tasks`, `WhatsApp` y `push` fuera del commit
- mantener compensacion solo como red de seguridad, no como mecanismo principal

#### 2.2 `updateBookingInternal`

Problema actual:

- aplica multiples operaciones sobre citas
- puede cancelar, editar y crear citas en el mismo request
- luego actualiza booking
- luego recalcula revenue
- luego libera cuota si se elimina
- luego notifica

Patron objetivo:

- partir el flujo en `compute -> core commit -> outbox`
- el `core commit` debe dejar consistente al menos:
  - `Bookings`
  - `Appointments`
  - `Reviews` eliminables por cita
  - cuota cuando el booking pasa a `DELETED`

Refactor concreto:

- convertir operaciones de appointments en un plan en memoria antes de escribir
- ejecutar una sola `transaction` o un conjunto pequeño de commits idempotentes
- emitir eventos de post-proceso para revenue, tasks y mensajes

#### 2.3 `createAppointment` y `createAppointmentForBooking`

Problema actual:

- si la cita crea booking nuevo, mezcla booking, appointment, quota, metricas y notificaciones
- `createAppointmentForBooking` crea la cita y luego mueve metricas por fuera del commit

Patron objetivo:

- cuando la cita crea booking nuevo, reutilizar el mismo motor transaccional de `createBooking`
- cuando agrega una cita a un booking existente, actualizar booking + appointment + revenue base de forma consistente

Refactor concreto:

- sacar un servicio interno de escritura del agregado `Booking`
- dejar `appointment.service.ts` enfocado en validaciones y payloads
- evitar que el agregado booking se modifique desde multiples caminos incompatibles

### Fase 3. Rehacer `deleteBusiness` Como Saga Reanudable

Archivo principal:

- `src/presentation/services/business.service.ts`

Archivos sugeridos:

- `src/domain/interfaces/business-deletion-job.interface.ts`
- `src/presentation/services/business-deletion.service.ts`

Problema actual:

- el metodo marca el negocio `DELETED` y despues borra transversalmente muchas colecciones y Storage en el mismo request
- si cae en la mitad, deja sistema parcialmente limpiado

Patron objetivo:

- modelar una operacion durable de borrado
- almacenar `deletionStatus`, `deletionStage`, `lastDeletionError`, `deletionContextSnapshot`, `deletionUpdatedAt`
- ejecutar por etapas idempotentes

Etapas sugeridas:

1. `MARK_BUSINESS_DELETED`
2. `DELETE_APPOINTMENT_TASKS`
3. `DELETE_BUSINESS_USAGE`
4. `DELETE_REVIEWS_AND_METRICS`
5. `DELETE_USER_MEMBERSHIP_LINKS`
6. `DELETE_MEMBERSHIPS_AND_ROLES`
7. `DELETE_APPOINTMENTS_AND_BOOKINGS`
8. `DELETE_SERVICES_AND_BRANCHES`
9. `DELETE_STORAGE`
10. `COMPLETE`

Reglas:

- cada etapa debe ser re-ejecutable sin duplicar efectos
- cada etapa interna de Firestore debe usar `batch`
- `Storage` debe salir a `outbox` o quedar como side effect tolerante a fallo
- el request HTTP puede iniciar la operacion y devolver estado, no necesariamente esperar toda la saga

### Fase 4. Unificar Cuotas Con Mutaciones Del Dominio

Archivos a intervenir:

- `src/presentation/services/business-usage-limit.service.ts`
- `src/presentation/services/business-membership.service.ts`
- `src/presentation/services/role.service.ts`
- `src/presentation/services/branch.service.ts`
- `src/presentation/services/booking.service.ts`
- `src/presentation/services/appointment.service.ts`

Problema actual:

- `BusinessUsageLimitService` usa `transaction`, pero varios servicios la invocan por fuera de su mutacion principal

Refactor concreto:

- exponer helpers para usar cuota dentro de una transaccion mayor
- o encapsular en un servicio de caso de uso que haga `transaction` sobre:
  - `Business`
  - `usage ACTIVE`
  - documento(s) del agregado afectado

Casos obligatorios:

- `toggleIsEmployee`
- `createRole` y `deleteRole` para roles `BUSINESS`
- `createBranches`, `updateBranch` al reactivar y `deleteBranch`
- `createBooking`
- `createAppointment` cuando crea booking nuevo

### Fase 5. Batch Para Escrituras Puras De Firestore

Archivos a intervenir:

- `src/presentation/services/role.service.ts`
- `src/presentation/services/service.service.ts`
- `src/presentation/services/business.service.ts`
- `src/presentation/services/user.service.ts`

#### 5.1 `role.service.ts`

Refactor requerido:

- `createRole`: crear rol y subcoleccion `Permissions` en un solo commit logico
- `updateRole`: resolver operaciones primero y luego aplicar `add/remove/update permissionsCount` en `batch`
- `deleteRole`: borrar permisos y rol de forma atomica dentro de Firestore antes de liberar cuota

#### 5.2 `service.service.ts`

Refactor requerido:

- `createServices`: dejar de crear servicios uno por uno
- si todo es Firestore y ya se validaron nombres, crear por `batch`

#### 5.3 `business.service.ts`

Refactor requerido:

- `syncServices`: resolver `upsert/delete` y aplicar en bloques
- `syncBranches`: mismo criterio, separando la parte de cuota de la parte puramente documental
- `ensureCreatorMembership`: escribir membership y link del usuario en el mismo commit

#### 5.4 `user.service.ts`

Refactor requerido:

- `markMembershipsAsDeleted` debe usar `batch`
- borrado de subcoleccion y creacion de `DeletedUsers` deben formar parte de una saga controlada, no de promesas dispersas

### Fase 6. Auth Y Usuario Como Saga Explicita

Archivos a intervenir:

- `src/presentation/services/auth.service.ts`
- `src/presentation/services/user.service.ts`

Problema actual:

- `register`, `updateUser` y `deleteUser` cruzan Firestore y Firebase Auth
- hoy hay rollback best-effort, pero no operacion durable

Patron objetivo:

- Firestore queda como fuente de verdad
- Auth se sincroniza mediante saga con estado y reintento

Refactor concreto:

#### 6.1 `register`

- crear `User`, membership y link en commit interno consistente
- crear o sincronizar Firebase Auth como paso de saga
- si Auth falla, dejar estado `PENDING_AUTH_SYNC` o evento pendiente, no una inconsistencia silenciosa

#### 6.2 `updateUser`

- no actualizar Firestore y Auth como dos pasos ciegos
- si cambia email o nombre, persistir cambio en Firestore con marca `authSyncStatus=PENDING`
- procesar actualizacion de Firebase Auth via `outbox`

#### 6.3 `deleteUser`

- primero marcar usuario y memberships como `DELETED_PENDING_AUTH`
- borrar Auth como side effect durable e idempotente
- completar limpieza documental despues de confirmar o tolerar `user-not-found`

### Fase 7. Reserva Segura De Identificadores Unicos

Archivos a intervenir:

- `src/presentation/services/booking-consecutive.service.ts`
- `src/presentation/services/business.service.ts`

Observacion:

La reserva de slug del negocio ya tiene un buen patron en `createBusinessWithReservedSlug`.

Refactor concreto:

- replicar el mismo enfoque para consecutivos de booking si el negocio necesita unicidad fuerte y no solo probabilidad baja de colision
- si se mantiene el consecutivo random, al menos reservarlo dentro del commit de creacion del booking para que no exista ventana entre `generate` y `create`

## Mapa De Implementacion Por Caso De Uso

### `BusinessService.deleteBusiness`

Patron final: `saga` por etapas + `batch` internos + `outbox` para Storage

### `BusinessService.createBusinessComplete`

Patron final: `transaction` para negocio + membership + link cuando todo sea Firestore; saga aparte si aparece side effect externo

### `BusinessMembershipService.createPendingByDocument`

Patron final: `transaction` para reusar o crear membership y escribir link de usuario sin dejar duplicidad parcial

### `BusinessMembershipService.toggleIsEmployee`

Patron final: una sola `transaction` que lea membership, business y usage activo, y actualice todo junto

### `RoleService.createRole`

Patron final: validacion previa + `transaction` o `batch` para rol y permisos + cuota consistente

### `BranchService.deleteBranch`

Patron final: `core commit` interno para branch, memberships, metrics/reviews si siguen en Firestore; `outbox` para Storage

### `BookingService.createBooking`

Patron final: `transaction` del agregado booking + `outbox` para tasks y mensajes

### `BookingService.updateBookingInternal`

Patron final: plan de cambios + commit consistente + side effects asincronos

### `AppointmentService.createAppointment`

Patron final: reutilizar motor del agregado booking y no tener otra version de la misma escritura critica

## Guardrails De Implementacion

- No usar `Promise.all` para mezclar side effects criticos y no criticos dentro del mismo bloque.
- No liberar cupos despues de borrar docs si ambos deben verse como una sola operacion.
- No consumir cupos antes de que el agregado principal se pueda escribir dentro del mismo commit logico.
- No actualizar `Bookings` y `Appointments` desde servicios distintos sin un contrato claro del agregado.
- No depender de rollback best-effort como estrategia principal.

## Orden Recomendado De Ejecucion

1. Crear `OutboxEvents` y helpers transaccionales.
2. Refactorizar `createBooking`, `createAppointment` y `updateBookingInternal`.
3. Convertir `deleteBusiness` en saga reanudable.
4. Unificar cuota con dominio en memberships, roles, branches y bookings.
5. Endurecer `register`, `updateUser` y `deleteUser`.
6. Batchear `syncServices`, `syncBranches`, `createServices`, `markMembershipsAsDeleted`.
7. Asegurar reserva transaccional de consecutivos.

## Criterios De Aceptacion

Una fase se considera lista cuando cumple al menos esto:

- si el proceso cae en mitad del flujo, el estado queda reanudable o consistentemente compensado
- las cuotas no quedan desalineadas con los recursos reales
- las integraciones externas no rompen el `core commit`
- el flujo puede ejecutarse dos veces sin corromper datos
- la documentacion de negocio o tecnica queda actualizada

## Casos Que Deben Quedar Cubiertos Por Pruebas

- fallo despues de crear booking pero antes de enviar WhatsApp
- fallo despues de consumir cuota pero antes del commit principal
- fallo a mitad de `deleteBusiness` y posterior reintento
- fallo de Firebase Auth en `register`, `updateUser` y `deleteUser`
- reintento de una etapa ya aplicada de borrado de negocio
- colision o reintento en reserva de consecutivo

## Decision Ejecutiva

No conviene intentar meter todo el backend en transacciones. Lo correcto es:

- transaccion donde el modelo lo permite
- batch donde Firestore alcanza
- saga y outbox donde el flujo cruza fronteras externas o es demasiado grande

Los dos frentes que mas valor dan de inmediato son:

1. `booking.service.ts` + `appointment.service.ts`
2. `business.service.ts` para `deleteBusiness`
