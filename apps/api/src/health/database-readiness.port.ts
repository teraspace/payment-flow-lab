export const DATABASE_READINESS = Symbol('DATABASE_READINESS');

export interface DatabaseReadinessPort {
  ping(): Promise<void>;
}
