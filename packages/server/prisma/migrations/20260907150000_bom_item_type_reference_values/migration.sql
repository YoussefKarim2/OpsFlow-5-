-- The BOM material and accessory dropdown, as reference data.
--
-- Reference rows rather than an enum, reusing the `ref_values` table the rest of
-- the application already reads through `/api/lookups`. An enum would need a
-- migration every time the factory met a trim nobody had listed; a row does not,
-- and the BOM item name is free text besides, so an unlisted item is still
-- typeable rather than blocked.
--
-- Ordered as the categories were given — fabrics, branding, labels, trims,
-- packaging, other — because a dropdown sorted alphabetically puts "Button"
-- above "Main Fabric" and reads like a jumble to the person using it.
--
-- Ids are derived from the value so a re-run produces the same row, and the
-- unique constraint on (kind, value) makes the insert idempotent regardless.
INSERT INTO "ref_values" ("id", "kind", "value", "position") VALUES
  ('cl' || substr(md5('bomtype:Main Fabric'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Main Fabric', 0),
  ('cl' || substr(md5('bomtype:Lining'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Lining', 1),
  ('cl' || substr(md5('bomtype:Contrast Fabric'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Contrast Fabric', 2),
  ('cl' || substr(md5('bomtype:Rib'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Rib', 3),
  ('cl' || substr(md5('bomtype:Mesh'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Mesh', 4),
  ('cl' || substr(md5('bomtype:Interlining'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Interlining', 5),
  ('cl' || substr(md5('bomtype:Other Fabric'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Other Fabric', 6),
  ('cl' || substr(md5('bomtype:Logo Badge'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Logo Badge', 7),
  ('cl' || substr(md5('bomtype:Embroidered Badge'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Embroidered Badge', 8),
  ('cl' || substr(md5('bomtype:Woven Badge'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Woven Badge', 9),
  ('cl' || substr(md5('bomtype:Printed Logo'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Printed Logo', 10),
  ('cl' || substr(md5('bomtype:Embroidery'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Embroidery', 11),
  ('cl' || substr(md5('bomtype:Heat Transfer'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Heat Transfer', 12),
  ('cl' || substr(md5('bomtype:Sublimation'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Sublimation', 13),
  ('cl' || substr(md5('bomtype:Screen Printing'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Screen Printing', 14),
  ('cl' || substr(md5('bomtype:Main Label'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Main Label', 15),
  ('cl' || substr(md5('bomtype:Neck Label'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Neck Label', 16),
  ('cl' || substr(md5('bomtype:Size Label'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Size Label', 17),
  ('cl' || substr(md5('bomtype:Care Label'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Care Label', 18),
  ('cl' || substr(md5('bomtype:Composition Label'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Composition Label', 19),
  ('cl' || substr(md5('bomtype:Woven Label'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Woven Label', 20),
  ('cl' || substr(md5('bomtype:Zipper'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Zipper', 21),
  ('cl' || substr(md5('bomtype:Button'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Button', 22),
  ('cl' || substr(md5('bomtype:Snap Button'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Snap Button', 23),
  ('cl' || substr(md5('bomtype:Velcro'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Velcro', 24),
  ('cl' || substr(md5('bomtype:Elastic'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Elastic', 25),
  ('cl' || substr(md5('bomtype:Drawstring'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Drawstring', 26),
  ('cl' || substr(md5('bomtype:Cord'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Cord', 27),
  ('cl' || substr(md5('bomtype:Thread'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Thread', 28),
  ('cl' || substr(md5('bomtype:Eyelet'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Eyelet', 29),
  ('cl' || substr(md5('bomtype:Polybag'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Polybag', 30),
  ('cl' || substr(md5('bomtype:Packaging Bag'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Packaging Bag', 31),
  ('cl' || substr(md5('bomtype:Hang Tag'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Hang Tag', 32),
  ('cl' || substr(md5('bomtype:Swing Tag'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Swing Tag', 33),
  ('cl' || substr(md5('bomtype:Carton'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Carton', 34),
  ('cl' || substr(md5('bomtype:Sticker'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Sticker', 35),
  ('cl' || substr(md5('bomtype:Other'), 1, 22), 'BOM_ITEM_TYPE'::"RefKind", 'Other', 36)
ON CONFLICT ("kind", "value") DO NOTHING;
