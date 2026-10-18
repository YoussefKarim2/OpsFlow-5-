import { z } from 'zod';

/** A real calendar date from the client, or a 400 — never an Invalid Date handed to Prisma. */
export const dateInput = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Not a valid date.');
