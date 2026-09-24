import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DatabaseService } from '../database/database.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('live')
  @ApiOperation({ summary: 'Check whether the API process is running' })
  @ApiResponse({ status: 200, description: 'The API process is alive.' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check whether the API can serve requests' })
  @ApiResponse({ status: 200, description: 'The API and database are ready.' })
  @ApiResponse({ status: 503, description: 'A required dependency is unavailable.' })
  async ready(): Promise<{ status: 'ok'; checks: { database: 'ok' } }> {
    try {
      await this.database.ping();
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        checks: { database: 'unavailable' },
      });
    }

    return { status: 'ok', checks: { database: 'ok' } };
  }
}
