import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // Variables come from the real process environment only; the app loads no dotfiles.
      ignoreEnvFile: true,
      validate: validateEnv,
    }),
  ],
})
export class ConfigModule {}
