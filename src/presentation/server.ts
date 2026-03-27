import express, { Router } from "express";
import { authMiddleware, errorHandler, notFoundRoute, rateLimitMiddleware, requestLogger } from "../infrastructure";
import cors from "cors";
import helmet from "helmet";

interface Options {
  port: number;
  routes: Router;
}

export class Server {
  private readonly app = express();
  private readonly port: number;
  private readonly routes: Router;

  constructor(options: Options) {
    const { port = 3001, routes } = options;
    this.port = port;
    this.routes = routes;
  }

  async start() {
    this.app.use(cors({ origin: "*" }));
    this.app.use(helmet());
    this.app.use(express.json({ strict: false }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(requestLogger);
    this.app.use(rateLimitMiddleware);
    this.app.use(authMiddleware);
    this.app.use(this.routes);
    // Not found routes 
    this.app.use(notFoundRoute);
    // Error handler 
    this.app.use(errorHandler);
    this.app.listen(this.port, () => {
      console.log(`server running on port ${ this.port } `);
    })
  }
}
