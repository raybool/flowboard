import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { envSchema } from './config/env.schema';
import { AuthModule } from './modules/auth/auth.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { TasksModule } from './modules/tasks/tasks.module.js';
import { TaskCommentsModule } from './modules/task-comments/task-comments.module.js';
import { LabelsModule } from './modules/labels/labels.module.js';
import { TaskActivityModule } from './modules/task-activity/task-activity.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: (config) => envSchema.parse(config),
    }),

    DatabaseModule,
    AuthModule,
    WorkspacesModule,
    ProjectsModule,
    TasksModule,
    TaskCommentsModule,
    LabelsModule,
    TaskActivityModule,
  ],
})
export class AppModule {}
