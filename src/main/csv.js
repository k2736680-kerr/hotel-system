const { AppError } = require('./errors')

function escapeCsv(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function stringifyCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\r\n')
}

function parseCsv(value) {
  const source = String(value ?? '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
      continue
    }
    if (character === '"' && field === '') {
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\r' || character === '\n') {
      row.push(field)
      if (row.some((cell) => cell.trim() !== '')) rows.push(row)
      row = []
      field = ''
      if (character === '\r' && source[index + 1] === '\n') index += 1
    } else {
      field += character
    }
  }
  if (quoted) throw new AppError('INVALID_CSV', 'CSV 文件存在未闭合的引号')
  row.push(field)
  if (row.some((cell) => cell.trim() !== '')) rows.push(row)
  return rows
}

module.exports = { escapeCsv, stringifyCsv, parseCsv }
