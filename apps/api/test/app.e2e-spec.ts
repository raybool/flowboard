import { INestApplication, UnauthorizedException, ValidationPipe, VersioningType } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../src/database/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';

describe('Auth HTTP (e2e)', () => {
  let app: INestApplication<App>;
  const authService = {
    login: vi.fn(),
    register: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    validateAccess: vi.fn(),
  };

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test');
    vi.stubEnv('JWT_ACCESS_SECRET', 'flowboard-test-secret-with-at-least-32-characters');
    const { AppModule } = await import('../src/app.module');
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ session: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() } })
      .overrideProvider(AuthService)
      .useValue(authService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterEach(() => vi.resetAllMocks());

  it('returns 401 for invalid login attempts and 429 after five attempts', async () => {
    authService.login.mockRejectedValue(new UnauthorizedException('Invalid credentials'));

    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: 'wrong' })
        .expect(401);
    }

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'wrong' })
      .expect(429);
    expect(authService.login).toHaveBeenCalledTimes(5);
  });

  it('returns 500 for registration storage failure without exposing its details', async () => {
    authService.register.mockRejectedValue(new Error('private database host and credentials'));

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'user@example.com', name: 'User', password: 'long-password' })
      .expect(500);

    expect(JSON.stringify(response.body)).not.toContain('private database host');
  });

  it('returns 401 for missing access token and 500 for session lookup failure', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);

    authService.validateAccess.mockRejectedValue(new Error('private database host'));
    const jwt = app.get(JwtService);
    const token = await jwt.signAsync({ sub: 'user-id', sid: 'session-id', type: 'access' });
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(500);

    expect(JSON.stringify(response.body)).not.toContain('private database host');
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
});
