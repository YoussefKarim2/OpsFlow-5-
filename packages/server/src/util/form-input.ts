import { z } from 'zod';

/**
 * What a form actually sends, as opposed to what an API would like.
 *
 * A `<select>` with nothing chosen sends `""`. A date input that has been
 * cleared sends `""`. A number input that has been emptied sends `NaN`, which
 * becomes `null` on the way through JSON. None of those mean the field is being
 * *set* to something — they mean it is empty — and a schema that takes them
 * literally turns an ordinary save into an error.
 *
 * The cost of getting this wrong was total. Order Details sends every field on
 * every save, so an order with no coordinator sent `coordinatorId: ""`,
 * Postgres was asked for the user whose id is the empty string, and "Save
 * changes" failed with a foreign-key error on orders that had nothing wrong
 * with them. Twelve realistic saves were tried and twelve failed.
 *
 * Normalising here rather than in the browser fixes it for every client at
 * once, and means the next screen built against these endpoints cannot
 * reintroduce it.
 */

/** An optional relation: "" means nobody, which is null — not a missing row. */
export const relationId = z.preprocess(
  (v) => (v === '' ? null : v),
  z.string().nullable().optional(),
);

/**
 * A relation that is mandatory on create but must survive a blank on update.
 *
 * An order must have a client, so creating one without is a real error. But an
 * *edit* form that sends `clientId: ""` is not asking to remove the client — it
 * is a form field that happened to be empty — and refusing the whole save over
 * it loses every other change on the screen. So "" means "leave it as it is",
 * and the inner schema is optional to let that through.
 *
 * Use it on update schemas; keep `z.string().min(1)` on create, where a missing
 * value genuinely is a mistake worth reporting.
 */
export const requiredRelationId = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
);

/** A date the form may have cleared. "" is not a date; it is no answer. */
export const optionalDate = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().optional(),
);

/**
 * A number input that was emptied.
 *
 * `Number('')` is 0 and `Number('abc')` is NaN, and `JSON.stringify` turns NaN
 * into null — so "I cleared this box" arrives as null and a plain `z.number()`
 * rejects the whole request over a field the user deliberately left empty.
 */
export const optionalNumber = (schema: z.ZodNumber) =>
  z.preprocess(
    (v) => (v === '' || v === null || (typeof v === 'number' && Number.isNaN(v)) ? undefined : v),
    schema.optional(),
  );

/**
 * A free-text field with a sane ceiling.
 *
 * The order fields were unbounded, so a 100,000-character order name was
 * accepted and stored — it renders into every list, every email and every PDF,
 * and bloats every response that mentions the order. Nothing legitimate needs
 * more than a couple of hundred characters, and a paste accident should be
 * refused at the door rather than discovered on a screen that will not load.
 *
 * Generous on purpose: addresses and notes are genuinely long.
 */
export const shortText = (max = 200) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().max(max).optional());

export const longText = (max = 20_000) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().max(max).optional());
