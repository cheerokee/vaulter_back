import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnitOfWork } from '../shared/infra/db/unit-of-work.js';
import { typeOrmOptions } from './typeorm.options.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...typeOrmOptions('app'),
        // Entidades entram via TypeOrmModule.forFeature() de cada módulo.
        autoLoadEntities: true,
      }),
    }),
  ],
  providers: [UnitOfWork],
  exports: [UnitOfWork],
})
export class DatabaseModule {}
