import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { envSchema } from './config/env.schema';
import { AuthModule } from './modules/auth/auth.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
       validate: (config) => envSchema.parse(config),
    }),

    DatabaseModule,
    AuthModule,
    WorkspacesModule,
  ],
})
export class AppModule {}

