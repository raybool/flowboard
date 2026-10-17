import { ApiProperty } from '@nestjs/swagger';
import {
  isUUID,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isUuidOrNull', async: false })
class IsUuidOrNullConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value === null || (typeof value === 'string' && isUUID(value));
  }

  defaultMessage(): string {
    return 'assigneeId must be a UUID or null';
  }
}

export class AssignTaskDto {
  @ApiProperty({ format: 'uuid', nullable: true })
  @Validate(IsUuidOrNullConstraint)
  assigneeId!: string | null;
}
