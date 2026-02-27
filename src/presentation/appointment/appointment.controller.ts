import type { NextFunction, Request, Response } from "express";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import type { AppointmentService } from "../services/appointment.service";
import { validateCreateAppointmentDto } from "./dtos/create-appointment.dto";

function parseDateQuery(value: unknown, field: "startDate" | "endDate"): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} debe ser un texto con formato YYYY-MM-DD`);
  }
  const normalized = value.trim();
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDateRegex.test(normalized)) {
    throw new Error(`${field} debe tener formato YYYY-MM-DD`);
  }
  const millis = Date.parse(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(millis)) {
    throw new Error(`${field} debe ser una fecha válida`);
  }
  return normalized;
}

function parseSameDateQuery(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error("sameDate debe ser booleano (true o false)");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("sameDate debe ser true o false");
}

export class AppointmentController {
  constructor(private readonly appointmentService: AppointmentService) {}

  public getAll = (req: Request, res: Response, next: NextFunction) => {
    try {
      const pageRaw = req.query.page != null ? Number(req.query.page) : DEFAULT_PAGE;
      const pageSizeRaw =
        req.query.pageSize != null ? Number(req.query.pageSize) : DEFAULT_PAGE_SIZE;

      if (Number.isNaN(pageRaw) || pageRaw < 1) {
        res.status(400).json({ message: "page debe ser un entero positivo" });
        return;
      }

      if (Number.isNaN(pageSizeRaw) || pageSizeRaw < 1) {
        res.status(400).json({ message: "pageSize debe ser un entero positivo" });
        return;
      }

      const pageSize = Math.min(MAX_PAGE_SIZE, pageSizeRaw);
      const businessId =
        typeof req.query.businessId === "string" && req.query.businessId.trim() !== ""
          ? req.query.businessId.trim()
          : undefined;
      const id =
        typeof req.query.id === "string" && req.query.id.trim() !== ""
          ? req.query.id.trim()
          : undefined;
      const employeeId =
        typeof req.query.employeeId === "string" &&
        req.query.employeeId.trim() !== ""
          ? req.query.employeeId.trim()
          : undefined;
      const startDate = parseDateQuery(req.query.startDate, "startDate");
      const endDate = parseDateQuery(req.query.endDate, "endDate");
      const sameDate = parseSameDateQuery(req.query.sameDate);

      if (sameDate === true && startDate == null) {
        res.status(400).json({
          message: "Cuando sameDate=true debes enviar startDate",
        });
        return;
      }
      if (sameDate === true && endDate != null) {
        res.status(400).json({
          message: "Cuando sameDate=true no debes enviar endDate",
        });
        return;
      }
      if (
        sameDate !== true &&
        startDate != null &&
        endDate != null &&
        startDate > endDate
      ) {
        res.status(400).json({
          message: "startDate no puede ser mayor que endDate",
        });
        return;
      }

      this.appointmentService
        .getAllAppointments({
          page: pageRaw,
          pageSize,
          ...(businessId != null && { businessId }),
          ...(id != null && { id }),
          ...(employeeId != null && { employeeId }),
          ...(startDate != null && { startDate }),
          ...(endDate != null && { endDate }),
          ...(sameDate != null && { sameDate }),
        })
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Parámetros inválidos";
      res.status(400).json({ message });
    }
  };

  public create = (req: Request, res: Response, next: NextFunction) => {
    const dto = validateCreateAppointmentDto(req.body);
    this.appointmentService
      .createAppointment(dto)
      .then((appointment) => {
        res.status(201).json(appointment);
      })
      .catch(next);
  };
}
