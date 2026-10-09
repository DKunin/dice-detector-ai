import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeSocksProxy } from '../src/config.js';

const minimumEnv = {
  OPENAI_API_KEY: 'test-key',
  SOCKS5_PROXY: 'socks5://user:password@127.0.0.1:1080',
  TARGET_AUTH_SUBJECT: 'user-subject',
};

describe('config', () => {
  it('normalizes proxy DNS through SOCKS and has conservative defaults', () => {
    const config = loadConfig(minimumEnv);
    expect(config.socksProxy).toBe('socks5h://user:password@127.0.0.1:1080');
    expect(config.model).toBe('gpt-6-luna');
    expect(config.diceThreshold).toBe(0.94);
    expect(config.lookalikeMax).toBe(0.1);
    expect(config.positiveConfirmations).toBe(2);
    expect(config.concurrency).toBe(4);
  });

  it('rejects non-SOCKS proxy schemes', () => {
    expect(() => normalizeSocksProxy('http://127.0.0.1:8080')).toThrow(/SOCKS5_PROXY/);
  });

  it('changes the checkpoint version when a decision threshold changes', () => {
    const first = loadConfig(minimumEnv);
    const second = loadConfig({ ...minimumEnv, DICE_PROBABILITY_THRESHOLD: '0.97' });
    expect(first.detectorVersion).not.toBe(second.detectorVersion);
  });
});
