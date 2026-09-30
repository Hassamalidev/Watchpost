/* UUIDv7 identifiers (time-ordered), used for every row and request ID (PRODUCT.md §7.11). */
import { v7 as uuidv7, validate, version } from "uuid";

export function newId(): string {
  return uuidv7();
}

export function isUuidV7(value: string): boolean {
  return validate(value) && version(value) === 7;
}
