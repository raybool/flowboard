import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../src/database/prisma.service';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test');
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'flowboard-test-secret-with-at-least-32-characters',
    );

    const { AppModule } = await import('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });

  it('/projects (POST) creates a project', async () => {
    const response = await request(app.getHttpServer())
      .post('/projects')
      .send({ name: 'FlowBoard' })
      .expect(201);

    expect(response.body).toEqual({
      name: 'FlowBoard',
      id: expect.any(String),
    });
  });

  it('/projects (POST) validates the DTO', () => {
    return request(app.getHttpServer())
      .post('/projects')
      .send({ name: 'ab' })
      .expect(400);
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
});
