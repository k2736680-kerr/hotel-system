class AppError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }
}

function assert(condition, code, message, details = null) {
  if (!condition) throw new AppError(code, message, details)
}

function toPublicError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details }
  }

  console.error(error)
  return { code: 'INTERNAL_ERROR', message: '系统处理失败，请重试或查看日志' }
}

module.exports = { AppError, assert, toPublicError }
