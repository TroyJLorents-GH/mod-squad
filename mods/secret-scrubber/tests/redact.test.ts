import { describe, expect, test } from 'claude-code/testing'

import { compileExtra, redactBlocks, redactText, withheld, FAILURE_NOTICE } from '../hooks/redact'

// Every value below is a fake that only has the shape of a credential.
const X36 = 'x'.repeat(36)
const FAKE = {
  aws: 'AKIAEXAMPLEEXAMPLE12',
  asia: 'ASIAEXAMPLEEXAMPLE34',
  awsSecret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  ghp: `ghp_${X36}`,
  gho: `gho_${X36}`,
  ghs: `ghs_${X36}`,
  pat: `github_pat_${'x'.repeat(22)}_${'y'.repeat(59)}`,
  anthropic: `sk-ant-api03-${'x'.repeat(40)}-FAKEFAKE`,
  openai: `sk-proj-FAKE${'x'.repeat(30)}0000Example`,
  openaiLegacy: `sk-FAKEexample0000${'x'.repeat(30)}`,
  slack: 'xox' + 'b-000000000000-000000000000-FAKEFAKEFAKEFAKE',
  stripe: `sk_live_${'0'.repeat(24)}`,
  stripeR: `rk_live_${'x'.repeat(24)}`,
  google: `AIza${'X'.repeat(35)}`,
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.ZmFrZS1zaWduYXR1cmUtbm90LXJlYWw',
  azureKey: `${'A'.repeat(86)}==`,
  azureApi: '0123456789abcdef0123456789abcdef',
}

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAfakefakefakefakefakefakefakefakefakefakefakefake',
  'ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

const r = (s: string) => redactText(s)

