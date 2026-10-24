import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { typeOrmOptions } from './typeorm.options.js';

// DataSource usado só pelo CLI do TypeORM (scripts migration:* do package.json).
// Roda compilado em dist/typeorm/, por isso os globs apontam para .js.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default new DataSource({
  ...typeOrmOptions(),
  entities: [join(import.meta.dirname, '..', '**', '*.entity.js')],
  migrations: [join(import.meta.dirname, 'migrations', '*.js')],
});
