import {
  Client,
  createTestApp,
  createUser,
  DEFAULT_UNDERTIME_POLICY_ID,
  loginPrivileged,
  resetData,
  type TestContext,
  type TestUser,
} from './helpers';

/** Default schedule Mon–Fri 08:00–17:00 (60-min break), Asia/Manila. Today is Fri 2026-11-06. */
const manila = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);
const REASON = 'Kiosk was down, confirmed by supervisor';

const terms = (over: Record<string, unknown> = {}) => ({
  effectiveFrom: '2026-11-01',
  hourlyRateCentavos: 10_000,
  overtimeRateKind: 'MULTIPLIER',
  overtimeMultiplierPermille: 1250,
  undertimePolicyId: DEFAULT_UNDERTIME_POLICY_ID,
  paySchedule: 'SEMI_MONTHLY',
  ...over,
});

describe('Payroll setup (integration)', () => {
  let ctx: TestContext;
  let staff: TestUser;
  let hrUser: TestUser;
  let hr: Client;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.prisma.$disconnect();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetData(ctx.prisma);
    ctx.clock.set(manila('2026-11-06', '10:00'));
    staff = await createUser(ctx.prisma);
    hrUser = await createUser(ctx.prisma, { role: 'HR' });
    hr = new Client(ctx.app);
    await loginPrivileged(hr, hrUser, ctx.clock);
  });

  const punch = (date: string, type: 'TIME_IN' | 'TIME_OUT', time: string) =>
    hr.post(`/attendance/employees/${staff.employeeId}/punches`, {
      type,
      date,
      time,
      reason: REASON,
    });
  const typeId = async (code: string) =>
    (await ctx.prisma.payItemType.findUniqueOrThrow({ where: { code } })).id;

  it('sets pay terms and deductions, and previews pay from attendance and approved overtime', async () => {
    const saved = await hr.post(`/payroll/compensation/${staff.employeeId}/profiles`, terms());
    expect(saved.status).toBe(201);
    expect(saved.body.profiles).toEqual([
      expect.objectContaining({
        effectiveFrom: '2026-11-01',
        hourlyRateCentavos: 10_000,
        isCurrent: true,
        canRemove: false,
        undertimePolicy: { id: DEFAULT_UNDERTIME_POLICY_ID, name: 'Hourly-rate equivalent' },
      }),
    ]);
    await hr.post(`/payroll/compensation/${staff.employeeId}/items`, {
      typeId: await typeId('SSS'),
      calculation: 'FIXED',
      amountCentavos: 50_000,
      effectiveFrom: '2026-11-01',
    });
    await hr.post(`/payroll/compensation/${staff.employeeId}/items`, {
      typeId: await typeId('PHIC'),
      calculation: 'PERCENT_OF_GROSS',
      rateBasisPoints: 250,
      effectiveFrom: '2026-11-01',
    });

    // Mon: 08:00–18:00 (60 min overtime, approved). Tue: in at 08:30 (30 min late).
    await punch('2026-11-02', 'TIME_IN', '08:00');
    await punch('2026-11-02', 'TIME_OUT', '18:00');
    await punch('2026-11-03', 'TIME_IN', '08:30');
    await punch('2026-11-03', 'TIME_OUT', '17:00');
    await punch('2026-11-04', 'TIME_IN', '08:00'); // no time-out yet
    const ot = await ctx.prisma.overtimeRecord.findFirstOrThrow();
    await hr.post(`/overtime/${ot.id}/decide`, { decision: 'APPROVE', version: 1 });

    const preview = await hr.get(
      `/payroll/compensation/${staff.employeeId}/preview?from=2026-11-01&to=2026-11-15`,
    );
    expect(preview.status).toBe(200);
    const byKind = Object.fromEntries(
      preview.body.lines.map((l: { label: string; amountCentavos: number }) => [
        l.label,
        l.amountCentavos,
      ]),
    );
    expect(byKind).toEqual({
      'Regular pay': 160_000,
      'Approved overtime': 12_500,
      'Late and undertime (Hourly-rate equivalent)': -5_000,
      'SSS contribution': -50_000,
      'PhilHealth contribution': -4_188, // 2.5% of ₱1,675.00
    });
    expect(preview.body).toMatchObject({
      grossCentavos: 172_500,
      deductionsCentavos: 59_188,
      netCentavos: 113_312,
    });
    expect(preview.body.warnings).toEqual([
      expect.objectContaining({ code: 'INCOMPLETE_DAY', date: '2026-11-04' }),
    ]);

    // Every look at one person's pay is audited.
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          actorUserId: hrUser.userId,
          action: { in: ['payroll.compensation.view', 'payroll.preview'] },
        },
      }),
    ).toBe(4); // three saves return the overview, plus the preview
  });

  it('keeps pay terms as dated versions and guards who may change them', async () => {
    await hr.post(`/payroll/compensation/${staff.employeeId}/profiles`, terms());
    const dup = await hr.post(`/payroll/compensation/${staff.employeeId}/profiles`, terms());
    expect(dup.status).toBe(409);
    const raise = await hr.post(
      `/payroll/compensation/${staff.employeeId}/profiles`,
      terms({ effectiveFrom: '2026-11-16', hourlyRateCentavos: 12_000 }),
    );
    expect(
      raise.body.profiles.map(
        (p: { effectiveFrom: string; isCurrent: boolean; canRemove: boolean }) => [
          p.effectiveFrom,
          p.isCurrent,
          p.canRemove,
        ],
      ),
    ).toEqual([
      ['2026-11-16', false, true],
      ['2026-11-01', true, false],
    ]);
    const [future, started] = raise.body.profiles;
    expect((await hr.del(`/payroll/compensation/profiles/${started.id}`)).status).toBe(409);
    expect((await hr.del(`/payroll/compensation/profiles/${future.id}`)).status).toBe(204);

    const bad = await hr.post(
      `/payroll/compensation/${staff.employeeId}/profiles`,
      terms({ effectiveFrom: '2026-12-01', overtimeRateKind: 'FIXED' }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('overtimeFixedRateCentavos');

    // Nobody sets their own pay; staff cannot see anyone's.
    expect(
      (await hr.post(`/payroll/compensation/${hrUser.employeeId}/profiles`, terms())).status,
    ).toBe(403);
    const staffC = new Client(ctx.app);
    await staffC.login(staff);
    expect((await staffC.get('/payroll/compensation')).status).toBe(403);
    expect((await staffC.get(`/payroll/compensation/${staff.employeeId}`)).status).toBe(403);
    expect((await staffC.get('/payroll/undertime-policies')).status).toBe(403);

    const list = await hr.get('/payroll/compensation?missing=true');
    expect(list.body.data.map((r: { employee: { id: string } }) => r.employee.id)).toEqual([
      hrUser.employeeId,
    ]);
  });

  it('runs allowances and deductions between dates', async () => {
    const allowanceType = await hr.post('/payroll/item-types', {
      code: 'RICE',
      name: 'Rice allowance',
      direction: 'ALLOWANCE',
    });
    expect(allowanceType.status).toBe(403); // HR does not configure payroll rules
    const ceoUser = await createUser(ctx.prisma, { role: 'CEO' });
    const ceo = new Client(ctx.app);
    await loginPrivileged(ceo, ceoUser, ctx.clock);
    const rice = await ceo.post('/payroll/item-types', {
      code: 'rice',
      name: 'Rice allowance',
      direction: 'ALLOWANCE',
    });
    expect(rice.body).toMatchObject({ code: 'RICE', direction: 'ALLOWANCE' });

    const add = (body: Record<string, unknown>) =>
      hr.post(`/payroll/compensation/${staff.employeeId}/items`, body);
    expect(
      (
        await add({
          typeId: rice.body.id,
          calculation: 'PERCENT_OF_GROSS',
          rateBasisPoints: 100,
          effectiveFrom: '2026-11-01',
        })
      ).status,
    ).toBe(400);
    const running = await add({
      typeId: rice.body.id,
      calculation: 'FIXED',
      amountCentavos: 100_000,
      effectiveFrom: '2026-11-01',
    });
    const item = running.body.items[0];
    expect(item).toMatchObject({ isActive: true, canRemove: false, effectiveTo: null });
    expect((await hr.del(`/payroll/compensation/items/${item.id}`)).status).toBe(409);
    expect(
      (
        await hr.post(`/payroll/compensation/items/${item.id}/end`, {
          effectiveTo: '2026-10-31',
          version: 1,
        })
      ).status,
    ).toBe(400);
    const ended = await hr.post(`/payroll/compensation/items/${item.id}/end`, {
      effectiveTo: '2026-11-30',
      version: 1,
    });
    expect(ended.body.items[0]).toMatchObject({ effectiveTo: '2026-11-30', version: 2 });
    expect(
      (
        await hr.post(`/payroll/compensation/items/${item.id}/end`, {
          effectiveTo: '2026-12-31',
          version: 1,
        })
      ).status,
    ).toBe(409);

    const later = await add({
      typeId: await typeId('WTAX'),
      calculation: 'FIXED',
      amountCentavos: 20_000,
      effectiveFrom: '2026-12-01',
    });
    const future = later.body.items.find((i: { canRemove: boolean }) => i.canRemove);
    expect((await hr.del(`/payroll/compensation/items/${future.id}`)).status).toBe(204);
  });

  it('lets payroll configurers define undertime policies, validating each kind', async () => {
    const ceoUser = await createUser(ctx.prisma, { role: 'CEO' });
    const ceo = new Client(ctx.app);
    await loginPrivileged(ceo, ceoUser, ctx.clock);
    const block = await ceo.post('/payroll/undertime-policies', {
      name: '₱50 per 30 minutes',
      kind: 'FIXED_PER_BLOCK',
      blockMinutes: 30,
      amountPerBlockCentavos: 5_000,
      tiers: [{ upToMinutes: 10, amountCentavos: 1 }], // ignored for this kind
    });
    expect(block.status).toBe(201);
    expect(block.body).toMatchObject({ kind: 'FIXED_PER_BLOCK', tiers: null, isDefault: false });

    const badTiers = await ceo.post('/payroll/undertime-policies', {
      name: 'Table',
      kind: 'TIERED',
      tiers: [
        { upToMinutes: 30, amountCentavos: 5_000 },
        { upToMinutes: 15, amountCentavos: 2_000 },
      ],
    });
    expect(badTiers.status).toBe(400);
    expect(
      (
        await ceo.post('/payroll/undertime-policies', {
          name: '₱50 per 30 minutes',
          kind: 'HOURLY_EQUIVALENT',
        })
      ).status,
    ).toBe(409);

    const all = await ceo.post(`/payroll/undertime-policies/${block.body.id}/default`);
    expect(all.body.find((p: { isDefault: boolean }) => p.isDefault).id).toBe(block.body.id);
    expect(
      (
        await ceo.put(`/payroll/undertime-policies/${block.body.id}`, {
          ...block.body,
          isActive: false,
        })
      ).status,
    ).toBe(409);
    expect((await hr.get('/payroll/undertime-policies')).body).toHaveLength(2);
  });
});
