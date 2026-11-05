import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDnssecValidation } from '../../src/lib/dns.js';

let agent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

describe('checkDnssecValidation', () => {
  const answer = (cd: boolean, body: unknown, status = 200): void => {
    agent
      .get('https://cloudflare-dns.com')
      .intercept({
        path: `/dns-query?name=example.com&type=SOA${cd ? '&cd=1' : ''}`,
        method: 'GET',
      })
      .reply(status, JSON.stringify(body), { headers: { 'content-type': 'application/dns-json' } });
  };

  it('reads an authenticated answer as validated', async () => {
    answer(false, { Status: 0, AD: true });

    await expect(checkDnssecValidation('example.com')).resolves.toBe('validated');
  });

  it('reads an answer that is not authenticated as not validated, not as broken', async () => {
    answer(false, { Status: 0, AD: false });

    await expect(checkDnssecValidation('example.com')).resolves.toBe('not_validated');
  });

  it('calls it broken only when an answer exists once validation is off', async () => {
    answer(false, { Status: 2, AD: false });
    answer(true, { Status: 0, AD: false });

    await expect(checkDnssecValidation('example.com')).resolves.toBe('broken');
  });

  it('does not blame DNSSEC for a nameserver that is simply failing', async () => {
    answer(false, { Status: 2, AD: false });
    answer(true, { Status: 2, AD: false });

    await expect(checkDnssecValidation('example.com')).resolves.toBeNull();
  });

  it.each([
    [
      'an error status',
      () => {
        answer(false, {}, 500);
      },
    ],
    [
      'another response code',
      () => {
        answer(false, { Status: 3, AD: false });
      },
    ],
    ['an unreachable resolver', () => undefined],
  ])('gives no verdict on %s', async (_label, arrange) => {
    arrange();

    await expect(checkDnssecValidation('example.com')).resolves.toBeNull();
  });
});
