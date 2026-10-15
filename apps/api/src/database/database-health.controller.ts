import { Controller, Get } from "@nestjs/common";

import { PrismaService } from "./prisma.service";

@Controller("health")
export class DatabaseHealthController {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  @Get("database")
  async checkDatabase() {
    await this.prisma.$queryRaw`SELECT 1`;

    return {
      status: "ok",
      database: "connected",
    };
  }
}
