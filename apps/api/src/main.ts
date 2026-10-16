import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { VersioningType, ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvConfig } from './config/env.schema';
import { setupSwagger } from './config/swagger.config';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const config = app.get(ConfigService<EnvConfig, true>);

  const port = config.get('PORT', { infer: true });
  const frontendUrl = config.get('FRONTEND_URL', {
    infer: true,
  });
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));

  app.enableShutdownHooks();

  app.setGlobalPrefix('api');

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.enableCors({
    origin: frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
    }),
  );

  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    setupSwagger(app);
  }

  await app.listen(port);

  Logger.log(`API: http://localhost:${port}/api`);
  Logger.log(`Swagger: http://localhost:${port}/api/docs`);

}

await bootstrap();

