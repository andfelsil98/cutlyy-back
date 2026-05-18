# Lineamientos Base - Nuevo MVP De Control Para Gimnasios

Fecha: 2026-05-10

## Proposito

Este documento deja en limpio la vision base para iniciar, cuando corresponda, una nueva aplicacion de control para gimnasios usando Cutlyy como referencia tecnica y arquitectonica.

La intencion no es copiar el negocio de agendamiento de citas, sino reutilizar las partes maduras de la plataforma actual que si son transversales:

- autenticacion;
- usuarios;
- negocios/tenants;
- membresias de negocio;
- roles;
- permisos;
- modulos;
- arquitectura backend;
- arquitectura frontend;
- integraciones base;
- convenciones de operacion.

Este archivo debe servir como puente conceptual para que, al crear el nuevo proyecto, podamos generar un `AGENTS.md` propio y un `CLAUDE.md` propio con criterios consistentes, revisando tambien los `AGENTS.md` de `cutlyy-back` y `cutlyy-front`.

## Vision General

El nuevo sistema sera un MVP para control de gimnasios, pero debe nacer con una base flexible y escalable. Aunque el primer alcance funcional sea pequeno, la plataforma debe permitir crecer hacia mas roles, modulos, permisos, sedes, membresias, acceso QR, pagos, asistencias, alertas y futuras funcionalidades.

La base conceptual sera:

- usuarios autenticados con Firebase Auth;
- negocios/gimnasios como tenants;
- membresias que vinculan usuarios con negocios;
- roles asignados a esas membresias;
- permisos agrupados por modulos;
- soporte de acceso global, cross-business y business;
- frontend administrativo modular;
- backend Node.js/Express/TypeScript con servicios inyectables.

## Base Reutilizable De Cutlyy

### 1. Roles, Permisos Y Modulos

Esta es una de las partes mas reutilizables de Cutlyy.

Se quiere conservar la logica de:

- `Modules` como agrupadores funcionales.
- `Permissions` como acciones granulares.
- `Roles` como conjuntos de permisos.
- Subcoleccion de permisos dentro de roles.
- Validacion de permisos desde backend.
- Validacion de permisos desde frontend para rutas, menus y acciones.

Tambien se quiere conservar la clasificacion de roles:

- `BUSINESS`: rol limitado a un negocio/gimnasio.
- `CROSS_BUSINESS`: rol con alcance sobre multiples negocios/gimnasios.
- `GLOBAL`: rol de plataforma.

Esta base permitira arrancar con roles simples como:

- Admin.
- Recepcion.
- Cliente.

Y luego crecer hacia roles mas especificos, por ejemplo:

- Entrenador.
- Cajero.
- Supervisor de sede.
- Administrador regional.
- Soporte de plataforma.

### 2. Membresias De Negocio

El concepto de membresia de negocio se considera central y reutilizable.

La nueva plataforma debe mantener la idea de que un usuario no tiene permisos directamente por ser usuario, sino por su membresia activa dentro de un negocio/gimnasio y por el rol asociado a esa membresia.

La membresia de negocio debe seguir resolviendo:

- a que gimnasio pertenece el usuario;
- que rol tiene;
- si esta activo, pendiente, inactivo o eliminado;
- que permisos efectivos puede ejercer;
- si su alcance es global, cross-business o business.

Importante: esta membresia de negocio no debe confundirse con la membresia comercial que un cliente compra en el gimnasio. Para evitar ambiguedad:

- `BusinessMembership` o equivalente: relacion usuario-plataforma/gimnasio para permisos.
- `MemberMembership` o equivalente: plan comprado por un cliente del gimnasio.

### 3. Gestion De Usuarios

La logica actual de usuarios tambien se considera reutilizable como base.

Se quiere conservar:

- creacion de usuario interno;
- edicion de perfil;
- foto de perfil;
- busqueda/listado;
- relacion con membresias;
- sincronizacion con Firebase Auth cuando aplique;
- posibilidad de usuarios con auth activa y usuarios creados operacionalmente.

Para el nuevo MVP se debe adaptar el modelo para soportar mejor:

- email opcional para clientes del gimnasio, si el negocio lo requiere;
- registro con identificador de gimnasio;
- registro sin identificador para usuarios globales o sin negocio asignado;
- acceso inicial de usuarios nuevos aunque todavia no tengan permisos sobre ningun negocio/modulo.

### 4. Login Y Registro Con Firebase Auth

El login y registro deben seguir usando Firebase Auth.

Flujo esperado:

