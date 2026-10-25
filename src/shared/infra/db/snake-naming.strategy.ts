import { DefaultNamingStrategy } from 'typeorm';

function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

// Propriedades camelCase viram colunas snake_case. Nomes de tabela são explícitos nas entidades.
export class SnakeNamingStrategy extends DefaultNamingStrategy {
  override columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string {
    if (customName) return customName;
    return toSnake([...embeddedPrefixes, propertyName].join('_'));
  }

  override joinColumnName(
    relationName: string,
    referencedColumnName: string,
  ): string {
    return toSnake(`${relationName}_${referencedColumnName}`);
  }
}