describe('redactText: what is redacted', () => {
  test('AWS access key ids (AKIA and ASIA)', () => {
    expect(r(`id=${FAKE.aws} and ${FAKE.asia}`).text).toBe('id=[REDACTED:aws-access-key-id] and [REDACTED:aws-access-key-id]')
  })

  test('AWS secret in a credentials file keeps the key name', () => {
    const out = r(`[default]\naws_secret_access_key = ${FAKE.awsSecret}\nregion = us-east-1`)
    expect(out.text).toBe('[default]\naws_secret_access_key = [REDACTED:aws-secret]\nregion = us-east-1')
    expect(out.counts).toEqual({ 'aws-secret': 1 })
  })

  test('AWS secret as an upper-case env var', () => {
    expect(r(`AWS_SECRET_ACCESS_KEY=${FAKE.awsSecret}`).text).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED:aws-secret]')
  })

  test('GitHub tokens of every prefix', () => {
    for (const t of [FAKE.ghp, FAKE.gho, FAKE.ghs, `ghu_${X36}`, `ghr_${X36}`, FAKE.pat]) {
      expect(r(`token: ${t}`).text).toBe('token: [REDACTED:github-token]')
    }
  })

  test('Anthropic keys are their own kind, not OpenAI', () => {
    const out = r(`key ${FAKE.anthropic} end`)
    expect(out.text).toBe('key [REDACTED:anthropic-key] end')
    expect(out.counts).toEqual({ 'anthropic-key': 1 })
  })

  test('OpenAI-style keys, project and legacy', () => {
    expect(r(`"${FAKE.openai}"`).text).toBe('"[REDACTED:openai-key]"')
    expect(r(FAKE.openaiLegacy).text).toBe('[REDACTED:openai-key]')
  })

  test('Azure storage AccountKey and SAS signatures in a connection string', () => {
    const cs = `DefaultEndpointsProtocol=https;AccountName=fake;AccountKey=${FAKE.azureKey};EndpointSuffix=core.windows.net`
    expect(r(cs).text).toBe('DefaultEndpointsProtocol=https;AccountName=fake;AccountKey=[REDACTED:azure-storage-key];EndpointSuffix=core.windows.net')
    const sas = 'BlobEndpoint=https://fake.blob.core.windows.net/;SharedAccessSignature=sv=2022-11-02&ss=b&sig=FAKEfake%2Bfake%3D0000'
    expect(r(sas).text).toBe('BlobEndpoint=https://fake.blob.core.windows.net/;SharedAccessSignature=[REDACTED:azure-sas]')
    const url = 'https://fake.blob.core.windows.net/c/b.txt?sv=2022-11-02&se=2026-01-01&sig=FAKEfakeFAKEfake%2B0000%3D&sp=r'
    expect(r(url).text).toBe('https://fake.blob.core.windows.net/c/b.txt?sv=2022-11-02&se=2026-01-01&sig=[REDACTED:azure-sas]&sp=r')
  })

  test('Azure OpenAI api-key header', () => {
    expect(r(`curl -H "api-key: ${FAKE.azureApi}" https://x`).text).toBe('curl -H "api-key: [REDACTED:azure-api-key]" https://x')
  })

  test('Slack, Stripe and Google keys', () => {
    expect(r(FAKE.slack).text).toBe('[REDACTED:slack-token]')
    expect(r(`${FAKE.stripe} ${FAKE.stripeR}`).text).toBe('[REDACTED:stripe-key] [REDACTED:stripe-key]')
    expect(r(`key=${FAKE.google}&q=1`).text).toBe('key=[REDACTED:google-api-key]&q=1')
  })

  test('JWTs', () => {
    expect(r(`Authorization: Bearer ${FAKE.jwt}`).text).toBe('Authorization: Bearer [REDACTED:jwt]')
  })

  test('PEM private key blocks, whole', () => {
    const out = r(`before\n${PEM}\nafter`)
    expect(out.text).toBe('before\n[REDACTED:private-key]\nafter')
    expect(r(PEM.replace(/RSA /g, '')).text).toBe('[REDACTED:private-key]')
    expect(r(PEM.replace(/RSA /g, 'OPENSSH ')).text).toBe('[REDACTED:private-key]')
  })

  test('a PEM block inside JSON with escaped newlines', () => {
    const json = `{"private_key": "${PEM.replace(/\n/g, '\\n')}\\n", "x": 1}`
    expect(r(json).text).toBe('{"private_key": "[REDACTED:private-key]\\n", "x": 1}')
  })

  test('a PEM block cut off by truncated output is redacted to its end', () => {
    const cut = PEM.split('\n').slice(0, 3).join('\n')
    expect(r(`cat key.pem\n${cut}`).text).toBe('cat key.pem\n[REDACTED:private-key]')
  })

  test('.env lines redact only the value', () => {
    const env = [
      'DATABASE_URL=postgres://localhost/db',
      'DB_PASSWORD=hunter2hunter2',
      'export STRIPE_SECRET="quoted value here"',
      "API_KEY='single'",
      'SESSION_TOKEN = spaced-value',
      'MY_PRIVATE_KEY=abc123',
      'PASSWD=x9',
      'DEBUG=true',
    ].join('\n')
    expect(r(env).text).toBe(
      [
        'DATABASE_URL=postgres://localhost/db',
        'DB_PASSWORD=[REDACTED:env-secret]',
        'export STRIPE_SECRET="[REDACTED:env-secret]"',
        "API_KEY='[REDACTED:env-secret]'",
        'SESSION_TOKEN = [REDACTED:env-secret]',
        'MY_PRIVATE_KEY=[REDACTED:env-secret]',
        'PASSWD=[REDACTED:env-secret]',
        'DEBUG=true',
      ].join('\n'),
    )
  })

  test('an env line holding a known token is counted once, by the token kind', () => {
    const out = r(`GITHUB_TOKEN=${FAKE.ghp}`)
    expect(out.text).toBe('GITHUB_TOKEN=[REDACTED:github-token]')
    expect(out.counts).toEqual({ 'github-token': 1 })
  })

  test('grep output prefix and a CLI flag', () => {
    expect(r('.env:3:CLIENT_SECRET=abcdef').text).toBe('.env:3:CLIENT_SECRET=[REDACTED:env-secret]')
    expect(r('mysql --password=s3cretpass -h db').text).toBe('mysql --password=[REDACTED:env-secret] -h db')
  })

  test('counts every hit and is idempotent', () => {
    const once = r(`${FAKE.aws} ${FAKE.aws} ${FAKE.ghp}`)
    expect(once.counts).toEqual({ 'aws-access-key-id': 2, 'github-token': 1 })
    expect(once.total).toBe(3)
    const twice = r(once.text)
    expect(twice.text).toBe(once.text)
    expect(twice.total).toBe(0)
  })
})

