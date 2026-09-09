-- The customer delivery addresses the factory actually ships to.
--
-- Reference rows rather than an enum or a hardcoded list, reusing the
-- `ref_values` table the rest of the application already reads through
-- `/api/lookups`. A new customer address is then a row, not a deploy — and the
-- order's `shippingAddress` column stays free text underneath, so an address
-- nobody has listed is still typeable rather than blocked.
--
-- Transcribed from the workbook's own dropdown, punctuation and all: these are
-- matched by eye against shipping documents, and "tidying" an address is how a
-- consignment ends up at the wrong door.
--
-- Ids derive from the position so a re-run produces the same rows, and the
-- unique constraint on (kind, value) makes the insert idempotent regardless.
INSERT INTO "ref_values" ("id", "kind", "value", "position") VALUES
  ('cl' || substr(md5('shipaddr:0'), 1, 22), 'SHIPPING_ADDRESS'::"RefKind", 'PROTIME SPORTS INC 18200 SEGALE PARK DRIVE B SEATTLE, WA 98188. USA TEL: 800-575-1603', 0),
  ('cl' || substr(md5('shipaddr:1'), 1, 22), 'SHIPPING_ADDRESS'::"RefKind", 'Dronken House,43a High Street,Kings Langley Hertfordshire,WD4 8FG,Great Brittain,UK', 1),
  ('cl' || substr(md5('shipaddr:2'), 1, 22), 'SHIPPING_ADDRESS'::"RefKind", 'Heritage Leisure Design 3 King Street Newcastle - Under- Lyme ST5 1EN ,UK .Phone 01782 618115   Mr.Andrew', 2),
  ('cl' || substr(md5('shipaddr:3'), 1, 22), 'SHIPPING_ADDRESS'::"RefKind", 'KITTRICH CORPORATION 1585 WEST MISSION BLVD POMONA, CA 91766 CTC: Franchesca, TEL: 714-736-2053  FAX: 714-736-2110', 3)
ON CONFLICT ("kind", "value") DO NOTHING;
