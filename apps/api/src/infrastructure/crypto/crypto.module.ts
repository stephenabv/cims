import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';
import { HashingService } from './hashing.service';
import { Clock, SystemClock } from '../clock/clock';

@Global()
@Module({
  providers: [HashingService, EncryptionService, { provide: Clock, useClass: SystemClock }],
  exports: [HashingService, EncryptionService, Clock],
})
export class CryptoModule {}
