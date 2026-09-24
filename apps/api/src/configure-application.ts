import { ValidationPipe, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { GUEST_SESSION_COOKIE } from './guest-sessions/guest-sessions.service';

export function configureApplication(
  app: INestApplication,
  config: ConfigService,
): void {
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: config.getOrThrow<string>('WEB_ORIGIN'),
    credentials: true,
  });
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
    .addCookieAuth(
      GUEST_SESSION_COOKIE,
      { type: 'apiKey', in: 'cookie', name: GUEST_SESSION_COOKIE },
      'guest-session',
    )
    .build();
  const document = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('api/v1/docs', app, document);
}
