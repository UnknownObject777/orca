/**
 * Prisma adapter for the ORM review surface. Detection is static file
 * inspection only — no project config code is ever executed. Anything the
 * adapter cannot support is reported as `unsupported`, never fabricated.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type {
  OrmReviewCapability,
  OrmReviewConfigDescriptor,
  OrmReviewMigrationEntry
} from '../../shared/orm-review'

export const PRISMA_CAPABILITIES: Record<OrmReviewCapability, 'supported' | 'unsupported'> = {
  discovery: 'supported',
  history: 'supported',
  // `db pull` rewrites a schema file and needs live credentials; out of this slice.
  introspection: 'unsupported',
  planning: 'supported',
  verification: 'supported'
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next'])
const MAX_DISCOVERY_DEPTH = 4
const MAX_SCHEMA_FILES = 20

export function prismaConfigId(worktreeRelativeSchemaPath: string): string {
  return createHash('sha256')
    .update(`prisma:${worktreeRelativeSchemaPath}`)
    .digest('hex')
    .slice(0, 16)
}

/** Find Prisma schema files under a worktree root without executing anything. */
export async function discoverPrismaConfigs(
  worktreeRoot: string
): Promise<OrmReviewConfigDescriptor[]> {
  const found: OrmReviewConfigDescriptor[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DISCOVERY_DEPTH || found.length >= MAX_SCHEMA_FILES) {
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= MAX_SCHEMA_FILES) {
        return
      }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue
        }
        await walk(full, depth + 1)
      } else if (entry.isFile() && entry.name === 'schema.prisma') {
        const schemaPath = relative(worktreeRoot, full).split(sep).join('/')
        found.push({
          configId: prismaConfigId(schemaPath),
          orm: 'prisma',
          schemaPath,
          projectDir: relative(worktreeRoot, join(full, '..', '..')).split(sep).join('/') || '.',
          displayName: schemaPath
        })
      }
    }
  }

  await walk(worktreeRoot, 0)
  return found.sort((a, b) => a.schemaPath.localeCompare(b.schemaPath))
}

/** Extract declared model names from Prisma schema text. */
export function parsePrismaModelNames(schemaText: string): string[] {
  const names: string[] = []
  for (const match of schemaText.matchAll(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)) {
    names.push(match[1])
  }
  return names.sort()
}

const DESTRUCTIVE_SQL =
  /\bDROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE)\b|\bALTER\s+TABLE\b[^;]*\bDROP\b|\bTRUNCATE\b/i

/** List migration directories under `<schemaDir>/migrations`. */
export async function listPrismaMigrations(
  worktreeRoot: string,
  schemaPath: string
): Promise<OrmReviewMigrationEntry[]> {
  const migrationsDir = join(worktreeRoot, schemaPath, '..', 'migrations')
  let entries
  try {
    entries = await readdir(migrationsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const migrations: OrmReviewMigrationEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const dir = join(migrationsDir, entry.name)
    let destructive = false
    try {
      const sql = await readFile(join(dir, 'migration.sql'), 'utf8')
      destructive = DESTRUCTIVE_SQL.test(sql)
    } catch {
      // A migration without migration.sql is unusual but listable.
    }
    migrations.push({
      name: entry.name,
      relativePath:
        relative(worktreeRoot, dir).split(sep).join('/'),
      status: 'unknown',
      destructive
    })
  }
  return migrations.sort((a, b) => a.name.localeCompare(b.name))
}

/** Digest over the files that define "what should be applied". */
export async function prismaInputDigest(
  worktreeRoot: string,
  schemaPath: string,
  migrations: readonly OrmReviewMigrationEntry[]
): Promise<string> {
  const hash = createHash('sha256')
  const absorb = async (absolutePath: string, label: string): Promise<void> => {
    try {
      const content = await readFile(absolutePath)
      hash.update(label).update('\0').update(content).update('\0')
    } catch {
      hash.update(label).update('\0missing\0')
    }
  }
  await absorb(join(worktreeRoot, schemaPath), schemaPath)
  for (const migration of migrations) {
    await absorb(join(worktreeRoot, migration.relativePath, 'migration.sql'), migration.name)
  }
  return hash.digest('hex')
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
