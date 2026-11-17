import { loadConfig } from './config.js';

const valid = {
  PORT: '3000',
  REDIS_URL: 'redis://localhost:6379',
  ADMIN_TOKEN: 'admin-secret',
  DEMO_USERS: 'user-01:token-01,user-02:token-02',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(valid);

    expect(config.port).toBe(3000);
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.adminToken).toBe('admin-secret');
    expect([...config.userIds]).toEqual(['user-01', 'user-02']);
    expect(config.userIdByToken.get('token-02')).toBe('user-02');
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '3000abc'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['REDIS_URL', 'localhost'],
    ['REDIS_URL', 'redis:localhost'],
    ['REDIS_URL', 'redis://'],
    ['REDIS_URL', 'redis://localhost:6379/not-a-number'],
    ['REDIS_URL', 'redis://localhost:6379/-1'],
    ['ADMIN_TOKEN', 'has space'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => loadConfig({ ...valid, [name]: value })).toThrow(name);
  });

  it.each([
    ['no token', 'user-01'],
    ['empty token', 'user-01:'],
    ['empty user ID', ':token-01'],
    ['three parts', 'user-01:a:b'],
    // A colon in the ID would break the structure of the Redis key names.
    ['user ID with a path character', 'user/01:token-01'],
    ['repeated user ID', 'user-01:token-01,user-01:token-02'],
    ['repeated token', 'user-01:token-01,user-02:token-01'],
    ['user token equal to the admin token', 'user-01:admin-secret'],
  ])('refuses DEMO_USERS with %s', (_case, value) => {
    expect(() => loadConfig({ ...valid, DEMO_USERS: value })).toThrow(
      'DEMO_USERS',
    );
  });

  it('reports every problem at once', () => {
    expect(() => loadConfig({})).toThrow(
      /PORT[\s\S]*REDIS_URL[\s\S]*ADMIN_TOKEN[\s\S]*DEMO_USERS/,
    );
  });

  it('never repeats a credential in the error', () => {
    const run = () =>
      loadConfig({
        ...valid,
        REDIS_URL: 'http://user:redis-password@host',
        DEMO_USERS: 'user-01:secret-token,user-01:other-secret',
      });

    expect(run).toThrow();
    expect(run).not.toThrow(/redis-password|secret-token|other-secret/);
  });
});
