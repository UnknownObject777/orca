import { describe, expect, it } from 'vitest'
import { redactConnectionUrl, redactSecretsFromText } from './orm-review-redaction'

describe('redactConnectionUrl', () => {
  it('masks the password in a postgres URL', () => {
    expect(redactConnectionUrl('postgresql://alice:s3cret@db.local:5432/bookmarks')).toBe(
      'postgresql://alice:****@db.local:5432/bookmarks'
    )
  })

  it('masks query parameter values', () => {
    const redacted = redactConnectionUrl(
      'postgresql://alice:s3cret@db.local:5432/db?sslmode=require&api_key=abc'
    )
    expect(redacted).not.toContain('s3cret')
    expect(redacted).not.toContain('abc')
    expect(redacted).toContain('sslmode=****')
  })

  it('masks bare userinfo when there is no password', () => {
    expect(redactConnectionUrl('postgresql://alice@db.local/db')).toBe(
      'postgresql://****@db.local/db'
    )
  })

  it('masks userinfo in unparseable URLs', () => {
    expect(redactConnectionUrl('not a url but //user:pw@host/db')).not.toContain('pw')
  })

  it('leaves credential-free URLs intact', () => {
    expect(redactConnectionUrl('file:./dev.db')).toBe('file:./dev.db')
  })
})

describe('redactSecretsFromText', () => {
  it('removes exact connection strings and their password component', () => {
    const url = 'postgresql://alice:hunter2@db.local:5432/db'
    const text = `connecting to ${url}\nauth failed for hunter2\nall good`
    const out = redactSecretsFromText(text, [url])
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain(url)
    expect(out).toContain('all good')
  })

  it('ignores empty secrets', () => {
    expect(redactSecretsFromText('hello', [''])).toBe('hello')
  })
})
