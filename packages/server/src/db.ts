import { PrismaClient } from '@prisma/client';
import { isProd } from './config.js';
import { auditMiddleware } from './middleware/audit-middleware.js';
import { orderAccessMiddleware } from './services/order-access.js';

export const prisma = new PrismaClient({
  log: isProd ? ['warn', 'error'] : ['warn', 'error'],
});

// Field-level change logging lives here, not in route handlers. A route that
// forgets to log is a hole in the audit trail; middleware cannot forget.
prisma.$use(auditMiddleware(prisma));

// Order access. Registered after the audit middleware so the audit trail still
// sees every write; this one only narrows reads. Applied here rather than in
// two dozen routes because an access rule applied in twenty-four places is an
// access rule missing from the twenty-fifth.
prisma.$use(orderAccessMiddleware());

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
