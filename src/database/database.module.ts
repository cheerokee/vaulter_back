import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmOptions } from './typeorm.options.js';

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
})
export class DatabaseModule {}
