import { registerBridge } from '../'
import { ivm } from '../../'
import { transferInto } from '../../utils/buffer'

import log from "../../log"

import * as sharp from 'sharp'
import { Bridge } from '../bridge';
import { Runtime } from '../../runtime';

const potrace = require('potrace')

interface sharpImage extends sharp.SharpInstance {
  options: any
}

interface imageOperation {
  (...args: any[]): sharp.SharpInstance
}

const allowedOperations: Map<string, imageOperation> = new Map([
  ["resize", sharp.prototype.resize],
  ["crop", sharp.prototype.crop],
  ["embed", sharp.prototype.embed],
  ["background", sharp.prototype.background],
  ["withoutEnlargement", sharp.prototype.withoutEnlargement],
  ["withMetadata", sharp.prototype.withMetadata],

  ["overlayWith", sharp.prototype.overlayWith],
  ["negate", sharp.prototype.negate],
  ["max", sharp.prototype.max],
  ["extend", sharp.prototype.extend],
  ["flatten", sharp.prototype.flatten],

  // output
  ["png", sharp.prototype.png],
  ["webp", sharp.prototype.webp],
  ["jpeg", sharp.prototype.jpeg],

])

const metadataFields = [
  "format",
  "width",
  "height",
  "number",
  "space",
  "channels",
  "density",
  "hasProfile",
  "hasAlpha",
  "orientation"
]

interface Metadata {
  [key: string]: any
}
function extractMetadata(meta: any): any {
  const info: Metadata = {}
  for (const f of metadataFields) {
    info[f] = meta[f]
  }
  return info
}

registerBridge("fly.Image()", function imageConstructor(rt: Runtime, bridge: Bridge, data?: ivm.Reference<Buffer>, create?: any) {
  try {
    if (data && !(data instanceof ArrayBuffer)) {
      throw new Error("image data must be an ArrayBuffer")
    }
    const opts: any = {}
    if (create) {
      if (typeof create.background === "string") {
        //create.background = color.parse(create.background)
      }
      opts["create"] = create
    }
    const image = sharp(data && Buffer.from(data), opts)
    const ref = new ivm.Reference(image)
    return Promise.resolve(ref)
  } catch (e) {
    return Promise.reject(e)
  }
})

registerBridge('fly.Image.operation', function imageOperation(rt: Runtime, bridge: Bridge, ref: ivm.Reference<sharp.SharpInstance>, name: string, ...args: any[]) {
  try {
    const img = refToImage(ref)
    const operation = allowedOperations.get(name)

    if (!operation) {
      throw new Error("Invalid image operation: " + name)
    }
    const applyFn = () => operation.apply(img, args)

    for (let i = 0; i < args.length; i++) {
      const v = args[i]
      // replace image references with `toBuffer` promises
      if (v instanceof ivm.Reference) {
        const img = refToImage(v)
        args[i] = img.toBuffer()
      }
    }
    return new Promise((resolve, reject) => {
      // resolve any promise arguments
      Promise.all(args).then((args) => {
        for (let i = 0; i < args.length; i++) {
          const v = args[i]
          //and convert ArrayBuffers
          if (v instanceof ArrayBuffer) {
            args[i] = Buffer.from(v)
          }
        }
        operation.apply(img, args)
        resolve(ref)
      }).catch(reject)
    })
  } catch (err) {
    return Promise.reject(err)
  }
})

registerBridge('fly.Image.metadata', async function imageMetadata(rt: Runtime, bridge: Bridge, ref: ivm.Reference<sharp.SharpInstance>) {
  const img = ref.deref()
  const meta = await img.metadata()
  return new ivm.ExternalCopy(extractMetadata(meta)).copyInto({ release: true })
})

registerBridge('fly.Image.traceSVG', async function traceSVG(rt: Runtime, bridge: Bridge, ref: ivm.Reference<sharp.SharpInstance>, mode?: string) {
  const img = ref.deref()
  const buffer = await img.toBuffer()
  return new Promise<string>((resolve, reject) => {
    let defaults = {
      color: `lightgray`,
      optTolerance: 0.4,
      turdSize: 100,
      turnPolicy: potrace.Potrace.TURNPOLICY_MAJORITY,
    }

    const fn = mode == "posterize" ? potrace.posterize : potrace.trace

    fn(buffer, defaults, (err?: Error, result?: string) => {
      if (err) {
        reject(err.toString())
        return
      }
      if (!result) {
        reject("weird empty response")
        return
      }
      resolve(result)
    })
  })
})

registerBridge("fly.Image.toBuffer", function imageToBuffer(rt: Runtime, bridge: Bridge, ref: ivm.Reference<sharp.SharpInstance>, callback: ivm.Reference<Function>) {
  const img = refToImage(ref)
  if (!img) {
    callback.applyIgnored(null, ["ref must be a valid image instance"])
    return
  }

  img.toBuffer((err, d, metadata) => {
    if (err) {
      log.debug("sending error:", err)
      callback.applyIgnored(null, [err.toString()])
      return
    }
    const info = extractMetadata(metadata)
    callback.applyIgnored(null, [null, transferInto(d), new ivm.ExternalCopy(info).copyInto({ release: true })])
  })
})

function refToImage(ref: ivm.Reference<sharp.SharpInstance>) {
  const img = ref.deref()
  if (!img) {
    throw new Error("ref must be a valid image instance")
  }

  return img
}

