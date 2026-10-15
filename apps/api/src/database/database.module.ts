import { Global, Module } from "@nestjs/common";

import { PrismaService } from "./prisma.service";
import { DatabaseHealthController } from "./database-health.controller";

@Global()
@Module({
  controllers: [DatabaseHealthController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
