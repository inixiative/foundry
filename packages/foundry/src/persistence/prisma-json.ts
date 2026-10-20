/**
 * @atlas
 * @kind transformer
 * @partOf infrastructure:prisma
 */
import type { Prisma } from '@prisma/client';

export type PrismaJsonValue = Prisma.InputJsonValue | typeof Prisma.JsonNull;
export type OptionalPrismaJsonValue = PrismaJsonValue | undefined;

let jsonNull: typeof Prisma.JsonNull | undefined;
// why: the generated client exists only where Postgres persistence is set up, so load it on first write.
const prismaJsonNull = () =>
  (jsonNull ??= (require('@prisma/client') as typeof import('@prisma/client')).Prisma.JsonNull);

export function toPrismaJson(value: unknown): PrismaJsonValue {
  return value === null ? prismaJsonNull() : (value as Prisma.InputJsonValue);
}

export function toOptionalPrismaJson(value: unknown): OptionalPrismaJsonValue {
  return value === undefined ? undefined : toPrismaJson(value);
}
