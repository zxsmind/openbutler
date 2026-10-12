import { describe, expect, it } from 'vitest';
import { redactSecrets, scanSecrets } from '../src/secret-scan.js';
import { redactToolOutput } from '../src/sensitive-data.js';

/**
 * The secret engine is shared by every surface, so its contract is pinned here: real provider
 * formats are caught, ordinary engineering text is not, masking is span-based and idempotent, and
 * the media payloads a tool must still deliver are left alone.
 *
 * The credentials below are synthetic fixtures. Each is written as literals joined at runtime so the
 * value the engine must detect stays byte-exact while no credential pattern matches a contiguous run
 * of this file's source text. They are not secrets; splitting them keeps GitHub push protection from
 * treating them as ones. fixture-hygiene.test.ts fails if anyone simplifies them back.
 */

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDEN' + 'G/bPxRfiCYRANDOMKEY1';

const POSITIVES: Array<{ label: string; text: string; secret: string; ruleId?: string }> = [
  {
    label: 'GitHub token',
    text: 'token=ghp_' + 'a'.repeat(36),
    secret: 'ghp_' + 'a'.repeat(36),
    ruleId: '@secretlint/secretlint-rule-github',
  },
  {
    label: 'AWS secret access key assignment',
    text: `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`,
    secret: AWS_SECRET,
    ruleId: '@secretlint/secretlint-rule-aws',
  },
  {
    label: 'AWS access key id',
    text: 'access key AKIA' + 'ABCDEFGHIJKLMNOP end',
    secret: 'AKIA' + 'ABCDEFGHIJKLMNOP',
    ruleId: '@secretlint/secretlint-rule-aws',
  },
  {
    label: 'Anthropic key',
    text: 'ANTHROPIC_API_KEY=sk-ant-api03-' + 'a'.repeat(93) + 'AA',
    secret: 'sk-ant-api03-' + 'a'.repeat(93) + 'AA',
    ruleId: '@secretlint/secretlint-rule-anthropic',
  },
  {
    label: 'OpenAI key',
    text: 'key sk-' + 'a'.repeat(20) + 'T3BlbkFJ' + 'b'.repeat(20),
    secret: 'sk-' + 'a'.repeat(20) + 'T3BlbkFJ' + 'b'.repeat(20),
    ruleId: '@secretlint/secretlint-rule-openai',
  },
  {
    label: 'Slack token',
    text: 'xoxb-' + '123456789012-123456789' + '012-abcdefghijklmnopqrstuvwx',
    secret: 'xoxb-' + '123456789012-123456789' + '012-abcdefghijklmnopqrstuvwx',
    ruleId: '@secretlint/secretlint-rule-slack',
  },
  {
    label: 'GitLab token',
    text: 'glpat-' + 'c'.repeat(20),
    secret: 'glpat-' + 'c'.repeat(20),
    ruleId: '@secretlint/secretlint-rule-gitlab',
  },
  {
    label: 'npm token',
    text: 'npm_' + 'd'.repeat(36),
    secret: 'npm_' + 'd'.repeat(36),
    ruleId: '@secretlint/secretlint-rule-npm',
  },
  {
    label: 'private key PEM',
    text: '-----BEGIN PRIVATE KEY-----\n' + 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ'.repeat(3) + '\n-----END PRIVATE KEY-----',
    secret: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ'.repeat(3),
    ruleId: '@secretlint/secretlint-rule-privatekey',
  },
  {
    label: 'GCP service-account JSON',
    text: JSON.stringify({
      type: 'service_account',
      private_key_id: 'abc123',
      private_key:
        '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ' +
        'A'.repeat(40) +
        '\n-----END PRIVATE KEY-----\n',
    }),
    secret: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ' + 'A'.repeat(40),
    ruleId: '@secretlint/secretlint-rule-gcp',
  },
  {
    label: 'database connection string',
    text: 'DATABASE_URL=postgres://admin:hunter2@db.example.com:5432/app',
    secret: 'postgres://admin:hunter2@db.example.com:5432/app',
    ruleId: '@secretlint/secretlint-rule-database-connection-string',
  },
  {
    label: 'basic auth URL',
    text: 'clone https://aladdin:opensesame@example.com/private now',
    secret: 'https://aladdin:opensesame@example.com',
    ruleId: '@secretlint/secretlint-rule-basicauth',
  },
];

