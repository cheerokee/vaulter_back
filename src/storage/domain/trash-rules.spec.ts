import { MAX_TRASH_VERSIONS_PER_OBJECT } from './backup-limits.js';
import { TrashRules } from './trash-rules.js';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 12, minute, 0));
const id = (n: number) =>
  `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('TrashRules.beyondCap', () => {
  it('the cap is 10 old versions per object', () => {
    expect(MAX_TRASH_VERSIONS_PER_OBJECT).toBe(10);
  });

  it('keeps exactly the 10 newest superseded versions and returns the older ones', () => {
    // 12 superseded versions, given out of order.
    const superseded = [5, 1, 12, 3, 8, 2, 11, 4, 9, 6, 10, 7].map((n) => ({
      id: id(n),
      supersededAt: at(n),
    }));
    expect(TrashRules.beyondCap(superseded).sort()).toEqual([id(1), id(2)]);
  });

  it('returns nothing at or under the cap', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      id: id(i + 1),
      supersededAt: at(i + 1),
    }));
    expect(TrashRules.beyondCap(ten)).toEqual([]);
    expect(TrashRules.beyondCap([])).toEqual([]);
  });

  it('breaks supersededAt ties by id (the newer UUID v7 stays)', () => {
    const same = Array.from({ length: 11 }, (_, i) => ({
      id: id(i + 1),
      supersededAt: at(0),
    }));
    expect(TrashRules.beyondCap(same)).toEqual([id(1)]);
  });

  it('accepts another cap', () => {
    const three = [1, 2, 3].map((n) => ({ id: id(n), supersededAt: at(n) }));
    expect(TrashRules.beyondCap(three, 1).sort()).toEqual([id(1), id(2)]);
  });
});

describe('TrashRules.purgeable', () => {
  it('drops the live version of a live object from the candidates, whatever they say', () => {
    const live = { id: 'o1', liveVersionId: id(1) };
    expect(
      TrashRules.purgeable(
        [id(1), id(2), id(3)],
        [live, { id: 'o2', liveVersionId: null }],
      ),
    ).toEqual([id(2), id(3)]);
  });
});
