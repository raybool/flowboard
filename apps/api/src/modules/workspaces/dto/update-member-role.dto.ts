import { IsEnum } from 'class-validator';
import { WorkspaceRole } from '../../../generated/prisma/client';

export class UpdateMemberRoleDto {
  @IsEnum(WorkspaceRole)
  role!: WorkspaceRole;
}