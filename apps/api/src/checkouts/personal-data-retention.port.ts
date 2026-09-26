export const PERSONAL_DATA_RETENTION = Symbol('PERSONAL_DATA_RETENTION');

export interface PersonalDataRetentionPort {
  redactExpiredCheckoutBatch(limit: number): Promise<number>;
}
