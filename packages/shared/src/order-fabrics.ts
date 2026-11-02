/**
 * The order's fabrics as one list: Fabric, Fabric 2, Fabric 3 (the External
 * Order sheet's three slots), then any more typed on Order Details.
 */
export function orderFabrics(o: { fabric?: string | null; fabric2?: string | null; fabric3?: string | null; moreFabrics?: readonly string[] | null }): string[] {
  const out: string[] = [];
  for (const f of [o.fabric, o.fabric2, o.fabric3, ...(o.moreFabrics ?? [])]) {
    const t = (f ?? '').trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** A fabric list as the order's four fields store it. */
export function fabricFields(list: readonly string[]): { fabric: string | null; fabric2: string | null; fabric3: string | null; moreFabrics: string[] } {
  const clean = orderFabrics({ moreFabrics: list });
  return { fabric: clean[0] ?? null, fabric2: clean[1] ?? null, fabric3: clean[2] ?? null, moreFabrics: clean.slice(3) };
}
