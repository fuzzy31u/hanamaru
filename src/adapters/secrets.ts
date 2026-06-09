import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { SecretAccessError } from '~/lib/errors'
import { logger } from '~/lib/logger'

let cachedClient: SecretManagerServiceClient | null = null

function getClient(): SecretManagerServiceClient {
  if (cachedClient === null) {
    cachedClient = new SecretManagerServiceClient()
  }
  return cachedClient
}

const cache = new Map<string, string>()

export async function readSecret(
  projectId: string,
  secretName: string,
  version = 'latest',
): Promise<string> {
  const cacheKey = `${projectId}/${secretName}/${version}`
  const hit = cache.get(cacheKey)
  if (hit !== undefined) return hit

  const name = `projects/${projectId}/secrets/${secretName}/versions/${version}`
  try {
    const [response] = await getClient().accessSecretVersion({ name })
    const payload = response.payload?.data?.toString()
    if (!payload) throw new SecretAccessError(`Secret ${secretName} is empty`)
    cache.set(cacheKey, payload)
    logger.info('secret.loaded', { secretName, version })
    return payload
  } catch (err) {
    throw new SecretAccessError(`Failed to read secret ${secretName}`, err)
  }
}

export function clearSecretCache(): void {
  cache.clear()
}
