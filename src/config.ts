export interface Config {
  port: number
  dbPath: string
}

const DEFAULT_PORT = 3000
const DEFAULT_DB_PATH = './db/msg.db'

export function loadConfig(
  env: Record<string, string | undefined>,
): Config {
  const rawPort = env.PORT
  // Only a positive integer string is a valid port; everything else → 3000.
  const port =
    rawPort !== undefined &&
    /^[1-9]\d*$/.test(rawPort.trim())
      ? Number(rawPort.trim())
      : DEFAULT_PORT

  return {
    port,
    dbPath: env.DB_PATH ?? DEFAULT_DB_PATH,
  }
}

export const config: Config = loadConfig(process.env)
