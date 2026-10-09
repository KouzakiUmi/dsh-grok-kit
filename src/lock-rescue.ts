//

// Part of dsh-grok-kit, Apache-2.0.

//

/**
 * Writer-lock helpers. Supplementary plugin-level stale-lock recovery is
 * intentionally a no-op: any check-then-rename/rm on a path cannot bind
 * the inspected generation to the directory entry and risks moving a live
 * writer's lock (GROK-WRITER-LOCK-002). Store operations delegate cross-process
 * writer coordination and dead-PID reclamation to the official dsh-atomic-write
 * claim-file protocol; this extra rescue helper never mutates locks.
 * @module dsh-grok-kit/lock-rescue
 */

/** Extract the owner pid from a dsh-atomic-write lock (`${pid}\n` and nothing else). */
export function parseLockPid(text: string): number | undefined {
  const match = /^(\d{1,10})\n$/.exec(text)
  if (match === null) return undefined
  const pid = Number(match[1])
  return pid > 0 ? pid : undefined
}

/** Whether `pid` is running: `true` alive, `false` provably dead, `undefined` unknown. */
export function isPidAlive(pid: number): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ESRCH') return false
    if (code === 'EPERM' || code === 'EACCES') return true
    return undefined
  }
}

/**
 * Do not break writer locks from this supplementary rescue helper. Path-based
 * recovery cannot bind the inspected file generation to the directory entry,
 * so this helper never mutates `lockPath` or creates `.stale-*` siblings.
 * Routine writer coordination and dead-PID takeover are delegated to the
 * official atomic-write protocol in the store. Returns `undefined` always.
 */
export async function breakStaleWriterLock(_lockPath: string): Promise<number | undefined> {
  return undefined
}
