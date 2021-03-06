import { CacheStore, CacheSetOptions } from './cache_store'
import * as IORedis from 'ioredis'
import { Runtime } from './runtime';

const Redis = require('ioredis-mock')
const OK = 'OK'

export class MemoryCacheStore implements CacheStore {
  redis: IORedis.Redis
  rand: number
  constructor(label?: string) {
    this.redis = new Redis()
    this.rand = Math.random()
  }

  async get(rt: Runtime, key: string): Promise<Buffer | null> {
    const buf = await this.redis.getBuffer(keyFor(rt, key))
    if (!buf)
      return null
    return Buffer.from(buf)
  }

  async set(rt: Runtime, key: string, value: any, options?: CacheSetOptions | number): Promise<boolean> {
    const k = keyFor(rt, key)
    const pipeline = this.redis.pipeline()
    let ttl: number | undefined
    if (typeof options === "number") {
      ttl = options
    } else if (options) {
      ttl = options.ttl
    }

    if (ttl && !isNaN(ttl)) {
      pipeline.set(k, value, 'EX', ttl)
    } else {
      pipeline.set(k, value)
    }

    if (typeof options !== "number" && options && options.tags instanceof Array) {
      pipeline.sadd(k + ":tags", ...options.tags)
      this.setTags(rt, key, options.tags, pipeline)
      if (ttl) {
        pipeline.expire(k + ":tags", ttl)
      }
    } else {
      pipeline.del(k + ":tags")
    }
    const result = await pipeline.exec()
    return pipelineResultOK(result)
  }

  async del(rt: Runtime, key: string): Promise<boolean> {
    const result = await this.redis.del(keyFor(rt, key))
    return result === OK
  }

  async expire(rt: Runtime, key: string, ttl: number): Promise<boolean> {
    return (await this.redis.expire(keyFor(rt, key), ttl)) === 1
  }

  async ttl(rt: Runtime, key: string): Promise<number> {
    return this.redis.ttl(keyFor(rt, key))
  }

  async setTags(rt: Runtime, key: string, tags: string[], pipeline?: IORedis.Pipeline): Promise<boolean> {
    const doSave = !pipeline
    if (!pipeline) {
      pipeline = this.redis.pipeline()
    }
    const k = keyFor(rt, key)
    for (let s of tags) {
      s = tagKeyFor(rt, s)
      pipeline.sadd(s, k)
    }
    if (doSave) {
      const result = await pipeline.exec()
      return pipelineResultOK(result)
    } else {
      return true
    }
  }

  async purgeTags(rt: Runtime, tags: string): Promise<string[]> {
    const s = tagKeyFor(rt, tags)
    const checks = this.redis.pipeline()
    const keysToDelete = new Array<string>()
    const keysToCheck = []
    for await (const k of setScanner(this.redis, s)) {
      keysToCheck.push(k)
    }

    for (const k of keysToCheck) {
      checks.sismember(k + ":tags", tags)
    }
    const result = await checks.exec()
    const deletes = this.redis.pipeline()
    for (let i = 0; i < result.length; i++) {
      const r = result[i]
      if (r[1]) {
        keysToDelete.push(keysToCheck[i])
      }
    }

    deletes.del(...keysToDelete)
    deletes.del(s)

    const r = await deletes.exec()
    return keysToDelete.map((k) => k.replace(/^cache:[^:]+:/, ''))
  }
}

if (Symbol && !Symbol.asyncIterator)
  (<any>Symbol).asyncIterator = Symbol.for("Symbol.asyncIterator");
async function* setScanner(redis: IORedis.Redis, key: string) {
  let cursor = 0
  do {
    const result = await redis.sscan(key, cursor)
    cursor = result[0]
    yield* (<string[]>result[1])
  } while (cursor > 0)
}

function tagKeyFor(rt: Runtime, tag: string) {
  return `tag:${rt.app.name}:${tag}`
}
function keyFor(rt: Runtime, key: string) {
  return `cache:${rt.app.name}:${key}`
}

function pipelineResultOK(result: any) {
  const errors = result.filter((r: any) => {
    if (r[0]) {
      return true
    }
    if (r[1] !== 'OK' || (typeof r[1] === 'number' && r[1] < 0))
      return false
  })
  return errors.length === 0
}