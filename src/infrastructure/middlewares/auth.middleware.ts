import type { NextFunction, Request, Response } from "express";
import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import { logger } from "../logger/logger";
import { isPublicRequest } from "./route-access.utils";

const BEARER_PREFIX = "Bearer ";

function getFirebaseAuthErrorCode(error: unknown): string {
  return typeof error === "object" &&
    error != null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = req.originalUrl ?? req.path ?? "";
  const isPublic = isPublicRequest(req.method, path);
  const authHeader = req.headers.authorization;

  if (isPublic && (!authHeader || !authHeader.startsWith(BEARER_PREFIX))) {
    next();
    return;
  }

  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    logger.warn(
      `[authMiddleware] Token de sesión ausente o mal formado. path=${path}, method=${req.method}`
    );
    next(
      CustomError.unauthorized(
        "Token de sesión requerido. Envía Authorization: Bearer <idToken>.",
        "SESSION_TOKEN_REQUIRED"
      )
    );
    return;
  }

  const idToken = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!idToken) {
    if (isPublic) {
      next();
      return;
    }

    logger.warn(
      `[authMiddleware] Token de sesión vacío después de Bearer. path=${path}, method=${req.method}`
    );
    next(CustomError.unauthorized("Token de sesión inválido.", "INVALID_SESSION_TOKEN"));
    return;
  }

  logger.info(
    `[authMiddleware] Token de sesión recibido para validar. path=${path}, method=${req.method}`
  );

  FirestoreDataBase.getAdmin()
    .auth()
    .verifyIdToken(idToken, true)
    .then((decodedToken) => {
      logger.info(
        `[authMiddleware] Token de sesión verificado. uid=${decodedToken.uid}, email=${decodedToken.email ?? "no-email"}, path=${path}, method=${req.method}`
      );
      req.uid = decodedToken.uid;
      req.decodedIdToken = decodedToken;
      next();
    })
    .catch((error: unknown) => {
      const code = getFirebaseAuthErrorCode(error);
      if (isPublic) {
        logger.warn(
          `[authMiddleware] No fue posible usar el token opcional en ruta pública. code=${code || "unknown"}, path=${path}, method=${req.method}`
        );
        next();
        return;
      }

      if (code === "auth/user-not-found") {
        logger.warn(
          `[authMiddleware] Usuario inexistente en Firebase Auth para el token enviado. path=${path}, method=${req.method}`
        );
        next(CustomError.unauthorized("Tu usuario fue eliminado.", "ACCOUNT_DELETED"));
        return;
      }
      if (code === "auth/id-token-revoked") {
        logger.warn(
          `[authMiddleware] Token revocado detectado. path=${path}, method=${req.method}`
        );
        next(
          CustomError.unauthorized(
            "Tu sesión fue revocada. Inicia sesión nuevamente.",
            "SESSION_REVOKED"
          )
        );
        return;
      }

      logger.warn(
        `[authMiddleware] Falló la verificación del token de sesión. code=${code || "unknown"}, path=${path}, method=${req.method}`
      );
      next(
        CustomError.unauthorized("Token de sesión inválido o expirado.", "INVALID_OR_EXPIRED_TOKEN")
      );
    });
}