describe('secret detection over provider formats', () => {
  it.each(POSITIVES)('redacts the $label', ({ text, secret, ruleId }) => {
    const redacted = redactSecrets(text);
    expect(redacted).toContain('[redacted]');
    expect(redacted).not.toContain(secret);
    if (ruleId) {
      expect(scanSecrets(text).some((match) => match.ruleId === ruleId)).toBe(true);
    }
  });

  it('keeps a short label around the masked span', () => {
    expect(redactSecrets('AWS_SECRET_ACCESS_KEY=' + AWS_SECRET)).toBe('AWS_SECRET_ACCESS_KEY=[redacted]');
  });

  it('does not flag ordinary engineering text', () => {
    const negatives = [
      'sha512-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+/=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'id=550e8400-e29b-41d4-a716-446655440000 commit=f2b7de1a9c3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f',
      'const apiKey = process.env.API_KEY; const token = localStorage.getItem("token");',
      'We discussed password handling and token lifetimes; keywords: security.',
      'https://user@example.com/profile',
      '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n',
    ];
    for (const text of negatives) expect(redactSecrets(text)).toBe(text);
  });

  it('leaves the AWS documentation example alone, like the rule set does', () => {
    const text = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    expect(redactSecrets(text)).toBe(text);
  });

  it('drops bare AWS account numbers but keeps access key ids', () => {
    const account = 'aws_account_id = "123456789012"';
    expect(redactSecrets(account)).toBe(account);
    expect(redactSecrets('AKIA' + 'ABCDEFGHIJKLMNOP')).toBe('[redacted]');
  });

  it('keeps the conservative local patterns: bearer tokens and labelled assignments', () => {
    expect(redactSecrets('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
    expect(redactSecrets('password=hunter2')).toBe('password=[redacted]');
    expect(redactSecrets('api_key: abcdef123456')).toBe('api_key: [redacted]');
    expect(scanSecrets('Authorization: Bearer abc.def').some((match) => match.messageId === 'LocalBearer')).toBe(true);
  });

  it('merges overlapping detections into a single mask', () => {
    const text = 'GITHUB_TOKEN=ghp_' + 'a'.repeat(36);
    const redacted = redactSecrets(text);
    expect(redacted).toBe('GITHUB_TOKEN=[redacted]');
    expect(redacted.match(/\[redacted\]/g)).toHaveLength(1);
  });

  it('masks several secrets in one text', () => {
    const text = `a ghp_${'a'.repeat(36)} b password=hunter2 c`;
    const redacted = redactSecrets(text);
    expect(redacted).toBe(`a [redacted] b password=[redacted] c`);
  });

  it('is idempotent and preserves multibyte text around a mask', () => {
    const text = 'notes: ÉÈÊ password=hunter2 and âââ';
    const redacted = redactSecrets(text);
    expect(redacted).toBe('notes: ÉÈÊ password=[redacted] and âââ');
    expect(redactSecrets(redacted)).toBe(redacted);
  });

  it('scans a large transcript within a bounded time and finds the secret at its end', () => {
    const filler = Array.from({ length: 2_000 }, (_, index) => `line ${index}: ordinary words and numbers`).join('\n');
    const text = `${filler}\ntoken=ghp_${'a'.repeat(36)}\n`;
    const started = performance.now();
    const redacted = redactSecrets(text);
    const elapsed = performance.now() - started;
    expect(redacted).not.toContain('ghp_' + 'a'.repeat(36));
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('tool output redaction', () => {
  it('redacts every string in a tool result object', () => {
    const result = redactToolOutput({
      status: 'completed',
      exitCode: 0,
      stdout: `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}\ndone`,
      stderr: '',
    }) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AWS_SECRET_ACCESS_KEY=[redacted]');
    expect(JSON.stringify(result)).not.toContain('RANDOMKEY1');
  });

  it('redacts secret-keyed values and keeps media payload parts intact', () => {
    const imageToken = 'ghp_' + 'a'.repeat(36);
    const result = redactToolOutput({
      apiKey: 'anything',
      type: 'content',
      value: [
        { type: 'text', text: 'Loaded image' },
        { type: 'image-data', data: imageToken, mediaType: 'image/png' },
      ],
    }) as Record<string, unknown>;
    expect(result.apiKey).toBe('[redacted]');
    const parts = result.value as Array<Record<string, unknown>>;
    expect(parts[1]?.data).toBe(imageToken);
  });

  it('leaves oversized payload strings alone rather than scanning binary noise', () => {
    const payload = 'x'.repeat(2_000_001);
    expect(redactToolOutput({ blob: payload })).toEqual({ blob: payload });
  });

  it('walks nested arrays and depths', () => {
    const result = redactToolOutput({ items: [{ note: 'ok' }, { note: `token=${'ghp_' + 'a'.repeat(36)}` }] }) as {
      items: Array<{ note: string }>;
    };
    expect(result.items[0]?.note).toBe('ok');
    expect(result.items[1]?.note).toBe('token=[redacted]');
  });
});
