export class UniqueViolation extends Error {
  constructor(message = '唯一约束冲突') {
    super(message);
    this.name = 'UniqueViolation';
  }
}

export function wrapUnique(fn, message) {
  try {
    return fn();
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw new UniqueViolation(message);
    throw err;
  }
}
