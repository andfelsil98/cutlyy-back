import type { NextFunction, Request, Response } from "express";
import {
  BOOKING_STATUSES,
  type BookingStatus,
} from "../../domain/interfaces/booking.interface";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import type { BookingService } from "../services/booking.service";
import { validateAddBookingPaymentAmount } from "./dtos/add-booking-payment.dto";
import { validateCreateBookingDto } from "./dtos/create-booking.dto";
import { validateUpdateBookingPaymentMethodDto } from "./dtos/update-booking-payment-method.dto";
import {
  validatePublicManageBookingDto,
  validateBookingIdParam,
  validateUpdateBookingDto,
} from "./dtos/update-booking.dto";

function parseIncludeDeletesQuery(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error("includeDeletes debe ser booleano (true o false)");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("includeDeletes debe ser true o false");
}

function parseBookingStatusQuery(value: unknown): BookingStatus | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error("status debe ser un texto no vacío cuando se proporcione");
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === "") {
    throw new Error("status debe ser un texto no vacío cuando se proporcione");
  }

  if (!BOOKING_STATUSES.includes(normalized as BookingStatus)) {
    throw new Error("El estado debe ser creado, cancelado, finalizado o eliminado");
  }

  return normalized as BookingStatus;
}

export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

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
      const id =
        typeof req.query.id === "string" && req.query.id.trim() !== ""
          ? req.query.id.trim()
          : undefined;
      const businessId =
        typeof req.query.businessId === "string" && req.query.businessId.trim() !== ""
          ? req.query.businessId.trim()
          : undefined;
      const clientId =
        typeof req.query.clientId === "string" && req.query.clientId.trim() !== ""
          ? req.query.clientId.trim()
          : undefined;
      const consecutive =
        typeof req.query.consecutive === "string" &&
        req.query.consecutive.trim() !== ""
          ? req.query.consecutive.trim().toUpperCase()
          : undefined;
      const status = parseBookingStatusQuery(req.query.status);
      const includeDeletes = parseIncludeDeletesQuery(req.query.includeDeletes);
      this.bookingService
        .getAllBookings({
          page: pageRaw,
          pageSize,
          ...(id != null && { id }),
          ...(businessId != null && { businessId }),
          ...(clientId != null && { clientId }),
          ...(consecutive != null && { consecutive }),
          ...(status != null && { status }),
          ...(includeDeletes != null && { includeDeletes }),
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
    const dto = validateCreateBookingDto(req.body);
    this.bookingService
      .createBooking(dto)
      .then((booking) => {
        res.status(201).json(booking);
      })
      .catch(next);
  };

  public addPayment = (req: Request, res: Response, next: NextFunction) => {
    const id = validateBookingIdParam(req.params.id);
    const amount = validateAddBookingPaymentAmount(req.body);
    this.bookingService
      .addPayment(id, amount)
      .then((booking) => {
        res.status(200).json(booking);
      })
      .catch(next);
  };

  public updatePaymentMethod = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const id = validateBookingIdParam(req.params.id);
    const paymentMethod = validateUpdateBookingPaymentMethodDto(req.body);
    this.bookingService
      .updatePaymentMethod(id, paymentMethod)
      .then((booking) => {
        res.status(200).json(booking);
      })
      .catch(next);
  };

  public update = (req: Request, res: Response, next: NextFunction) => {
    const id = validateBookingIdParam(req.params.id);
    const dto = validateUpdateBookingDto(req.body);
    this.bookingService
      .updateBooking(id, dto)
      .then((booking) => {
        res.status(200).json(booking);
      })
      .catch(next);
  };

  public publicManage = (req: Request, res: Response, next: NextFunction) => {
    const id = validateBookingIdParam(req.params.id);
    const dto = validatePublicManageBookingDto(req.body);
    this.bookingService
      .publicManageBooking(id, dto)
      .then((booking) => {
        res.status(200).json(booking);
      })
      .catch(next);
  };

  public delete = (req: Request, res: Response, next: NextFunction) => {
    const id = validateBookingIdParam(req.params.id);
    this.bookingService
      .deleteBooking(id)
      .then((booking) => {
        res.status(200).json(booking);
      })
      .catch(next);
  };
}
