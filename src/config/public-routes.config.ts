/**
 * Prefijos de rutas que NO requieren token de sesión (rutas públicas).
 * Cualquier ruta cuyo path comience con alguno de estos prefijos se considera pública
 * y no se valida el header Authorization.
 * El resto de rutas exigen: Authorization: Bearer <idToken> (token de sesión Firebase).
 *
 * Ejemplo: si agregas "/api/health", entonces GET /api/health y GET /api/health/ready son públicas.
 */
export const PUBLIC_ROUTE_PREFIXES: string[] = [
  "/api/auth",
  "/api/branches",
  "/api/services",
  "/api/appointments",
  "/api/modules",
  "/api/permissions",
  "/api/roles"
];

/**
 * Rutas públicas exactas por método.
 * Útil cuando solo una operación puntual debe ser pública sin exponer todo el prefijo.
 */
export const PUBLIC_ROUTE_METHOD_PATHS: Array<{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  match?: "exact" | "prefix";
}> = [
  { method: "GET", path: "/api/business" },
  { method: "GET", path: "/api/business-memberships" },
  { method: "GET", path: "/api/users" },
  { method: "GET", path: "/api/reviews" },
  { method: "GET", path: "/api/bookings", match: "prefix" },
  { method: "POST", path: "/api/reviews" },
  { method: "POST", path: "/api/bookings" },
  { method: "PUT", path: "/api/bookings", match: "prefix" },
  { method: "POST", path: "/api/whatsapp/send-message", match: "prefix" },
];
