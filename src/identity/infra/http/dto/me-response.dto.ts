import type { UserView } from '../../../application/dto/user-view.js';

export class MeResponse {
  id!: string;
  name!: string;
  email!: string;
  createdAt!: string;

  static from(view: UserView): MeResponse {
    const res = new MeResponse();
    res.id = view.id;
    res.name = view.name;
    res.email = view.email;
    res.createdAt = view.createdAt.toISOString();
    return res;
  }
}
