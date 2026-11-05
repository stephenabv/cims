import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  type AttendanceMonitorQuery,
  ERROR_CODES,
  type HolidayInput,
  type KioskPunchInput,
  type KioskPunchResult,
  type MyAttendanceQuery,
  PERMISSIONS,
  type RegisterKioskInput,
  type ScheduleInput,
  attendanceMonitorQuerySchema,
  employeeAttendanceQuerySchema,
  holidaySchema,
  kioskPunchSchema,
  myAttendanceQuerySchema,
  registerKioskSchema,
  scheduleSchema,
} from '@cims/shared';
import { z } from 'zod';
import {
  Authenticated,
  CurrentAuth,
  Public,
  RequirePermissions,
  SkipCsrf,
} from '../../common/decorators/auth.decorators';
import { ForbiddenError, UnauthenticatedError } from '../../common/errors/app-error';
import { type AuthContext, clientInfo } from '../../common/http/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { Clock } from '../../infrastructure/clock/clock';
import { SettingsService } from '../settings/settings.service';
import { AttendanceQueryService } from './attendance-query.service';
import { KioskDeviceService } from './kiosk-device.service';
import { PunchService } from './punch.service';
import { ScheduleService } from './schedule.service';

export const KIOSK_TOKEN_HEADER = 'x-kiosk-token';
const uuid = new ParseUUIDPipe();

/**
 * Attendance terminal endpoints. No session: identity comes from account number + PIN, and the
 * device from its registration token. Cookies are not used, so CSRF does not apply.
 */
@Controller('kiosk')
export class KioskController {
  constructor(
    private readonly devices: KioskDeviceService,
    private readonly punches: PunchService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  @Get('status')
  @Public()
  async status(@Req() req: Request) {
    const device = await this.devices.authenticate(req.header(KIOSK_TOKEN_HEADER));
    const s = await this.settings.getMany([
      'company.name',
      'company.timezone',
      'attendance.allowUnregisteredDevices',
    ] as const);
    return {
      device: device ? { name: device.name } : null,
      acceptsPunches: !!device || s['attendance.allowUnregisteredDevices'],
      companyName: s['company.name'],
      timezone: s['company.timezone'],
      serverTime: this.clock.now().toISOString(),
    };
  }

  @Post('punch')
  @HttpCode(201)
  @Public()
  @SkipCsrf()
  // Busy kiosks serve many people from one IP; per-account PIN lockout is the main brute-force control.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async punch(
    @Body(new ZodValidationPipe(kioskPunchSchema)) body: KioskPunchInput,
    @Req() req: Request,
  ): Promise<KioskPunchResult> {
    const device = await this.devices.authenticate(req.header(KIOSK_TOKEN_HEADER));
    if (!device && !(await this.settings.get('attendance.allowUnregisteredDevices'))) {
      throw new UnauthenticatedError(
        ERROR_CODES.UNAUTHENTICATED,
        'This device is not registered for attendance. Ask IT to register it.',
      );
    }
    return this.punches.punch(body, device?.id ?? null, clientInfo(req));
  }
}

@Controller('kiosk-devices')
export class KioskDevicesController {
  constructor(private readonly devices: KioskDeviceService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.KIOSK_MANAGE)
  list() {
    return this.devices.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.KIOSK_MANAGE)
  register(
    @Body(new ZodValidationPipe(registerKioskSchema)) body: RegisterKioskInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.devices.register(auth, body.name, clientInfo(req));
  }

  @Post(':id/revoke')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.KIOSK_MANAGE)
  async revoke(
    @Param('id', uuid) id: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<void> {
    await this.devices.revoke(auth, id, clientInfo(req));
  }
}

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly query: AttendanceQueryService) {}

  @Get('me')
  @Authenticated()
  mine(
    @Query(new ZodValidationPipe(myAttendanceQuerySchema)) q: MyAttendanceQuery,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.query.range(auth.employeeId, q.from, q.to);
  }

  @Get('employees/:id')
  @Authenticated()
  async employee(
    @Param('id', uuid) id: string,
    @Query(new ZodValidationPipe(employeeAttendanceQuerySchema)) q: MyAttendanceQuery,
    @CurrentAuth() auth: AuthContext,
  ) {
    if (
      id !== auth.employeeId &&
      !auth.permissions.has(PERMISSIONS.ATTENDANCE_VIEW_ALL) &&
      !auth.permissions.has(PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT)
    )
      throw new ForbiddenError();
    await this.query.assertCanViewEmployee(auth, id);
    return this.query.range(id, q.from, q.to);
  }

  @Get('monitor')
  @Authenticated()
  monitor(
    @Query(new ZodValidationPipe(attendanceMonitorQuerySchema)) q: AttendanceMonitorQuery,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.query.monitor(auth, q);
  }
}

const assignScheduleSchema = z.object({ scheduleId: z.string().uuid().nullable() });

@Controller()
export class SchedulesController {
  constructor(private readonly schedules: ScheduleService) {}

  @Get('schedules')
  @RequirePermissions(PERMISSIONS.SCHEDULES_MANAGE)
  list() {
    return this.schedules.list();
  }

  @Post('schedules')
  @RequirePermissions(PERMISSIONS.SCHEDULES_MANAGE)
  create(
    @Body(new ZodValidationPipe(scheduleSchema)) body: ScheduleInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.schedules.create(auth, body, clientInfo(req));
  }

  @Put('schedules/:id')
  @RequirePermissions(PERMISSIONS.SCHEDULES_MANAGE)
  update(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(scheduleSchema)) body: ScheduleInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.schedules.update(auth, id, body, clientInfo(req));
  }

  @Put('employees/:id/schedule')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.SCHEDULES_MANAGE)
  async assign(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(assignScheduleSchema)) body: z.infer<typeof assignScheduleSchema>,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<void> {
    await this.schedules.assign(auth, id, body.scheduleId, clientInfo(req));
  }

  @Get('holidays/:year')
  @Authenticated()
  holidays(@Param('year', new ParseIntPipe()) year: number) {
    return this.schedules.listHolidays(Math.min(2100, Math.max(2000, year)));
  }

  @Post('holidays')
  @RequirePermissions(PERMISSIONS.SCHEDULES_MANAGE)
  addHoliday(
    @Body(new ZodValidationPipe(holidaySchema)) body: HolidayInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.schedules.addHoliday(auth, body, clientInfo(req));
  }

  @Delete('holidays/:id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.SCHEDULES_MANAGE)
  async removeHoliday(
    @Param('id', uuid) id: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<void> {
    await this.schedules.removeHoliday(auth, id, clientInfo(req));
  }
}
