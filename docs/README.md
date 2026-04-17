# Documentacion Central

Esta carpeta es la fuente principal de documentacion del backend. El objetivo es que la logica importante deje de quedar dispersa entre servicios, controladores y configuraciones.

## Mapa

### Tecnica

- [technical/system-overview.md](technical/system-overview.md): arquitectura, bootstrap, middlewares y comportamiento global
- [technical/data-model.md](technical/data-model.md): colecciones Firestore, relaciones y notas de compatibilidad
- [technical/api-surface.md](technical/api-surface.md): rutas, headers, reglas de acceso y filtros mas relevantes
- [technical/integrations-and-operations.md](technical/integrations-and-operations.md): Firebase, Cloud Tasks, WhatsApp, push, variables de entorno y operacion
- [technical/consistency-hardening-plan.md](technical/consistency-hardening-plan.md): diagnostico de atomicidad, matriz de decision y plan de refactor por fases

### Negocio

- [business/domain-overview.md](business/domain-overview.md): conceptos del dominio y reglas operativas
- [business/booking-appointment-lifecycle.md](business/booking-appointment-lifecycle.md): estados, sincronizacion, automatizaciones y notificaciones de bookings/citas

## Criterio De Mantenimiento

- Si cambia una regla de negocio, actualiza primero `docs/business/*`.
- Si cambia un endpoint, middleware, integracion o variable de entorno, actualiza `docs/technical/*`.
- Evita crear archivos sueltos fuera de esta estructura salvo que exista una necesidad puntual y temporal.

## Resultado De La Reorganizacion

- La documentacion previa de estados de bookings/citas fue absorbida por [business/booking-appointment-lifecycle.md](business/booking-appointment-lifecycle.md).
- No se dejaron archivos duplicados para la misma logica.
