import { Body, Controller, Get, HttpCode, Param, Put } from '@nestjs/common';
import { PERMISSIONS } from '@cims/shared';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions } from '../../common/decorators/auth.decorators';
import type { AuthContext } from '../../common/http/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SettingsService } from './settings.service';

const updateSettingSchema = z.object({ value: z.unknown() });

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  list() {
    return this.settings.getAll();
  }

  @Put(':key')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  async update(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(updateSettingSchema)) body: z.infer<typeof updateSettingSchema>,
    @CurrentAuth() auth: AuthContext,
  ): Promise<void> {
    await this.settings.set(key, body.value, auth.userId);
  }
}
