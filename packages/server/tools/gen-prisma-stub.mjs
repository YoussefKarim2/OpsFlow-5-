// Generate a structural @prisma/client type stub from schema.prisma so the
// server can be typechecked without the Prisma engine binaries.
import fs from 'fs';

const src = fs.readFileSync('packages/server/prisma/schema.prisma', 'utf8');
const lines = src.split('\n');
const models = new Map(), enums = new Map();
let cur = null, kind = null;

for (const raw of lines) {
  const line = raw.replace(/\/\/\/?.*$/, '').trim();
  let m;
  if ((m = line.match(/^model\s+(\w+)\s*\{/))) { cur = m[1]; kind = 'model'; models.set(cur, []); continue; }
  if ((m = line.match(/^enum\s+(\w+)\s*\{/))) { cur = m[1]; kind = 'enum'; enums.set(cur, []); continue; }
  if (line === '}') { cur = null; kind = null; continue; }
  if (!cur) continue;
  if (kind === 'enum') { if (/^\w+$/.test(line)) enums.get(cur).push(line); continue; }
  if (line.startsWith('@@')) continue;
  const f = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
  if (f) models.get(cur).push({ name: f[1], type: f[2], list: !!f[3], opt: !!f[4] });
}

const SCALAR = {
  String: 'string', Int: 'number', BigInt: 'bigint', Float: 'number',
  Decimal: 'Prisma.Decimal', Boolean: 'boolean', DateTime: 'Date',
  Json: 'Prisma.JsonValue', Bytes: 'Buffer',
};

const tsType = (f) => {
  let t;
  if (SCALAR[f.type]) t = SCALAR[f.type];
  else if (enums.has(f.type)) t = f.type;
  else if (models.has(f.type)) t = f.type;
  else t = 'any';
  if (f.list) t += '[]';
  if (f.opt) t += ' | null';
  return t;
};

let out = `// AUTO-GENERATED type stub for offline typechecking. Not the real client.
declare module '@prisma/client' {
`;

for (const [name, vals] of enums) {
  out += `  export type ${name} = ${vals.map(v => `'${v}'`).join(' | ')};\n`;
}
out += '\n';

for (const [name, fields] of models) {
  out += `  export interface ${name} {\n`;
  for (const f of fields) out += `    ${f.name}: ${tsType(f)};\n`;
  // Relation counts and loose extras that `include`/`select` can add.
  out += `    _count: any;\n  }\n`;
}

out += `
  export namespace Prisma {
    export class Decimal {
      constructor(v: string | number | Decimal);
      toString(): string;
      toNumber(): number;
    }
    export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
    export type InputJsonValue = JsonValue;
    export type JsonObject = { [k: string]: JsonValue };

    export class PrismaClientKnownRequestError extends Error {
      code: string;
      meta?: Record<string, unknown>;
    }
    export class PrismaClientValidationError extends Error {}

    export type Middleware = (params: MiddlewareParams, next: (p: MiddlewareParams) => Promise<any>) => Promise<any>;
    export interface MiddlewareParams {
      model?: string; action: string; args: any; dataPath: string[]; runInTransaction: boolean;
    }

    export type TransactionClient = Omit<PrismaClient, '$transaction' | '$connect' | '$disconnect' | '$use'>;
`;
for (const [name] of models) {
  out += `    export type ${name}GetPayload<T = any> = ${name} & Record<string, any>;\n`;
  out += `    export type ${name}Include = Record<string, any>;\n`;
  out += `    export type ${name}WhereInput = Record<string, any>;\n`;
  out += `    export type ${name}CreateManyInput = Record<string, any>;\n`;
  out += `    export type ${name}CreateInput = Record<string, any>;\n`;
  out += `    export type ${name}UpdateInput = Record<string, any>;\n`;
}
out += `    export type EnumPriorityFilter = { equals?: any };\n`;
out += `  }\n\n`;

// Delegates: loose args, faithful return types.
out += `  interface Delegate<M> {
    findMany(args?: any): Promise<any[]>;
    findUnique(args: any): Promise<M | null>;
    findUniqueOrThrow(args: any): Promise<any>;
    findFirst(args?: any): Promise<any | null>;
    findFirstOrThrow(args?: any): Promise<any>;
    create(args: any): Promise<any>;
    createMany(args: any): Promise<{ count: number }>;
    update(args: any): Promise<any>;
    updateMany(args: any): Promise<{ count: number }>;
    upsert(args: any): Promise<any>;
    delete(args: any): Promise<any>;
    deleteMany(args?: any): Promise<{ count: number }>;
    count(args?: any): Promise<number>;
    aggregate(args?: any): Promise<any>;
    groupBy(args: any): Promise<any[]>;
  }

  export class PrismaClient {
    constructor(opts?: any);
`;
for (const [name] of models) {
  const prop = name.charAt(0).toLowerCase() + name.slice(1);
  out += `    ${prop}: Delegate<${name}>;\n`;
}
out += `    $connect(): Promise<void>;
    $disconnect(): Promise<void>;
    $use(mw: Prisma.Middleware): void;
    $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: any): Promise<T>;
    $transaction<T>(ops: Promise<T>[]): Promise<T[]>;
    $queryRaw(q: TemplateStringsArray, ...v: any[]): Promise<any>;
    $executeRaw(q: TemplateStringsArray, ...v: any[]): Promise<number>;
  }
}
`;
fs.mkdirSync('packages/server/tools', { recursive: true });
fs.writeFileSync('packages/server/tools/prisma-stub.d.ts', out);
console.log(`stub written: ${models.size} models, ${enums.size} enums, ${out.split('\n').length} lines`);
