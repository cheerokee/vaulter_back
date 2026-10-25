import { newId } from './id.js';

export abstract class Entity<TProps> {
  readonly id: string;
  protected props: TProps;

  protected constructor(props: TProps, id?: string) {
    this.props = props;
    this.id = id ?? newId();
  }
}
