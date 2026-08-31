import { PrismaClient } from '@prisma/client';
import { isProd } from './config.js';
import { auditMiddleware } from './middleware/audit-middleware.js';

export const prisma = new PrismaClient({
  log: isProd ? ['warn', 'error'] : ['warn', 'error'],
});

// Field-level change logging lives here, not in route handlers. A route that
// forgets to log is a hole in the audit trail; middleware cannot forget.
prisma.$use(auditMiddleware(prisma));

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
