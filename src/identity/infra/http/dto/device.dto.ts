import { IsIn, IsString, Length } from 'class-validator';
import type { DevicePlatform } from '../../../domain/session.js';

export const DEVICE_PLATFORMS: DevicePlatform[] = [
  'android',
  'ios',
  'hub',
  'web',
  'other',
];

export class DeviceDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsIn(DEVICE_PLATFORMS)
  platform!: DevicePlatform;
}
