import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { CustomError } from "../../domain/errors/custom-error";
import { logger } from "../logger/logger";

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  const timestamp = new Date().toISOString();

  if (error instanceof CustomError) {
    const level = error.statusCode >= 500 ? "error" : "warn";
    const baseLog = `[${error.statusCode}] ${error.message}`;
    const stack = error.stack ?? "(no stack)";
    const message =
      error.statusCode >= 500
        ? `${baseLog}\n\nStack trace (donde se lanzó el error):\n${stack}`
        : baseLog;
    logger.log({
      level,
      message,
      method: req.method,
      url: req.originalUrl ?? req.url,
    });
    res.status(error.statusCode).json({
      error: error.message,
      ...(error.code != null && { code: error.code }),
      timestamp,
    });
    return;
  }

  // Error no controlado: loguear mensaje + stack trace para poder depurar el 500
  const err = error as Error & { statusCode?: number };
  const message = err?.message ?? String(error);
  const stack = err?.stack ?? "(no stack trace)";
  const name = err?.name ?? "Error";

  const fullMessage = [
    `Unhandled ${name}: ${message}`,
    "",
    "Stack trace:",
    stack,
  ].join("\n");

  logger.error(fullMessage);

  res.status(500).json({
    error: "Error interno del servidor",
    timestamp,
  });
};
