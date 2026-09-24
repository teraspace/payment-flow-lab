import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.use(helmet());
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: config.getOrThrow<string>('WEB_ORIGIN') });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const openApiConfig = new DocumentBuilder()
    .setTitle('Payment Flow Lab API')
    .setDescription('API contract for the checkout engineering challenge.')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('api/v1/docs', app, document);

  app.enableShutdownHooks();
  await app.listen(config.getOrThrow<number>('API_PORT'), '0.0.0.0');
}

void bootstrap();
