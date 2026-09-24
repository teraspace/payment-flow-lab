import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { DATABASE_POOL, DatabaseService } from './database.service';

@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const connectionString = config.get<string>('DATABASE_URL');
        const sslEnabled = config.getOrThrow<boolean>('DATABASE_SSL');
        const caFile = config.get<string>('DATABASE_SSL_CA_FILE');
        const connection = connectionString
          ? { connectionString }
          : {
              host: config.getOrThrow<string>('DATABASE_HOST'),
              port: config.getOrThrow<number>('DATABASE_PORT'),
              database: config.getOrThrow<string>('DATABASE_NAME'),
              user: config.getOrThrow<string>('DATABASE_USER'),
              password: config.getOrThrow<string>('DATABASE_PASSWORD'),
            };

        return new Pool({
          ...connection,
          ssl: sslEnabled
            ? {
                rejectUnauthorized: true,
                ...(caFile ? { ca: readFileSync(caFile, 'utf8') } : {}),
              }
            : undefined,
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });
      },
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
