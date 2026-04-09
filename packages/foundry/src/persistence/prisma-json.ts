import { Prisma } from "@prisma/client";

export type PrismaJsonValue = Prisma.InputJsonValue | typeof Prisma.JsonNull;
export type OptionalPrismaJsonValue = PrismaJsonValue | undefined;

export function toPrismaJson(value: unknown): PrismaJsonValue {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

export function toOptionalPrismaJson(value: unknown): OptionalPrismaJsonValue {
  return value === undefined ? undefined : toPrismaJson(value);
}
