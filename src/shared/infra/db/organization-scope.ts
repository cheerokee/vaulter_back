import type {
  DataSource,
  EntityManager,
  EntityTarget,
  Repository,
} from 'typeorm';
import { runInTransaction, setTransactionContext } from './unit-of-work.js';

// Roda `work` numa transação com o contexto da organização. Dentro de um `UnitOfWork.run` (mesmo
// DataSource), entra na transação ativa e o contexto vale até o fim dela; fora, abre a própria.
// `set_config(..., true)` vale só até o fim da transação, então não vaza para a próxima da mesma conexão.
export function runInOrganizationScope<T>(
  dataSource: DataSource,
  organizationId: string,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return runInTransaction(dataSource, async (manager) => {
    await setTransactionContext(manager, { organizationId });
    return work(manager);
  });
}

// Base dos repositórios de dado de cliente. Todo método público das subclasses recebe `organizationId`
// como primeiro parâmetro e filtra `where: { organizationId }` (primeira trava); o RLS é a segunda.
export abstract class OrganizationScopedRepository<
  TEntity extends { organizationId: string },
> {
  protected constructor(
    private readonly dataSource: DataSource,
    private readonly target: EntityTarget<TEntity>,
  ) {}

  protected scoped<T>(
    organizationId: string,
    work: (repo: Repository<TEntity>) => Promise<T>,
  ): Promise<T> {
    return runInOrganizationScope(this.dataSource, organizationId, (manager) =>
      work(manager.getRepository(this.target)),
    );
  }
}