- Un usuario se registra con sus datos base y credenciales Firebase.
- Si envia identificador del gimnasio, se intenta crear o asociar una membresia normal de negocio.
- Si no envia identificador del gimnasio, puede crearse como usuario sin negocio o con membresia global segun el caso.
- El usuario puede iniciar sesion aunque aun no tenga acceso activo a ningun gimnasio o modulo.
- Despues del login, el frontend decide si enviarlo a:
  - selector de gimnasio/membresia;
  - panel global;
  - pantalla de espera/sin acceso;
  - flujo de activacion/asignacion de rol.

Esto conserva la flexibilidad actual de Cutlyy, pero la hace mas clara para un producto multi-gimnasio.

### 5. Creacion De Negocios/Gimnasios

La logica de creacion de negocio de Cutlyy se considera reutilizable como guia, no necesariamente al pie de la letra.

Se quiere reutilizar:

- concepto de tenant principal;
- slug o identificador publico;
- plan de plataforma;
- estado operativo;
- estado de suscripcion;
- creacion inicial de roles/membresias;
- asignacion de un administrador inicial;
- soporte de sedes.

Se debe adaptar:

- datos solicitados al crear gimnasio;
- tipos de negocio actuales de belleza/barberia;
- copy/mensajes;
- posibles campos especificos del gimnasio;
- configuracion inicial de permisos y modulos.

## Base Tecnica Reutilizable

### Backend

El nuevo backend debe partir de una arquitectura muy similar a `cutlyy-back`.

Stack esperado:

- Node.js 22.
- TypeScript.
- ESM.
- Express.
- Firebase Admin.
- Firestore.
- Firebase Auth.
- Firebase Storage.
- Google Cloud Tasks cuando existan procesos diferidos.
- Winston para logs.

Lineamientos:

- Mantener separacion por capas:
  - `config`;
  - `domain`;
  - `data`;
  - `infrastructure`;
  - `presentation`;
  - servicios de aplicacion.
- Mantener DTOs por feature.
- Mantener controladores delgados.
- Mantener servicios inyectables.
- Usar `CustomError` para errores controlados.
- Mantener middlewares globales de auth, business/tenant context, logging, rate limit y error handler.
- Reutilizar Firestore como persistencia principal.

La arquitectura debe ser limpia y practica, no una reescritura teorica. La prioridad sera que los servicios tengan responsabilidades claras, dependencias inyectables y reglas de negocio localizadas.

### Frontend

El nuevo frontend debe partir de una arquitectura muy similar a `cutlyy-front`.

Stack esperado:

- React.
- TypeScript.
- Vite.
- MUI.
- React Router.
- Axios.
- Firebase web SDK.
- Zustand.
- React hooks propios por feature.
- Services por feature para comunicacion HTTP.
- PWA desde el inicio o preparada desde el inicio.

Lineamientos:

- Mantener `services` por modulo funcional.
- Mantener `custom hooks` para operaciones y cache.
- Mantener stores para usuario, membresia activa, rol y permisos.
- Mantener rutas protegidas por auth.
- Mantener rutas protegidas por permisos.
- Reutilizar patrones de:
  - `LazyTable`;
  - `LazySelectField`;
  - `FilterBar`;
  - `PageHeader`;
  - componentes compartidos;
  - layout administrativo.
- Evitar que los componentes React contengan logica asincrona compleja.

## MVP Inicial Definido

Para este punto, el MVP inicial debe concentrarse en la base de plataforma, no en todo el dominio final del gimnasio.

Alcance inicial:

1. Login.
2. Registro.
3. Usuarios.
4. Negocios/gimnasios.
5. Membresias de negocio.
6. Roles.
7. Permisos.
8. Modulos.
9. Asignacion de roles a membresias.
10. Acceso a modulos segun permisos.

Roles iniciales esperados:

- Admin.
- Recepcion.
- Cliente.

Estos roles deben nacer desde la misma base flexible de roles/permisos/modulos, no como condicionales quemados en codigo.

## Diferencia Entre Membresias

Es importante fijar desde el inicio esta separacion:

### Membresia De Plataforma/Negocio

Representa acceso y permisos.

Ejemplos:

- Admin del gimnasio.
- Recepcionista.
- Cliente asociado al gimnasio.
- Usuario global de plataforma.

Controla:

- negocio/gimnasio al que pertenece;
- rol;
- permisos;
- estado operativo;
- alcance.

### Membresia Comercial Del Gimnasio

Representa el plan que un cliente compra.

Ejemplos:

- mensualidad;
- semana;
- dia;
- plan personalizado.

Controla:

- fecha de inicio;
- fecha de vencimiento;
- renovaciones;
- pagos;
- estado de acceso fisico.

