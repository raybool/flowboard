import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client";
import { ConfigService } from "@nestjs/config";
import type { EnvConfig } from "../config/env.schema";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService<EnvConfig, true>) {
    const connectionString = config.get('DATABASE_URL', {
      infer: true,
    });

    const adapter = new PrismaPg({
      connectionString,
    });

    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
