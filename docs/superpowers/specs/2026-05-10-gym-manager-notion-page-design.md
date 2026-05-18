# Design — Página Notion "Gym manager"

Fecha: 2026-05-10
Autor: Andres Felipe Silva (con Claude)

## Propósito

Crear una página en Notion al mismo nivel que "Barber book" que funcione como guía técnica y análisis de requerimientos para iniciar el nuevo proyecto **Gym manager** (sistema de gestión de gimnasio — no agendamiento). La página debe:

1. Documentar qué se hereda/reusa de Cutlyy (Barber book) y qué se construye nuevo.
2. Definir el modelo de entidades inicial (heredadas + nuevas).
3. Incluir diagramas Mermaid de entidades (ER) y flujos críticos.
4. Servir como referencia viva durante la construcción del MVP.

## Decisiones de alcance

- **Nombre del producto:** "Gym manager" (no "Gym book" — no es agendamiento).
- **Ubicación en Notion:** Standalone, al mismo nivel que Barber book.
- **Formato de diagramas:** Mermaid en code blocks (Notion los renderiza nativo).
- **Formato de entidades:** Tablas Notion con columnas `Propiedad | Tipo | Descripción | Ejemplo` + bloque final de interfaces TypeScript (mismo patrón que Barber book).
- **Alcance:** Completo — 17 entidades + 8 flujos críticos + rutas backend + pantallas frontend + roadmap por fases.

## Estructura del documento (12 secciones)

1. **Resumen Ejecutivo** — qué es Gym manager, relación con Cutlyy, qué se reusa/qué es nuevo.
2. **Mapa de Reutilización** — diagrama Mermaid + tabla `Capa | % reuso | Notas`.
3. **Colecciones de Base de Datos** — lista plana de colecciones (heredadas + nuevas).
4. **Diagrama de Entidades Global** — `erDiagram` Mermaid con las 17 entidades y FKs.
5. **Entidades Heredadas (adaptadas)** — Business, Branch, User, BusinessMembership, Role, Permission, Module, Plan, Metric.
6. **Entidades Nuevas (dominio gym)** — Member, MembershipPlan, MemberMembership, Payment, AccessPass, AccessEvent, AttendanceSession, Alert.
7. **Diferencia clave — Dos tipos de membresía** — separación `BusinessMembership` (plataforma) vs `MemberMembership` (comercial).
8. **Flujos Críticos** — 8 diagramas Mermaid: login/registro, creación gimnasio, alta miembro + asignar plan, renovación + pago, QR + validación + anti-passback, check-in/out, alerta vencimiento, PWA usuario.
9. **Rutas Backend Propuestas** — tabla `Método | Ruta | Descripción | Permiso`.
10. **Pantallas Frontend** — listado admin + PWA usuario + componentes reutilizables.
11. **TypeScript interfaces** — un solo code block con todas las interfaces.
12. **Roadmap por Fases** — Fase 1 (base operativa), Fase 2 (acceso/asistencia), Fase 3 (dashboard/alertas/PWA).

## Decisiones técnicas clave

| Tema | Decisión |
|---|---|
| Tenant | Mantener `Business` con `type: 'GYM'` (no romper compatibilidad). UI muestra "Gimnasio". |
| Membresía cliente | Modelo separado `MemberMembership` + `Members`. NO reusar `BusinessMembership` para clientes. |
| QR | JWT firmado con TTL 30-60s, no persistido. `AccessEvent` sí se persiste por cada scan. |
| Anti-passback | Por `branchId`. Si hay `AttendanceSession` OPEN, nuevo scan IN cierra como OUT. |
| Alerts | Entidad propia (admin la ve/dispara). Outbox para envío auto cuando se habilite. |
| WhatsApp | Manual con `wa.me` en MVP. Infobip diseñado pero opcional. |

## Entidades nuevas — esquema base

### Member

```
id, gymId, branchId?, name, phone, email?, document?, profilePhotoUrl?,
status (ACTIVE|SUSPENDED|DELETED), accessStatus (ACTIVE|EXPIRED|SUSPENDED),
registeredAt, lastAccessAt?, createdAt, updatedAt
```

### MembershipPlan

```
id, gymId, name, durationUnit (DAY|WEEK|MONTH|CUSTOM), durationValue,
price, status (ACTIVE|INACTIVE|DELETED), createdAt, updatedAt
```

### MemberMembership

```
id, gymId, memberId, planId, startDate, expiresAt,
status (ACTIVE|EXPIRED|SUSPENDED|CANCELLED),
renewedFromId?, createdByStaffId, createdAt, updatedAt
```

### Payment

```
id, gymId, branchId?, memberId, membershipId, amount,
method (CASH|NEQUI|DAVIPLATA|TRANSFER|CARD),
status (PAID|VOIDED|REFUNDED), reference?, notes?,
receivedByStaffId, paidAt, createdAt
```

### AccessPass

```
id (JWT jti), memberId, gymId, nonce, expiresAt, createdAt, usedAt?
```

### AccessEvent

```
id, gymId, branchId, memberId?, direction (IN|OUT),
result (ALLOWED|DENIED),
reason? (MEMBER_SUSPENDED|MEMBERSHIP_EXPIRED|PASSBACK_DENIED|TOKEN_EXPIRED|INVALID_TOKEN),
scannedByStaffId, createdAt
```

### AttendanceSession

```
id, gymId, branchId, memberId, entryAt, exitAt?,
status (OPEN|CLOSED), createdAt, updatedAt
```

### Alert

```
id, gymId, memberId, type (EXPIRING|EXPIRED|INACTIVE),
status (PENDING|SENT|DISMISSED), dueAt?, sentAt?, createdAt, updatedAt
```

## Notas de implementación

- El bloque de TypeScript al final se construye exportando las interfaces tal cual aparecerán en `cutlyy-back/src/domain/interfaces/*.interface.ts` del nuevo proyecto.
- Los diagramas Mermaid deben validarse visualmente en Notion al crear la página.
- La página debe quedar lista para iteraciones: agregar/quitar entidades a medida que el MVP avance.