Esta segunda membresia no necesariamente debe implementarse en la primera fase si el foco inicial es la base de plataforma, pero el modelo debe dejar espacio para ella.

## Principios Para El Nuevo Proyecto

1. Reutilizar arquitectura y patrones, no copiar accidentalmente reglas de citas.
2. Mantener usuarios, roles, permisos, modulos y membresias como nucleo de plataforma.
3. Evitar hardcodear roles del MVP cuando pueden expresarse como datos.
4. Mantener separacion entre usuario autenticado, membresia de negocio y cliente del gimnasio.
5. Permitir usuarios registrados sin acceso activo a un negocio.
6. Mantener multi-tenant desde el inicio.
7. Mantener el camino abierto para panel global y cross-business.
8. Crear nombres de dominio claros para no mezclar negocio SaaS con membresias comerciales.
9. Evitar refactors grandes innecesarios al portar la base.
10. Documentar cada decision estructural en el `AGENTS.md` del nuevo repo.

## Futuro AGENTS.md Del Nuevo Backend

Cuando se cree el nuevo backend, se debe generar un `AGENTS.md` propio que tome como referencia:

- el `AGENTS.md` actual de `cutlyy-back`;
- las reglas reales del nuevo codigo;
- este documento de lineamientos;
- las decisiones finales del MVP.

Ese `AGENTS.md` debe explicar:

- que es la nueva app;
- stack y comandos;
- estructura del codigo;
- pipeline HTTP;
- autenticacion;
- contexto multiempresa/gimnasio;
- usuarios;
- membresias de negocio;
- roles/permisos/modulos;
- reglas de negocio iniciales;
- integraciones;
- verificacion recomendada;
- convenciones de implementacion;
- que piezas de Cutlyy se reutilizaron;
- que piezas de Cutlyy no aplican.

## Futuro AGENTS.md Del Nuevo Frontend

Cuando se cree el nuevo frontend, se debe generar un `AGENTS.md` propio que tome como referencia:

- reglas y patrones de `cutlyy-front`;
- arquitectura real del nuevo frontend;
- lineamientos visuales del nuevo producto;
- rutas y permisos definidos;
- stores;
- services;
- hooks;
- componentes compartidos.

Debe dejar claro:

- como se manejan rutas privadas;
- como se selecciona gimnasio/membresia activa;
- como se cargan permisos;
- como se protegen pantallas y acciones;
- como deben estructurarse nuevas features;
- que componentes compartidos se deben preferir;
- reglas para filtros, tablas, selects y paginacion.

## Futuro CLAUDE.md

Ademas del `AGENTS.md`, el nuevo proyecto debe tener un `CLAUDE.md` si se va a trabajar tambien con Claude u otros agentes.

Ese archivo debe ser consistente con `AGENTS.md`, pero puede estar escrito en formato mas directo para asistentes de codigo.

Debe incluir:

- resumen del producto;
- stack;
- comandos principales;
- arquitectura;
- reglas de dominio;
- reglas de seguridad;
- convenciones de estilo;
- limites de lo que no se debe tocar sin autorizacion;
- flujos criticos;
- instrucciones para verificar cambios.

## Decisiones Base Ya Alineadas

- Se reutilizara Firebase Auth para login/registro.
- Se reutilizara el modelo conceptual de roles, permisos y modulos.
- Se reutilizara el modelo conceptual de membresias por negocio.
- Se mantendra soporte para roles `BUSINESS`, `CROSS_BUSINESS` y `GLOBAL`.
- Se reutilizara la logica de usuarios como base, adaptandola donde el dominio de gimnasio lo requiera.
- Se reutilizara la creacion de negocio como guia para creacion de gimnasio/tenant.
- Se mantendra Node.js + Express + TypeScript en backend.
- Se mantendra React + TypeScript + services + custom hooks en frontend.
- El nuevo proyecto debe nacer documentado con sus propios `AGENTS.md` y `CLAUDE.md`.

## Resumen Final

La nueva app de gimnasios debe nacer como una plataforma hermana de Cutlyy, no como una copia literal.

La base que mas valor aporta y que se quiere conservar es:

- autenticacion Firebase;
- usuarios;
- negocios/tenants;
- membresias de negocio;
- roles;
- permisos;
- modulos;
- arquitectura backend;
- arquitectura frontend.

Sobre esa base se construira despues el dominio especifico del gimnasio:

- membresias comerciales;
- pagos;
- asistencia;
- QR;
- alertas;
- dashboard.

El primer MVP debe asegurar que el nucleo de plataforma quede solido. Si esa base queda bien, agregar control de acceso, pagos y asistencia sera mucho mas ordenado y sostenible.
