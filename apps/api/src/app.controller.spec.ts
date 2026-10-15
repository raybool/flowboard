import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CreateProjectDto } from './common/dto/create-project.dto';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('create', () => {
    it('returns a project with its name and a generated id', () => {
      const project = appController.create({ name: 'FlowBoard' });

      expect(project).toEqual({ name: 'FlowBoard', id: expect.any(String) });
    });

    it('preserves DTO metadata for Nest validation', () => {
      expect(
        Reflect.getMetadata(
          'design:paramtypes',
          AppController.prototype,
          'create',
        ),
      ).toEqual([CreateProjectDto]);
    });
  });
});
