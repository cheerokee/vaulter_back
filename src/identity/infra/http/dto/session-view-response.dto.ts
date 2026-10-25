import type { CursorPage } from '../../../../shared/domain/pagination.js';
import type { SessionView } from '../../../application/dto/session-view.js';

export class SessionViewResponse {
  id!: string;
  deviceName!: string;
  devicePlatform!: string;
  createdAt!: string;
  lastUsedAt!: string;
  lastIp!: string | null;
  current!: boolean;

  static from(view: SessionView): SessionViewResponse {
    const res = new SessionViewResponse();
    res.id = view.id;
    res.deviceName = view.deviceName;
    res.devicePlatform = view.devicePlatform;
    res.createdAt = view.createdAt.toISOString();
    res.lastUsedAt = view.lastUsedAt.toISOString();
    res.lastIp = view.lastIp;
    res.current = view.current;
    return res;
  }
}

export class SessionPageResponse {
  items!: SessionViewResponse[];
  nextCursor!: string | null;

  static from(page: CursorPage<SessionView>): SessionPageResponse {
    const res = new SessionPageResponse();
    res.items = page.items.map((i) => SessionViewResponse.from(i));
    res.nextCursor = page.nextCursor;
    return res;
  }
}
