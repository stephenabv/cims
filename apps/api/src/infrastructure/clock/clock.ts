import { Injectable } from '@nestjs/common';

/** Time source port; injected so time-dependent rules are deterministic under test. */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
