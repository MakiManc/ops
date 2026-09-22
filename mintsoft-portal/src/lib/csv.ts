/**
 * A small RFC 4180 CSV reader.
 *
 * Written rather than pulled in because the seed files carry delivery addresses, and
 * addresses contain commas. A naive split on "," quietly shifts every column after the
 * address by one, which produces a site whose town is half a street name rather than
 * an error — the kind of wrong that survives all the way to a delivery.
 */

export interface CsvRow {
  /** 1-based line in the source file, for error messages that point somewhere useful. */
  line: number
  values: Record<string, string>
}

export class CsvError extends Error {
  readonly line: number | undefined

  constructor(message: string, line?: number) {
    super(line ? `line ${line}: ${message}` : message)
    this.name = 'CsvError'
    this.line = line
  }
}

/** Splits CSV text into rows of raw cells, honouring quotes, escaped quotes and newlines. */
function parseCells(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let cell = ''
  let inQuotes = false
  let line = 1
  let rowStartLine = 1

  const endCell = () => { cells.push(cell); cell = '' }
  const endRow = () => {
    endCell()
    // Skip rows that are entirely empty, which is what a trailing newline produces.
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: rowStartLine, cells })
    cells = []
    rowStartLine = line + 1
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }   // "" is a literal quote
        else inQuotes = false
      } else {
        if (char === '\n') line++
        cell += char
      }
      continue
    }
    if (char === '"' && cell === '') { inQuotes = true; continue }
    if (char === ',') { endCell(); continue }
    if (char === '\r') continue
    if (char === '\n') { endRow(); line++; continue }
    cell += char
  }
  if (cell !== '' || cells.length) endRow()

  if (inQuotes) throw new CsvError('file ends inside a quoted value — check for an unclosed "')
  return rows
}

/**
 * Parses CSV into rows keyed by header name.
 *
 * Requires every named column to be present. A missing column is far more likely to be
 * a typo in the header than a deliberate omission, and guessing would seed bad data.
 */
export function parseCsv(text: string, requiredColumns: string[]): CsvRow[] {
  const raw = parseCells(text)
  const headerRow = raw[0]
  if (!headerRow) throw new CsvError('the file is empty')

  const headers = headerRow.cells.map((h) => h.trim())
  const missing = requiredColumns.filter((c) => !headers.includes(c))
  if (missing.length) {
    throw new CsvError(`missing column(s): ${missing.join(', ')}. Found: ${headers.join(', ')}`)
  }

  const duplicated = headers.filter((h, i) => h !== '' && headers.indexOf(h) !== i)
  if (duplicated.length) throw new CsvError(`duplicate column(s): ${[...new Set(duplicated)].join(', ')}`)

  return raw.slice(1).map(({ line, cells }) => {
    if (cells.length !== headers.length) {
      throw new CsvError(
        `expected ${headers.length} columns but found ${cells.length}. ` +
        'If a value contains a comma, wrap it in double quotes.',
        line,
      )
    }
    const values: Record<string, string> = {}
    headers.forEach((h, i) => { values[h] = (cells[i] ?? '').trim() })
    return { line, values }
  })
}

/** Escapes a value for SQL. Seed data is trusted-ish, but quotes in a name are common. */
export const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`

export const sqlNullable = (value: string | undefined): string =>
  value === undefined || value === '' ? 'NULL' : sqlString(value)
