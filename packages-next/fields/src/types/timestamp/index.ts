import type { FieldType, BaseGeneratedListTypes, FieldDefaultValue } from '@keystone-next/types';
import { resolveView } from '../../resolve-view';
import type { FieldConfig } from '../../interfaces';
import { DateTimeUtcImplementation, PrismaDateTimeUtcInterface } from './Implementation';

export type TimestampFieldConfig<
  TGeneratedListTypes extends BaseGeneratedListTypes
> = FieldConfig<TGeneratedListTypes> & {
  defaultValue?: FieldDefaultValue<string>;
  isRequired?: boolean;
  isUnique?: boolean;
};

export const timestamp = <TGeneratedListTypes extends BaseGeneratedListTypes>(
  config: TimestampFieldConfig<TGeneratedListTypes> = {}
): FieldType<TGeneratedListTypes> => ({
  type: {
    type: 'DateTimeUtc',
    implementation: DateTimeUtcImplementation,
    adapters: { prisma: PrismaDateTimeUtcInterface },
  },
  config,
  views: resolveView('timestamp/views'),
});
