import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Passwords that have been published and must never be chosen again.
 *
 * Kept as SHA-256 fingerprints of the normalised value, so this file does not
 * republish them. The first is the shared password the development seed once
 * used: it was printed in the README and on the live sign-in page of a public
 * repository, so anyone may know it.
 */
export const EXPOSED_PASSWORD_SHA256: readonly string[] = [
  '62b01c4adbd731db67119dce4c68c694ce35db2392d6d2eba34d894e0c6f5d9a',
];

/** Case and surrounding spaces do not make a published password a new one. */
function fingerprint(password: string): string {
  return createHash('sha256').update(password.trim().toLowerCase()).digest('hex');
}

export function isExposedPassword(password: string, exposed: readonly string[] = EXPOSED_PASSWORD_SHA256): boolean {
  return exposed.includes(fingerprint(password));
}

export const EXPOSED_PASSWORD_MESSAGE =
  'That password has been published and cannot be used. Choose one that nobody else knows.';

/**
 * The rule for a password a person chooses for themselves. One rule, so every
 * place that lets someone pick a password refuses the same things.
 */
export function newPasswordRule(exposed: readonly string[] = EXPOSED_PASSWORD_SHA256) {
  return z.string()
    .min(10, 'Choose a password of at least 10 characters.')
    .refine((p) => !isExposedPassword(p, exposed), EXPOSED_PASSWORD_MESSAGE);
}
