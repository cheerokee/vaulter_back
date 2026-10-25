import { Injectable } from '@nestjs/common';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import { UserRepository } from '../domain/user.repository.js';
import type { Actor } from './dto/actor.js';
import { toUserView, type UserView } from './dto/user-view.js';

@Injectable()
export class GetMeUseCase {
  constructor(private readonly users: UserRepository) {}

  async execute(auth: Actor): Promise<UserView> {
    const user = await this.users.findById(auth.userId);
    if (!user) {
      throw new UnauthenticatedError(
        'invalid-access-token',
        'The access token is invalid or expired.',
      );
    }
    return toUserView(user);
  }
}
