jest.mock('better-sqlite3', () => {
  // Простая in-memory имитация минимального API better-sqlite3
  return jest.fn().mockImplementation(() => {
    const data = new Map();

    return {
      prepare(sql) {
        // CREATE TABLE ... -> noop
        if (/CREATE TABLE/i.test(sql)) {
          return { run: () => {} };
        }

        // SELECT luckPoints FROM points WHERE username = ?
        if (/SELECT\s+luckPoints/i.test(sql)) {
          return {
            get: (username) => {
              if (data.has(username)) return { luckPoints: data.get(username) };
              return undefined;
            }
          };
        }

        // INSERT INTO points ... ON CONFLICT -> emulate insert/update
        if (/INSERT\s+INTO\s+points/i.test(sql)) {
          return {
            run: (username, luckPoints, _dup) => {
              const prev = data.get(username) || 0;
              data.set(username, prev + (Number(luckPoints) || 0));
            }
          };
        }

        // UPDATE points SET luckPoints = MAX(luckPoints - ?, 0) WHERE username = ?
        if (/UPDATE\s+points\s+SET\s+luckPoints\s*=\s*MAX/i.test(sql)) {
          return {
            run: (luckPoints, username) => {
              const prev = data.get(username) || 0;
              const newVal = Math.max(prev - (Number(luckPoints) || 0), 0);
              data.set(username, newVal);
            }
          };
        }

        // Fallback
        return { run: () => {}, get: () => undefined };
      }
    };
  });
});

const db = require('./database');

describe('database module', () => {
  beforeEach(() => {
    // Clear module cache and re-require to ensure mocked DB is fresh per test file
    jest.resetModules();
  });

  test('getLuckPoints returns 0 for unknown user', () => {
    const db2 = require('./database');
    expect(db2.getLuckPoints('alice')).toBe(0);
  });

  test('addLuckPoint increments points and getLuckPoints returns updated value', () => {
    const db2 = require('./database');
    db2.addLuckPoint(3, 'alice');
    expect(db2.getLuckPoints('alice')).toBe(3);
    db2.addLuckPoint(2, 'alice');
    expect(db2.getLuckPoints('alice')).toBe(5);
  });

  test('removeLuckPoint decreases points but not below 0', () => {
    const db2 = require('./database');
    db2.addLuckPoint(5, 'bob');
    expect(db2.getLuckPoints('bob')).toBe(5);
    db2.removeLuckPoint(2, 'bob');
    expect(db2.getLuckPoints('bob')).toBe(3);
    db2.removeLuckPoint(10, 'bob');
    expect(db2.getLuckPoints('bob')).toBe(0);
  });
});