describe('redactText: near misses left alone', () => {
  const same = (s: string) => {
    const out = r(s)
    expect(out.text).toBe(s)
    expect(out.total).toBe(0)
  }

  test('sk- in prose and kebab-case identifiers', () => {
    same('The sk- prefix marks a secret key; see sk-learn and risk-assessment.')
    same('npm i @scope/sk-some-long-kebab-case-package-name-here-ok')
    same('sk-abc123')
  })

  test('git SHAs and UUIDs', () => {
    same('commit 4b825dc642cb6eb9a060e54bf8d69288fbee4904 (HEAD -> main)')
    same('id: 123e4567-e89b-12d3-a456-426614174000')
  })

  test('base64 image data, even with key-shaped runs inside', () => {
    const blob = `iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB${FAKE.google}CAYAAAAfFcSJAAAADUlEQVR4${FAKE.aws}2NgYGD4DwABBAEAcCBlCwAAAABJRU5ErkJggg==`
    same(`data:image/png;base64,${blob}`)
    same(`<img src="data:image/png;base64,${blob}">`)
  })

  test('code that names secrets without holding them', () => {
    same('const API_TOKEN = process.env.API_TOKEN')
    same('token = os.environ["GITHUB_TOKEN"]')
    same('if (TOKEN == expected) return')
    same('PASSWORD=${DB_PASSWORD}')
    same('SECRET_KEY=$SECRET_KEY')
    same('max_tokens=4096')
    same('TOKEN_TTL=300')
    same('tokenizer=cl100k_base')
    same('if line.startswith("-----BEGIN RSA PRIVATE KEY-----"):')
  })

  test('words that only start like a key', () => {
    same('AKIA is the prefix of an access key id')
    same('eyJhbGciOiJIUzI1NiJ9 is just a header')
    same('the xoxb- prefix is a bot token')
    same('sk_' + 'test_' + '0'.repeat(24)) // Stripe test keys are not live secrets (built at runtime so scanners don't flag the source)
    same('AccountName=fake;EndpointSuffix=core.windows.net')
  })
})

describe('compileExtra', () => {
  test('valid patterns become custom rules; invalid and empty-matching ones are reported', () => {
    const { rules, invalid } = compileExtra('INTERNAL-[0-9]{6}, ([unclosed, , a*')
    expect(rules).toHaveLength(1)
    expect(invalid).toEqual(['([unclosed', 'a*'])
    expect(redactText('ticket INTERNAL-123456 ok', rules).text).toBe('ticket [REDACTED:custom] ok')
  })

  test('an empty setting adds nothing', () => {
    expect(compileExtra('')).toEqual({ rules: [], invalid: [] })
    expect(compileExtra(undefined)).toEqual({ rules: [], invalid: [] })
  })
})

describe('redactBlocks', () => {
  test('text blocks and tool_result content, string or list; media untouched', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `xx${FAKE.aws}xx` } }
    const content = [
      { type: 'tool_result', tool_use_id: 't1', content: `out ${FAKE.ghp}` },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: FAKE.jwt }, image] },
      { type: 'text', text: `note ${FAKE.slack}` },
    ]
    const out = redactBlocks(content)
    expect(out.total).toBe(3)
    expect(out.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'out [REDACTED:github-token]' },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '[REDACTED:jwt]' }, image] },
      { type: 'text', text: 'note [REDACTED:slack-token]' },
    ])
  })

  test('nothing to redact hands back the same array', () => {
    const content = [{ type: 'tool_result', tool_use_id: 't1', content: 'clean output' }]
    expect(redactBlocks(content).content).toBe(content)
  })

  test('withheld replaces text and tool_result content, keeps ids and media', () => {
    const image = { type: 'image', source: {} }
    expect(withheld([{ type: 'tool_result', tool_use_id: 't1', content: 'x', is_error: false }, { type: 'text', text: 'y' }, image])).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: FAILURE_NOTICE, is_error: false },
      { type: 'text', text: FAILURE_NOTICE },
      image,
    ])
    expect(withheld('not an array')).toEqual([{ type: 'text', text: FAILURE_NOTICE }])
  })
})
