/**
 * 写入重试工具
 * IndexedDB 在隐私模式、磁盘空间吃紧或浏览器限流时偶发写入失败，
 * 装车单封车/解封等动作采用指数退避重试，避免纸单式操作丢结果。
 */

export interface RetryOptions {
  /** 最多尝试次数（含首次），默认 4 次 */
  attempts?: number;
  /** 首次重试前等待毫秒，默认 200ms，之后逐次翻倍 */
  baseDelayMs?: number;
  /** 自定义是否值得重试（默认 IndexedDB 类瞬时错误都重试） */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const RETRYABLE_NAME_RE = /QuotaExceeded|TransactionInactive|InvalidState|DataClone|NotFoundError|AbortError|DatabaseClosed/i;

function defaultShouldRetry(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException || error instanceof Error) {
    if (RETRYABLE_NAME_RE.test(error.name)) return true;
    // Dexie 写入失败常以 message 携带底层错误名
    return RETRYABLE_NAME_RE.test(error.message ?? '');
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * 带指数退避的异步重试。
 * @returns 任务成功时的返回值；全部失败后抛出最后一次错误。
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  { attempts = 4, baseDelayMs = 200, shouldRetry = defaultShouldRetry }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error, attempt)) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('写入失败，重试后仍未成功');
}
