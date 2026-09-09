import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  discoverPrismaConfigs,
  listPrismaMigrations,
  parsePrismaModelNames,
  prismaInputDigest
} from './prisma-adapter'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orm-review-adapter-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writePrismaProject(dir: string): Promise<void> {
  await mkdir(join(root, dir, 'prisma', 'migrations', '20240101000000_init'), {
    recursive: true
  })
  await mkdir(join(root, dir, 'prisma', 'migrations', '20240201000000_add_bookmarks'), {
    recursive: true
  })
  await writeFile(
    join(root, dir, 'prisma', 'schema.prisma'),
    'model User {\n  id Int @id\n}\n\nmodel Bookmark {\n  id Int @id\n}\n'
  )
  await writeFile(
    join(root, dir, 'prisma', 'migrations', '20240101000000_init', 'migration.sql'),
    'CREATE TABLE "User" ("id" INTEGER PRIMARY KEY);'
  )
  await writeFile(
    join(root, dir, 'prisma', 'migrations', '20240201000000_add_bookmarks', 'migration.sql'),
    'CREATE TABLE "Bookmark" ("id" INTEGER PRIMARY KEY);\nDROP TABLE "Legacy";'
  )
}

describe('discoverPrismaConfigs', () => {
  it('finds schema.prisma files and skips node_modules', async () => {
    await writePrismaProject('.')
    await mkdir(join(root, 'node_modules', 'some-pkg', 'prisma'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'some-pkg', 'prisma', 'schema.prisma'), 'model X {}')

    const configs = await discoverPrismaConfigs(root)
    expect(configs).toHaveLength(1)
    expect(configs[0].orm).toBe('prisma')
    expect(configs[0].schemaPath).toBe('prisma/schema.prisma')
    expect(configs[0].projectDir).toBe('.')
  })

  it('discovers monorepo configs with distinct stable ids', async () => {
    await writePrismaProject('packages/api')
    await writePrismaProject('packages/web')

    const configs = await discoverPrismaConfigs(root)
    expect(configs.map((c) => c.schemaPath).sort()).toEqual([
      'packages/api/prisma/schema.prisma',
      'packages/web/prisma/schema.prisma'
    ])
    expect(new Set(configs.map((c) => c.configId)).size).toBe(2)
    expect(configs.find((c) => c.schemaPath.startsWith('packages/api'))?.projectDir).toBe(
      'packages/api'
    )
  })

  it('returns empty when no prisma config exists', async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    expect(await discoverPrismaConfigs(root)).toEqual([])
  })
})

describe('parsePrismaModelNames', () => {
  it('extracts model names sorted', () => {
    expect(parsePrismaModelNames('model Bookmark {}\nmodel User {}\n// model Comment {}')).toEqual(
      ['Bookmark', 'User']
    )
  })
})

describe('listPrismaMigrations', () => {
  it('lists migrations with unknown status and destructive heuristic', async () => {
    await writePrismaProject('.')
    const migrations = await listPrismaMigrations(root, 'prisma/schema.prisma')
    expect(migrations.map((m) => m.name)).toEqual([
      '20240101000000_init',
      '20240201000000_add_bookmarks'
    ])
    expect(migrations[0].destructive).toBe(false)
    expect(migrations[1].destructive).toBe(true)
    expect(migrations.every((m) => m.status === 'unknown')).toBe(true)
  })

  it('returns empty when the migrations directory is missing', async () => {
    await mkdir(join(root, 'prisma'), { recursive: true })
    await writeFile(join(root, 'prisma', 'schema.prisma'), 'model A {}')
    expect(await listPrismaMigrations(root, 'prisma/schema.prisma')).toEqual([])
  })
})

describe('prismaInputDigest', () => {
  it('changes when a model file changes, even without a commit', async () => {
    await writePrismaProject('.')
    const migrations = await listPrismaMigrations(root, 'prisma/schema.prisma')
    const before = await prismaInputDigest(root, 'prisma/schema.prisma', migrations)
    await writeFile(
      join(root, 'prisma', 'schema.prisma'),
      'model User {\n  id Int @id\n  email String\n}\n'
    )
    const after = await prismaInputDigest(root, 'prisma/schema.prisma', migrations)
    expect(after).not.toBe(before)
  })

  it('changes when a migration file changes', async () => {
    await writePrismaProject('.')
    const migrations = await listPrismaMigrations(root, 'prisma/schema.prisma')
    const before = await prismaInputDigest(root, 'prisma/schema.prisma', migrations)
    await writeFile(
      join(root, 'prisma', 'migrations', '20240101000000_init', 'migration.sql'),
      'CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "x" TEXT);'
    )
    const after = await prismaInputDigest(root, 'prisma/schema.prisma', migrations)
    expect(after).not.toBe(before)
  })
})
