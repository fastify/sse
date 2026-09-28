'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const { Readable } = require('node:stream')
const Fastify = require('fastify')
const fastifySSE = require('../index.js')

async function buildApp (t, options = {}) {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  await app.register(fastifySSE, options)
  return app
}

function createErrorStream (message, code) {
  return new Readable({
    read () {
      const error = new Error(message)
      if (code) error.code = code
      this.destroy(error)
    }
  })
}

test('reports unexpected transform errors and ends the response', async (t) => {
  const app = await buildApp(t, {
    heartbeatInterval: 0,
    serializer () {
      throw new Error('serialization failed')
    }
  })
  const errorLog = t.mock.fn()

  app.get('/events', { sse: true }, async (request, reply) => {
    reply.log.error = errorLog
    await reply.sse.send(Readable.from([{ data: 'value' }]))
    reply.raw.end()
  })

  await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(errorLog.mock.callCount(), 1)
  assert.strictEqual(
    errorLog.mock.calls[0].arguments[1],
    'Unexpected error in SSE stream'
  )
})

test('reports expected readable stream errors and ends the response', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })
  const infoLog = t.mock.fn()

  app.get('/events', { sse: true }, async (request, reply) => {
    reply.log.info = infoLog
    await reply.sse.send(createErrorStream('client disconnected', 'EPIPE'))
    reply.raw.end()
  })

  await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(infoLog.mock.callCount(), 1)
  assert.strictEqual(
    infoLog.mock.calls[0].arguments[1],
    'SSE stream ended (client disconnected)'
  )
})
