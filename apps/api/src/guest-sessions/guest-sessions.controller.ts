import {
  Controller,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import {
  GUEST_SESSION_COOKIE,
  GuestSessionsService,
} from './guest-sessions.service';

class GuestSessionResponse {
  @ApiProperty({ example: '2026-10-24T18:00:00.000Z' })
  expiresAt!: Date;
}

@ApiTags('guest sessions')
@Controller('guest-session')
export class GuestSessionsController {
  constructor(
    private readonly sessions: GuestSessionsService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Initialize the anonymous session used to own checkout replays',
  })
  @ApiCreatedResponse({ type: GuestSessionResponse })
  @ApiOkResponse({ type: GuestSessionResponse })
  async initialize(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<GuestSessionResponse> {
    const session = await this.sessions.initialize(
      request.cookies?.[GUEST_SESSION_COOKIE],
    );

    response.status(session.cookieToken ? 201 : 200);
    response.setHeader('Cache-Control', 'no-store');

    if (session.cookieToken) {
      const ttlDays = this.config.getOrThrow<number>('GUEST_SESSION_TTL_DAYS');
      const nodeEnvironment = this.config.getOrThrow<string>('NODE_ENV');
      response.cookie(GUEST_SESSION_COOKIE, session.cookieToken, {
        httpOnly: true,
        secure: nodeEnvironment === 'production',
        sameSite: 'lax',
        path: '/api/v1',
        maxAge: ttlDays * 24 * 60 * 60 * 1000,
      });
    }

    return { expiresAt: session.expiresAt };
  }
}
